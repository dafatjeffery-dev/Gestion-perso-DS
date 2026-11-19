# DS Finances — Architecture (lot 0)

> Statut : **validé** (lot 0). Les choix par défaut du § 12 sont retenus.

Sommaire

1. Pile technique
2. Organisation du code et séparation des couches
3. Conventions
4. Modèle de données
5. Règles transverses (couverture synthétique/détaillé, budgets, crédits, transferts, fonds)
6. Moteur de calcul
7. Persistance, transactions, journal, corbeille
8. Migrations et sauvegardes
9. Import standardisé (principes) et reprise de l'ancienne version
10. Interface : direction graphique, écrans, protection des saisies
11. Stratégie de tests
12. Points à valider

---

## 1. Pile technique

**Retenue : Tauri 2 + TypeScript + React + SQLite (rusqlite, SQLite embarqué).** La pile par défaut convient ; je ne propose pas d'alternative.

| Élément | Choix | Raison |
|---|---|---|
| Coquille | Tauri 2 (macOS, Apple Silicon et Intel) | application légère, fichiers locaux, aucun serveur |
| Interface | React 18 + TypeScript strict + Vite | écosystème de tests (Testing Library, Playwright) le plus mûr |
| Graphiques | SVG écrit à la main (composants React) | contrôle total du clic → détail, pas de bibliothèque qui recalcule ou arrondit à sa façon |
| Calculs décimaux | entiers (centimes) + `decimal.js` pour taux et amortissements | aucune erreur de virgule flottante sur les montants |
| Base | SQLite 3 via `rusqlite` (feature `bundled`) côté Rust | fichier unique, transactions, API de sauvegarde à chaud |
| Base en aperçu navigateur | `sql.js` (SQLite compilé en WebAssembly), persisté dans IndexedDB | **même schéma, mêmes migrations SQL, même code** que l'application |
| Excel | `exceljs` (licence MIT) | lecture et écriture `.xlsx` sans macro ni formule |
| Tests | Vitest (moteur, stockage), `cargo test` (Rust), Playwright (aperçu navigateur) | voir § 11 |

Le **moteur de calcul est en TypeScript** et s'exécute dans l'interface : un seul moteur sert l'application Mac, l'aperçu navigateur et les tests. Rust ne fait **aucun calcul financier** : il fournit le stockage (requêtes, transactions), les chemins de fichiers, les migrations et les sauvegardes.

Aucun appel réseau, avec une seule exception explicite : le bouton « Récupérer les taux EUR/CHF (BCE) », qui affiche avant l'appel le domaine contacté et n'envoie aucune donnée personnelle. La politique de sécurité (CSP) de la fenêtre interdit toute autre connexion.

---

## 2. Organisation du code et séparation des couches

```
ds-finances/
├── migrations/              0001_init.sql, 0002_….sql — partagées Rust / sql.js
├── src-tauri/               Rust : commandes db_query / db_apply, migrations, sauvegardes, chemins
├── src/
│   ├── domain/              types, énumérations (natures, devises…), règles de validation
│   ├── engine/              moteur de calcul PUR : aucune dépendance à l'interface ni à la base
│   ├── storage/             interface Repository + 2 adaptateurs (tauri, sqljs) + chargement du snapshot
│   ├── services/            cas d'usage : valident, produisent un « plan d'écriture » atomique + journal
│   ├── import/              définition UNIQUE du format, lecteurs CSV/XLSX, contrôles, doublons
│   ├── export/              export complet JSON, exports lisibles CSV/XLSX
│   └── ui/                  React : écrans, composants, graphiques — consomme engine + services
├── tests/                   engine/, storage/, import/, e2e/ (Playwright), fixtures fictives
└── docs/
```

Règles de dépendance (vérifiées par une règle ESLint `import/no-restricted-paths`) :

```
ui ──► services ──► storage
 │         │
 └──► engine ◄──┘        engine ──► domain uniquement
```

- **`engine`** reçoit un `Snapshot` (objets en mémoire : comptes, mouvements, récurrences…) et des paramètres (date du jour, périmètre, scénario). Il renvoie des résultats. Fonctions pures, déterministes, sans `Date.now()` interne.
- **Aucun calcul dans `ui`** : un composant n'additionne jamais deux montants. Tout chiffre affiché provient d'un `Figure` du moteur (§ 6.1).
- **`services`** est le seul point d'écriture. Chaque action utilisateur (« déplacer un total », « faire évoluer une récurrence », « valider un import »…) devient un plan d'écriture : liste d'instructions SQL paramétrées + entrées de journal, exécutée en **une seule transaction** par `db_apply`.
- Volumétrie d'un foyer : quelques dizaines de milliers de lignes sur 10 ans. Le snapshot complet tient en mémoire ; il est rechargé après chaque écriture validée (simple et sans incohérence de cache).

### Pont Tauri

Deux commandes Rust seulement pour les données :

- `db_query(sql, params) → rows` en lecture seule (connexion ouverte en `query_only`) ;
- `db_apply(plan) → résultat` : `BEGIN IMMEDIATE`, exécution des instructions, contrôle `PRAGMA foreign_key_check`, `COMMIT` ou `ROLLBACK` complet.

Plus les commandes système : `store_status`, `backup_now`, `list_backups`, `stage_restore` / `commit_restore`, `fresh_start`, `read_drafts` / `write_drafts`, `save_file` (après la boîte « Enregistrer sous » du greffon `tauri-plugin-dialog`).

L'adaptateur `sqljs` implémente la même interface. En aperçu navigateur, un bandeau permanent indique : « Aperçu navigateur — données stockées dans ce navigateur (IndexedDB), pas dans l'application Mac ». Les messages de stockage sont fournis par l'adaptateur lui‑même, qui ne peut donc pas annoncer un enregistrement sur le Mac.

---

## 3. Conventions

| Sujet | Convention |
|---|---|
| **Montants** | entiers en **unités mineures** (centimes / centimes de franc), colonne `*_minor INTEGER`. Jamais de flottant stocké. |
| **Signe** | mouvements et totaux **signés du point de vue du foyer** : positif = entrée d'argent, négatif = sortie. Budgets, objectifs de fonds et valeurs de biens sont des **grandeurs positives** ; le sens vient de la rubrique (revenu ou dépense). |
| Affichage du signe | listes d'opérations : signé (`−42,10 €`). Analyses (budget, anneau, entrées/sorties) : dépenses en valeur positive dans une colonne « Sorties ». Un remboursement de dépense réduit la dépense de sa rubrique. |
| **Devises** | `EUR` ou `CHF` (contrainte `CHECK`). Monnaie de consolidation du foyer : EUR. Un montant garde toujours sa devise d'origine ; la conversion est un calcul, jamais une écriture. |
| **Taux** | `eur_chf_e6` : nombre de CHF pour 1 EUR × 10⁶ (ex. 0,9412 → 941200). Un taux par date. |
| Taux applicable | réel : taux de la date de l'opération ; soldes consolidés : taux de la date de référence ; prévisions : taux d'hypothèse. « Taux d'une date » = dernier taux connu à cette date ou avant ; à défaut, premier taux postérieur **avec signalement** ; aucun taux → valeur consolidée absente (« taux manquant »), jamais zéro. |
| **Arrondis** | au centime, demi vers l'extérieur (0,005 → 0,01 ; −0,005 → −0,01). Conversion **ligne par ligne** puis somme : un sous‑total est toujours la somme exacte des lignes affichées. |
| **Dates** | dates civiles ISO `YYYY-MM-DD`, sans heure ni fuseau. Mois : `YYYY-MM`. Horodatages techniques (journal, sauvegardes) : ISO 8601 UTC. |
| **Fuseau** | « aujourd'hui » et les bornes de mois sont évalués en `Europe/Paris`. |
| Jour de récurrence | jour 29–31 absent d'un mois → dernier jour du mois. Pas de décalage automatique aux jours ouvrés. |
| **Statut d'un mois** | `futur`, `en cours` (contient aujourd'hui), `écoulé` (terminé, non clôturé), `clôturé` (écoulé + action « Clôturer le mois » de la routine mensuelle). |
| **Mois complet** | mois **clôturé**. Seuls les mois complets servent aux moyennes (« moyenne des 3 derniers mois complets »). S'il y en a moins que demandé, l'affichage dit « moyenne sur 2 mois complets ». |
| Mois incomplet | en cours : réel partiel + reste attendu estimé. Écoulé non clôturé : réel et écart marqués **provisoires**, le mois apparaît dans « À vérifier ». Clôturer ne verrouille rien, mais modifier un mois clôturé demande confirmation. |
| **Absence** | toute valeur calculée est `number \| null` ; `null` porte une raison (« aucun solde de référence », « taux manquant »…) et s'affiche « — » avec la raison au survol ou au clic. |
| Identifiants | entiers auto‑incrémentés internes ; références stables lisibles (`DEP.ALIM.COURSES`) pour les rubriques, utilisées par l'import. |

---

## 4. Modèle de données

Tableau des natures financières (énumération dans `domain`, contrainte `CHECK` en base) :

| Nature (`code`) | Compte dans… | Revenus / dépenses consolidés | Trésorerie | Patrimoine |
|---|---|---|---|---|
| Revenu ordinaire (`revenu_ordinaire`) | revenus **structurels** | + | + | |
| Revenu exceptionnel (`revenu_exceptionnel`) | revenus **exceptionnels** | + | + | |
| Dépense courante (`depense`) | dépenses | − | − | |
| Remboursement de dépense (`remboursement_depense`) | réduit la dépense de sa rubrique | + (en déduction) | + | |
| Transfert interne (`transfert`) | **neutre** | 0 | 0 en consolidé | |
| Emprunt reçu (`emprunt_recu`) | hors revenus | 0 | + | dette + |
| Remboursement de capital (`capital_credit`) | hors consommation | 0 | − | dette − |
| Intérêts, assurance, frais de crédit (`cout_credit`) | dépenses (famille Crédits) | − | − | |
| Épargne / investissement (`epargne`) | hors consommation | 0 | − (sort des liquidités) | investissements + |
| Frais de transfert (`frais_transfert`) | dépenses (famille Frais bancaires) | − | − | |
| À classer (`a_classer`) | dépenses ou revenus selon le signe, rubrique « À classer » | ± | ± | |

Le **sens bancaire** (signe) et la **nature** sont indépendants : un remboursement de dépense est positif, un emprunt reçu est positif sans être un revenu.

### 4.1 Foyer et référentiels

```sql
household (id = 1, name, base_currency 'EUR', forecast_horizon_months 24, ref_balance_max_age_days 35)
person    (id, role CHECK IN ('A','B'), display_name, birth_date NULL, retirement_date NULL)
setting   (key PRIMARY KEY, value_json)                       -- paramètres divers

account (
  id, name, institution,
  currency  CHECK IN ('EUR','CHF'),
  owner     CHECK IN ('A','B','commun'),
  type      CHECK IN ('courant','epargne','investissement'),
  tracking  CHECK IN ('detaille','synthetique'),               -- § 5.1
  status    CHECK IN ('actif','archive'), archived_at NULL,
  is_default_for_currency 0/1,                                 -- compte de repli pour budgets sans compte
  expected_return_class NULL,                                  -- investissements : classe de rendement
  sort_order
)
balance_reference (id, account_id → account, ref_date, amount_minor, source, note,
                   UNIQUE(account_id, ref_date))

family   (id, name, direction CHECK IN ('revenu','depense','technique'), visible, sort_order)
rubrique (id, family_id → family, name, ref UNIQUE,            -- ex. DEP.ALIM.COURSES
          available_for_entry 0/1, visible 0/1,                -- deux propriétés indépendantes
          is_system 0/1,                                       -- À classer, Écart de change, Intérêts…
          estimation_method CHECK IN ('budget','prorata','moyenne'), estimation_n,
          default_account_id NULL → account)

fx_rate (rate_date PRIMARY KEY, eur_chf_e6 INTEGER > 0, source CHECK IN ('manuel','csv','bce'), updated_at)
```

- **Liquidités** = comptes `courant` + `epargne`, actifs **ou archivés**. Archiver un compte ne change aucun total ; un compte archivé avec solde non nul est signalé dans « À vérifier ».
- Les crédits ne sont pas des comptes (pas de type « dette ») : ils ont leur propre entité (§ 4.5), ce qui évite de compter deux fois une dette.
- La « validité des engagements » n'est **pas** une propriété de la rubrique : elle appartient aux récurrences, échéances et crédits. Le moteur ne lit jamais `visible` ni `available_for_entry`.

### 4.2 Mouvements : une seule table pour le synthétique et le détaillé

```sql
movement (
  id,
  granularity CHECK IN ('operation','total'),
  account_id   NULL → account,      -- obligatoire pour une opération, interdit pour un total
  op_date      NULL,                -- opération : date d'opération
  value_date   NULL,
  period_month TEXT NOT NULL,       -- 'YYYY-MM' ; pour une opération = mois de op_date (trigger)
  amount_minor INTEGER NOT NULL,    -- signé
  currency     CHECK IN ('EUR','CHF'),
  nature       CHECK IN (…),
  rubrique_id  → rubrique NOT NULL,
  label_original NULL,              -- libellé bancaire, jamais réécrit après import
  label_simple   NULL,
  bank_id        NULL,              -- identifiant bancaire
  comment        NULL,
  classification CHECK IN ('a_verifier','confirme'),
  transfer_id    NULL → transfer,
  import_batch_id NULL → import_batch, import_row NULL,
  created_at, updated_at, deleted_at NULL,
  CHECK (granularity = 'operation' AND account_id IS NOT NULL AND op_date IS NOT NULL
      OR granularity = 'total'     AND account_id IS NULL     AND op_date IS NULL)
)
CREATE UNIQUE INDEX ux_movement_bank_id ON movement(account_id, bank_id)
  WHERE bank_id IS NOT NULL AND deleted_at IS NULL;
-- trigger : la devise d'une opération = devise de son compte
-- trigger : nature compatible avec la direction de la famille de la rubrique

coverage_decision (                -- § 5.1 : non double comptage
  id, rubrique_id → rubrique, period_month,
  mode CHECK IN ('total_remplace','detail_remplace','complement'),
  decided_at, UNIQUE(rubrique_id, period_month)
)
month_status (period_month PRIMARY KEY, closed_at, note)
```

Le fait qu'un total n'ait **jamais** de compte est garanti par la contrainte : un total synthétique ne peut structurellement pas modifier un solde bancaire, et il ne peut pas être transformé en opérations fictives.

### 4.3 Transferts

```sql
transfer (id, reference NULL)
-- chaque jambe porte movement.transfer_id + movement.transfer_role ('sortie','entree','frais'),
-- index unique (transfer_id, transfer_role) : exactement une sortie, une entrée, au plus un frais
```

Deux opérations liées, nature `transfert`, sur deux comptes. Les frais sont une **troisième opération** réelle (nature `frais_transfert`, rubrique « Frais de transfert »). L'écart de change est **calculé** (§ 5.5), pas stocké.

### 4.4 Engagements : récurrences, échéances ponctuelles, rapprochement

```sql
recurrence (
  id, label, nature, rubrique_id → rubrique, planned_account_id NULL → account,
  end_date NULL,                    -- NULL = sans fin connue ; « Arrêter » renseigne cette date
  created_at, deleted_at NULL
)
recurrence_version (
  id, recurrence_id → recurrence,
  valid_from, valid_to NULL,        -- versions contiguës, sans chevauchement (contrôle service + trigger)
  amount_minor (signé), currency,
  frequency CHECK IN ('mensuelle','trimestrielle','semestrielle','annuelle','personnalisee'),
  interval_months, day_of_month, months_mask NULL,   -- personnalisée : mois concernés (bitmask 12 bits)
  change_kind CHECK IN ('creation','evolution'), created_at
)
occurrence_override (recurrence_id, due_date, action CHECK IN ('annulee','montant','date'),
                     amount_minor NULL, new_date NULL, PRIMARY KEY(recurrence_id, due_date))

scheduled_item (                     -- échéance ponctuelle (facture attendue, paiement de projet…)
  id, label, due_date, amount_minor (signé), currency, nature, rubrique_id,
  planned_account_id NULL, fund_id NULL → fund, status CHECK IN ('prevue','annulee'), deleted_at NULL
)

reconciliation (                     -- un paiement solde SON échéance
  id, movement_id → movement,
  target_kind CHECK IN ('occurrence','echeance','credit'),
  recurrence_id NULL, occurrence_date NULL,   -- occurrence = (récurrence, date prévue)
  scheduled_item_id NULL,
  loan_id NULL, installment_seq NULL,
  allocated_minor,                   -- part du paiement affectée à cette cible
  closes_target 0/1                  -- « soldée avec écart » accepté par l'utilisateur
)
```

- Les **occurrences** de récurrences ne sont pas stockées : le moteur les génère depuis les versions. Elles sont identifiées par `(recurrence_id, date prévue)`, ce qui permet le rapprochement et les ajustements ponctuels (`occurrence_override`).
- **Corriger** = modifier la version concernée (tracé au journal). **Faire évoluer à partir d'une date** = fermer la version courante la veille et créer une nouvelle version. **Arrêter** = renseigner `end_date`.
- Contrôle : la somme des `allocated_minor` d'un mouvement ne dépasse pas sa valeur absolue ; une cible est soldée quand le montant affecté atteint le montant attendu, ou quand `closes_target = 1`.

### 4.5 Budgets

```sql
budget_plan  (id, rubrique_id, valid_from_month, valid_to_month NULL, monthly_minor ≥ 0, currency)
budget_month (id, rubrique_id, period_month, initial_minor ≥ 0, actualise_minor NULL,
              UNIQUE(rubrique_id, period_month))
```

Le plan évite de ressaisir chaque mois. Le budget **initial** d'un mois est figé dans `budget_month` à la première modification de ce mois ou à son ouverture ; le budget **actualisé** est une révision explicite. Sans ligne `budget_month`, le budget initial est celui du plan.

### 4.6 Crédits

```sql
loan (
  id, label, lender, currency,
  mode CHECK IN ('simplifie','bancaire','theorique'),
  principal_minor NULL, annual_rate_e6 NULL,          -- 1,85 % → 18500
  periods NULL, frequency CHECK IN ('mensuelle','trimestrielle','semestrielle','annuelle'),
  first_due_date,
  insurance_mode CHECK IN ('aucune','montant_fixe','pct_capital_initial','pct_crd'), insurance_value NULL,
  fees_per_installment_minor 0, fees_initial_minor 0,
  simple_installment_minor NULL, simple_crd_minor NULL, simple_crd_date NULL,   -- mode simplifié
  payment_account_id NULL → account, recurrence_id NULL → recurrence,
  status CHECK IN ('actif','archive','solde'), archived_at NULL
)
loan_installment (
  loan_id → loan, seq, due_date,
  principal_minor, interest_minor, insurance_minor, fees_minor, total_minor,
  crd_after_minor, origin CHECK IN ('banque','calcule','estime'),
  PRIMARY KEY (loan_id, seq),
  CHECK (total_minor = principal_minor + interest_minor + insurance_minor + fees_minor)
)
```

- **Bancaire** : échéancier saisi ou collé, conservé tel quel (`origin = 'banque'`), y compris s'il contient des arrondis atypiques ; seule la cohérence `total = somme des composants` est exigée.
- **Théorique** : l'échéancier est calculé par le moteur et enregistré avec la fiche (`origin = 'calcule'`).
- **Simplifié** : mensualité et capital restant dû à une date, taux facultatif (voir § 12, question 2).
- Les associations `payment_account_id` et `recurrence_id` ne sont écrites qu'à l'**enregistrement de la fiche** (le formulaire travaille sur un brouillon en mémoire).
- **Archiver** ne supprime rien. **Réactiver** remet `status = 'actif'` ; les rapprochements existants restent en place, aucune opération n'est recréée (les paiements passés sont des mouvements, pas des produits de l'échéancier).

### 4.7 Réserve, fonds et projets

```sql
fund (id, kind CHECK IN ('reserve','projet'), name, target_minor NULL, currency, target_date NULL,
      status CHECK IN ('actif','termine','archive'))
CREATE UNIQUE INDEX ux_single_reserve ON fund(kind) WHERE kind = 'reserve';

fund_allocation  (id, fund_id, alloc_date, amount_minor, note)  -- + affecter / − libérer (réalisé)
fund_plan        (id, fund_id, amount_minor, frequency, start_date, end_date NULL)  -- versements prévus
fund_consumption (id, fund_id, movement_id → movement, amount_minor)                -- paiement du projet
```

Les paiements prévus d'un projet sont des `scheduled_item` portant `fund_id`.

### 4.8 Patrimoine et scénarios

```sql
asset (id, kind CHECK IN ('immobilier','autre'), name, currency, ownership_pct_e2 DEFAULT 10000, status)
asset_valuation (asset_id, valuation_date, value_minor, source, PRIMARY KEY(asset_id, valuation_date))
scenario (id, kind CHECK IN ('prudent','central','favorable'), params_json)
-- params : inflation, rendement par classe d'investissement, évolution immobilière,
--          EUR/CHF annuel, évolution des revenus ; taux d'hypothèse court terme pour la prévision
```

Les investissements sont des comptes de type `investissement` dont le « solde de référence » est la **valeur déclarée datée**.

### 4.9 Import, journal

```sql
import_batch (id, imported_at, file_name, file_sha256, file_kind CHECK IN ('csv','xlsx'),
              format_version, account_ids_json, period_from, period_to,
              rows_total, rows_imported, rows_excluded, rows_flagged,
              status CHECK IN ('integre','annule'), cancelled_at NULL)
import_row   (batch_id, row_no, outcome CHECK IN ('importee','exclue','signalee'),
              reason NULL, movement_id NULL, raw_json)       -- provenance de chaque ligne

audit_log (id, ts, actor, action_group, entity, entity_id,
           action CHECK IN ('create','update','delete','restore','move'),
           before_json NULL, after_json NULL)
```

- `actor` : application locale mono‑utilisateur, donc `utilisateur`, `import:<id>` ou `systeme` (sauvegarde, migration). L'action groupe (`action_group`) relie toutes les lignes d'une même action (ex. un déplacement de total = 1 groupe).
- Journalisés : mouvements, totaux, décisions de couverture, budgets, récurrences et versions, échéances, rapprochements, crédits et échéanciers, fonds, taux.

### 4.10 Hors base

- **Brouillons de formulaires** : fichier `drafts.json` à côté de la base (application) ou `localStorage` (aperçu). Ils ne sont jamais lus par le moteur ni inclus dans les totaux.
- **Manifestes des sauvegardes** : un fichier `.json` à côté de chaque copie `.sqlite` (une sauvegarde ne peut pas se décrire elle‑même dans la base qu'elle copie). La liste des sauvegardes est reconstituée à partir des manifestes.

---

## 5. Règles transverses

### 5.1 Synthétique et détaillé : un seul système

- Un **compte** est suivi en mode `detaille` (opérations rattachées, solde reconstitué) ou `synthetique` (seuls les soldes de référence sont saisis régulièrement).
- Une **rubrique × mois** peut recevoir des opérations (détail) et/ou un total (synthétique). Tous sont des lignes de `movement`.
- **Solde d'un compte à une date d** = dernier solde de référence ≤ d + somme des opérations du compte de date > date de référence et ≤ d. Les totaux n'ont pas de compte : ils n'entrent jamais dans un solde. À la saisie d'un total, une ligne courte rappelle : « Ce total n'est rattaché à aucun compte : il n'agit pas sur les soldes. »
- **Couverture** : pour une rubrique et un mois où coexistent opérations et total, une `coverage_decision` est **obligatoire**. Elle est demandée au moment de l'écriture qui crée la coexistence (saisie d'un total, déplacement, import) ; l'écriture n'est pas exécutée sans réponse. Valeur retenue pour l'analyse :

  | Mode | Montant analysé pour la rubrique et le mois |
  |---|---|
  | `total_remplace` | le total ; les opérations restent dans les comptes et les soldes, mais sont exclues de l'analyse de cette rubrique |
  | `detail_remplace` | la somme des opérations ; le total est conservé, marqué « remplacé » |
  | `complement` | opérations + total, le total étant libellé « complément non détaillé » |

  Le moteur vérifie à chaque calcul qu'aucune coexistence n'est sans décision ; s'il en trouve une (base modifiée à l'extérieur, ancienne sauvegarde), la cellule affiche « conflit à résoudre » au lieu d'un montant et l'élément remonte dans « À vérifier ».

- **Modifier / Déplacer / Dupliquer un total** : trois actions distinctes du service. *Déplacer* change `period_month` dans une transaction unique tracée en un groupe du journal ; si la destination contient déjà un total ou des opérations de la même rubrique, l'application explique la situation et propose : fusionner (somme explicite), remplacer (l'ancien total va à la corbeille), annuler, ou choisir le mode de couverture. Chaque action peut être annulée depuis le journal (« Annuler cette action » rejoue l'état `before_json` du groupe, si les lignes n'ont pas été modifiées entre‑temps).

### 5.2 Annuel, lissage et calendrier

Pour une récurrence ou une échéance non mensuelle, le moteur produit trois valeurs distinctes, **jamais additionnées** :

- **Montant annuel** : somme des occurrences sur 12 mois (information de la fiche) ;
- **Repère lissé** : montant annuel / 12, colonne facultative « Repère lissé » du suivi mensuel, sans effet sur le prévu, le reste attendu ni la trésorerie ;
- **Calendrier** : chaque occurrence dans son mois réel ; c'est la **seule** valeur utilisée par le prévu, le reste attendu et la prévision de trésorerie.

### 5.3 Budgets et échéances (règle unique)

Pour une rubrique *r* et un mois *m* (dépenses, en valeur positive ; règle symétrique pour les revenus) :

- **B** = budget de référence = budget actualisé s'il existe, sinon initial ; absent si aucun budget.
- **E** = somme des montants attendus des échéances identifiées (occurrences de récurrences, échéances ponctuelles, échéances de crédit rattachées à *r*) dont la date tombe en *m*.
- Les échéances sont **incluses dans le budget**. Enveloppe libre **L** = max(0, B − E). Si B < E, l'écart est signalé (« Budget 300 € inférieur aux échéances identifiées 420 € ») et le prévu retenu est E — c'est une règle affichée, pas un maximum silencieux.
- **Prévu** = E + L (si pas de budget : E).
- **Réel** = montant analysé selon § 5.1. **Réel rapproché** = part du réel affectée à des échéances de *r* ; **réel non rapproché** R_nr = Réel − réel rapproché.
- **Échéances non soldées** U = Σ max(0, attendu − affecté) sur les échéances non clôturées.
- **Reste attendu** (mois en cours ou futur) = max(0, L − R_nr) + U. Mois écoulé : reste attendu = 0 ; les échéances non soldées deviennent « en retard » (§ 5.6).
- **Écart** = (Réel + Reste attendu) − B pour un mois en cours (écart *projeté*), Réel − B pour un mois écoulé ; la référence (« budget actualisé du 12/03 ») est affichée à côté.

Exemple : B = 500, une échéance de 200. Rien de payé → reste 300 + 200 = 500. Échéance payée 230 (écart accepté) + 50 d'autres dépenses → R_nr = 50, U = 0, reste = 250, écart projeté = 230 + 50 + 250 − 500 = +30.

**Rapprochement individuel** : un paiement est affecté explicitement à **une** échéance (proposition automatique : même rubrique, même compte, montant ±10 %, date ±10 jours ; l'utilisateur confirme). Un paiement de la même rubrique non rapproché réduit l'enveloppe libre, jamais une échéance. Paiement partiel : l'échéance reste ouverte pour le solde. Écart de montant : l'utilisateur choisit « solder avec écart » (`closes_target`) ou « laisser ouvert ».

**Dépenses variables non détaillées** (mois en cours) : estimation du reste selon la méthode de la rubrique, affichée à côté du chiffre :
- `budget` : max(0, L − R_nr) (par défaut) ;
- `prorata` : max(0, R_nr × jours du mois / jours écoulés − R_nr) ;
- `moyenne` : max(0, moyenne des N derniers mois complets − R_nr).

### 5.4 Crédits

- **Calcul théorique** : taux périodique proportionnel (taux annuel nominal / nombre de périodes par an), échéance constante hors assurance ; intérêts = arrondi(CRD × taux périodique) ; capital = échéance − intérêts ; **dernière échéance** = CRD restant + intérêts (ajustement d'arrondi). Assurance selon le mode ; frais fixes par échéance ; frais initiaux en échéance n° 0. Limites affichées sur la fiche : pas de différé, pas de taux variable, pas de remboursement anticipé, pas de calcul actuariel au jour près ; « l'échéancier de votre banque fait foi ».
- **Trésorerie** : l'échéance totale sort du compte de paiement.
- **Analyse** : les intérêts, l'assurance et les frais vont dans les rubriques système de la famille Crédits (nature `cout_credit`) ; le capital (nature `capital_credit`) apparaît dans « Sorties de trésorerie » mais jamais dans les dépenses de consommation.
- **Une seule source par échéance** : si le crédit est associé à une récurrence, les occurrences de cette récurrence sont **remplacées** par les échéances du crédit (la récurrence est affichée « portée par le crédit X »). Le paiement réel, rapproché de l'échéance, est **ventilé par le moteur** selon les composants de l'échéance ; non rapproché, il apparaît dans « Crédits › Échéance non ventilée » et dans « À vérifier ».
- **CRD** au jour J : `crd_after_minor` de la dernière échéance échue (bancaire, théorique) ou CRD déclaré diminué du capital des échéances suivantes (simplifié). Alimente le patrimoine net.

### 5.5 Transferts et change

- Les deux jambes d'un transfert ont la nature `transfert` : neutres dans les revenus et dépenses.
- Transfert EUR → CHF : en consolidé EUR, sortie −1 000,00 € et entrée +935,00 CHF convertie au taux du jour (0,9412 → 993,41 €). L'**écart de change** −6,59 € est une ligne dérivée, rubrique système « Écart de change » (nature `frais_transfert`), rattachée au transfert : on la retrouve famille → rubrique → transfert. Elle varie si le taux de ce jour est corrigé, ce qui est signalé.
- Les frais facturés sont une opération distincte, rubrique « Frais de transfert ».

### 5.6 Fonds, réserve et indicateurs de situation

- **Liquidités totales** (EUR) = Σ soldes des comptes courant + épargne, chacun converti au taux de sa date de référence.
- **Réservé** = montant affecté à la réserve + Σ (affectations − consommations) des fonds.
- **Non affecté** = Liquidités totales − Réservé (peut être négatif ; il est alors signalé).
- Un paiement de projet est une dépense normale de sa rubrique **et** une `fund_consumption` : il diminue les liquidités et le réservé du même montant, donc le non affecté ne bouge pas (pas de double comptage).

### 5.7 Prévision de trésorerie

Pour chaque compte liquide, mois par mois jusqu'à l'horizon (24 mois par défaut) :

```
solde fin de mois prévu = solde reconstitué à la date de référence (§ 5.1)
  + opérations réelles postérieures à la date de référence
  + flux attendus postérieurs à la date de référence, non rapprochés :
      occurrences de récurrences, échéances ponctuelles, échéances de crédits,
      restes attendus des budgets (mois en cours) et prévus des budgets (mois futurs),
      versements et paiements prévus des projets
```

- Compte **détaillé** : un flux attendu échu et non rapproché est reporté à aujourd'hui (« en retard », listé dans « À vérifier »), compté une fois.
- Compte **synthétique** : les flux attendus entre la date de référence et aujourd'hui sont supposés réalisés comme prévu ; la carte du compte indique « solde estimé depuis le relevé du 02/10 ».
- Flux sans compte prévu (budgets) : compte par défaut de la rubrique, sinon compte par défaut de la devise.
- Conversion au **taux d'hypothèse** affiché sur le graphique.
- Si un solde de référence a plus de 35 jours (paramétrable), la prévision l'indique.

Indicateurs :
- **Minimum des soldes prévus en fin de mois** = min sur l'horizon des liquidités totales prévues en fin de mois, avec le mois concerné.
- **Marge après réserve et fonds** = min sur l'horizon de (liquidités prévues − réservé prévu) en fin de mois, avec le mois concerné.

### 5.8 Patrimoine et projection

- **Patrimoine net** = liquidités + investissements (dernière valeur déclarée) + biens immobiliers (dernière valeur déclarée × quote‑part) − capital restant dû. Chaque composant porte sa date.
- **Projection** annuelle jusqu'à la dernière date de retraite du foyer, pour les 3 scénarios. Flux annuel structurel = revenus ordinaires − dépenses prévues (récurrences + budgets, hors exceptionnels), indexés selon le scénario ; rendements appliqués aux investissements ; CRD selon les échéanciers. Affichage : fourchette prudent–favorable avec le central en trait, montants arrondis au millier, en euros constants (bascule euros courants).

---

## 6. Moteur de calcul

### 6.1 Chiffres explicables

Tout résultat est un `Figure` :

```ts
type Figure = {
  key: string;                 // 'liquidites_totales', 'suivi.DEP.ALIM.COURSES.2026-11.reste'
  label: string;               // libellé exact affiché, ex. « Liquidités totales »
  definition: string;          // une phrase, reprise de REGLES_DE_CALCUL.md
  value: Money | null;         // null = absence
  missingReason?: string;
  components: Figure[];        // composition : la somme des composants = value (vérifié en test)
  sources?: SourceRef[];       // mouvements, échéances, soldes de référence concernés
  notes?: string[];            // « taux du 14/11 », « mois non clôturé »…
};
```

Le clic sur une valeur ouvre un panneau qui affiche `definition`, `components` (récursivement) et les `sources`. Le même objet alimente cartes, tableaux et graphiques.

### 6.2 Fonctions principales

| Fonction | Résultat |
|---|---|
| `accountBalance(snapshot, accountId, date)` | solde reconstitué + date de référence + ancienneté |
| `situation(snapshot, today)` | liquidités, réservé, non affecté, réserve |
| `occurrences(snapshot, from, to)` | occurrences de récurrences + échéances + échéances de crédit, avec état de rapprochement |
| `monthlyTracking(snapshot, month, scope)` | grille Prévu / Réel / Reste attendu / Écart par famille et rubrique |
| `analysis(snapshot, period, filters)` | répartition, entrées/sorties, budget/réel |
| `forecast(snapshot, today, horizon, fxHypothesis)` | soldes prévus par compte et consolidés, minimum, marge |
| `amortize(loanParams)` | échéancier théorique |
| `netWorth(snapshot, date)` / `projection(snapshot, scenarios)` | patrimoine et fourchettes |
| `checks(snapshot, today)` | éléments « À vérifier » |

### 6.3 Périmètres et comparabilité

- Le périmètre d'analyse (foyer, personne, compte) est un paramètre du moteur. Si le périmètre est un compte ou une personne, les budgets (familiaux) et les totaux synthétiques (sans compte) sont **exclus** et la colonne budget affiche « Budget familial (référence, non comparable) » à part.
- Une seule période d'analyse s'applique à tous les éléments. Si une donnée ne couvre pas toute la période (ex. historique commencé en mars), la période est annoncée telle quelle et les sélections impossibles sont désactivées.

---

## 7. Persistance, transactions, journal, corbeille

- Base : `~/Library/Application Support/fr.dsfinances.app/ds-finances.sqlite`, `PRAGMA journal_mode = WAL`, `foreign_keys = ON`, `synchronous = FULL`.
- Toute écriture passe par un plan `db_apply` → une transaction. Les entrées de journal font partie du plan : pas d'écriture sans trace.
- **Suppression** : le service calcule d'abord les dépendances (rapprochements, transferts, consommations de fonds, décisions de couverture) et les présente avec leur traitement proposé. Les mouvements, totaux, récurrences, échéances, crédits et fonds vont à la **corbeille** (`deleted_at`) ; restauration depuis la corbeille ; vidage explicite. Les éléments en corbeille sont exclus de tous les calculs.
- L'emplacement réel de la base est affiché dans Paramètres › Sauvegardes (bouton « Afficher dans le Finder »).

---

## 8. Migrations et sauvegardes

### 8.1 Migrations

- Fichiers SQL numérotés `migrations/NNNN_nom.sql`, embarqués dans le binaire (Rust `include_str!`) et dans l'aperçu (import Vite). Table `schema_migrations(version, name, checksum, applied_at)` + `PRAGMA user_version`.
- Au démarrage : si des migrations sont en attente → **sauvegarde « avant migration »** → chaque migration dans sa transaction → `integrity_check` et `foreign_key_check`. Échec → rollback, la base n'est pas modifiée et la sauvegarde est signalée.
- Migrations uniquement en avant ; une base plus récente que l'application est ouverte en lecture seule avec un message.
- Une migration modifiée après publication est détectée par sa somme de contrôle (refus de démarrer).

### 8.2 Sauvegardes

- Copie à chaud via l'API SQLite *online backup* dans `…/fr.dsfinances.app/backups/` (dossier modifiable, par exemple un dossier synchronisé choisi par l'utilisateur ; l'application ne gère pas de synchronisation).
- Chaque sauvegarde = `ds-finances-AAAAMMJJ-HHMMSS-<motif>.sqlite` + manifeste JSON (version de schéma, version de l'application, motif, nombre de lignes par table, SHA‑256). Vérification après écriture : ouverture en lecture seule, `integrity_check`, comparaison du manifeste.
- Déclencheurs : démarrage ; avant migration, restauration ou « nouveau départ » ; après modifications validées au plus toutes les 10 minutes ; à la fermeture si des changements ont eu lieu depuis la dernière.
- Rotation : 10 plus récentes + 1 par jour sur 14 jours + 1 par semaine sur 8 semaines + 1 par mois sur 12 mois. Les sauvegardes « avant migration/restauration » sont conservées 90 jours.
- Paramètres affiche la date de la dernière sauvegarde, son motif et son dossier.

### 8.3 Restauration

1. Copie de la sauvegarde choisie dans un dossier temporaire isolé ; `integrity_check` ; migration de la copie si son schéma est plus ancien.
2. Résumé avant confirmation (date, nombre d'opérations, de lots d'import, dernière modification).
3. Sauvegarde « avant restauration » de l'état courant.
4. Fermeture de la connexion, remplacement atomique du fichier (renommage), réouverture, rechargement.

En aperçu navigateur, sauvegarder = télécharger le fichier, restaurer = charger un fichier.

### 8.4 Exports

- **Export complet** : JSON `{ "format": "ds-finances-export", "version": 1, "schema_version": N, "exported_at", "tables": { … } }`, toutes les tables sauf brouillons. Réimportable dans une base vide (« nouveau départ »).
- **Exports lisibles** CSV/XLSX : opérations, totaux, budgets, crédits et échéanciers. Contenu exact et omissions documentés dans `docs/GUIDE_UTILISATEUR.md` (ex. les lignes dérivées « écart de change » ne figurent pas dans l'export des opérations, puisque ce ne sont pas des opérations).

---

## 9. Import standardisé et reprise de l'ancienne version

### 9.1 Import de relevés (lot 6, principes fixés dès maintenant)

- `src/import/format.ts` est **l'unique définition** du format : liste ordonnée des colonnes (nom affiché, clé, obligatoire, type, règles), version (`1.0`). Le générateur de modèle (XLSX + CSV), le lecteur, les contrôles, la notice affichée et les consignes pour l'IA en dérivent.
- CSV : UTF‑8 avec BOM, séparateur `;`, sans ligne de commentaire.
- Montants acceptés : `-1234.56`, `-1234,56`, `-1 234,56` (espace, espace insécable ou fine), `-1'234.56` (format suisse). Au plus 2 décimales ; tout autre motif (`1.234`, `1,234`, deux séparateurs décimaux) est **refusé** comme ambigu. Dates : `AAAA-MM-JJ`, `JJ/MM/AAAA` ou cellule date Excel ; année à 2 chiffres refusée.
- Pipeline : lecture → structure et version → lignes → correspondances → doublons et conflits → récapitulatif → confirmation. Le résultat de chaque étape est un rapport (erreurs bloquantes / avertissements, avec fichier, feuille, ligne, colonne, valeur, raison, correction attendue). **Aucune écriture tant qu'il reste une erreur bloquante** ; le lot validé est écrit en une transaction (lot + lignes + mouvements + décisions de couverture + journal).
- Doublons : identifiant bancaire dans le compte → doublon certain ; sinon appariement **par multiensemble** sur (compte, date, montant, libellé original normalisé) — 2 lignes identiques dans le fichier face à 2 en base = 2 doublons certains ; 3 face à 2 = 2 doublons + 1 nouvelle — puis ressemblance (même compte et montant, date ±3 jours, libellé proche) → doublon possible, décision demandée.
- Annulation d'un lot : liste des opérations du lot et de leurs dépendances (modifiées depuis l'import d'après le journal, rapprochées, liées à un transfert, un fonds, un crédit, une décision de couverture) ; choix par groupe « supprimer » ou « conserver hors lot » ; aucune donnée indépendante supprimée.

### 9.2 Reprise des données de l'ancienne version

Prévue, non développée : une interface `LegacyImporter` lira un export de l'ancienne application vers une **base temporaire**, produira un rapport de correspondance (comptes, rubriques, natures, montants totaux par mois comparés), puis écrira en une transaction après confirmation. J'attends un exemple de fichier d'export pour écrire la correspondance.

---

## 10. Interface

### 10.1 Direction graphique

Maquette unique : [`docs/maquette/vue-ensemble.html`](maquette/vue-ensemble.html) (données fictives, à ouvrir dans un navigateur).

- Sobre : fond papier clair, texte encre, **une seule couleur d'accent** (bleu pétrole) pour les actions et la courbe principale ; rouge brique réservé aux alertes et aux soldes négatifs ; vert seulement pour « soldé ».
- Typographie système macOS (SF Pro), **chiffres tabulaires** alignés à droite, devise toujours écrite (`€`, `CHF`).
- Navigation latérale fixe, 9 entrées ; pas d'onglets imbriqués.
- Mode sombre suivant macOS.
- Absence = « — » en gris avec raison au survol ; jamais de `0` de remplacement.
- Panneau latéral « Détail » commun à tous les chiffres cliquables (définition + composition + sources).

### 10.2 Vue d'ensemble

Deux zones visuellement séparées :

1. **Situation et prévision** (date du jour, périmètre foyer, taux de référence) : Situation actuelle (liquidités, non affecté, réserve, avec dates de référence) puis Perspectives (courbe, minimum des soldes prévus, marge après réserve et fonds).
2. **Analyse de la période** (pilotée par la barre de filtres compacte : période, périmètre ; options secondaires dépliables) : budget/réel, anneau de répartition (dénominateur écrit sous l'anneau), entrées/sorties.

Puis « À vérifier » (5 éléments + « Voir tout ») et projets.

### 10.3 Protection des saisies

- Chaque formulaire travaille sur un brouillon en mémoire, recopié dans `drafts.json` toutes les 2 s tant qu'il diffère de l'état enregistré.
- Quitter un formulaire modifié (navigation, fermeture de la fenêtre, touche Échap) → boîte « Enregistrer / Abandonner / Rester ».
- À la réouverture, un brouillon existant est proposé avec le bandeau « Brouillon non enregistré du 19/11 à 14:32 » ; il n'apparaît dans aucun total ni liste.
- Enregistrement = un seul appel `db_apply` ; en cas d'échec, le brouillon reste intact.

---

## 11. Stratégie de tests

| Niveau | Outil | Ce que cela prouve | Ce que cela ne prouve pas |
|---|---|---|---|
| Moteur | Vitest, snapshots construits en mémoire | règles de calcul (§ 5), invariants (somme des composants) | stockage, interface |
| Stockage | Vitest + sql.js en Node, base temporaire | migrations, contraintes, triggers, transactions, plans d'écriture des services | comportement de rusqlite |
| Rust | `cargo test`, fichiers temporaires | migrations réelles, sauvegarde, rotation, restauration, rollback | interface |
| Interface | Vitest + Playwright (Chromium) sur l'aperçu navigateur construit (`npm run test:e2e`) | parcours, protection des saisies, clic → détail | **l'application Mac** |
| Application Mac | liste de vérifications manuelles fournie à chaque lot | — | — |

- Invariant automatique sur chaque `Figure` produit en test : `value = Σ components` lorsque des composants existent.
- Amortissement : valeurs de référence calculées séparément (tableur, formule fermée) et recopiées dans le test avec leur méthode de calcul en commentaire.
- Données exclusivement fictives (`tests/fixtures/foyer-fictif.ts`).
- Les 14 cas minimaux du cahier des charges sont chacun rattachés à un ou plusieurs tests nommés `cas-NN-…`.

Limite connue : Tauri ne fournit pas de pilote WebDriver sur macOS. Les tests automatisés de l'interface tournent donc sur l'aperçu navigateur ; ils ne seront jamais présentés comme une validation de l'application Mac. De plus, mon environnement de travail est Linux : je peux compiler et tester le Rust et l'aperçu, mais **la compilation et l'exécution de l'application Mac devront être vérifiées sur votre Mac** (`npm run tauri build`).

---

## 12. Points à valider

Choix que j'ai faits par défaut ; dites‑moi si l'un d'eux ne convient pas.

1. **React** plutôt que Svelte.
2. **Crédit en mode simplifié** : mensualité + capital restant dû à une date + taux **facultatif**. Avec taux, la ventilation intérêts/capital est estimée (`origin = 'estime'`) ; sans taux, chaque échéance va dans « Crédits › Échéance non ventilée » et le capital restant dû ne baisse qu'avec vos mises à jour. Acceptable ?
3. **Clôture du mois** : action explicite « Clôturer le mois » dans la routine mensuelle, qui sert de définition du « mois complet ». Alternative : considérer tout mois écoulé comme complet (plus simple, moins sûr).
4. **Écart de change** des transferts EUR↔CHF calculé automatiquement par rapport au taux de référence du jour et classé en dépense « Écart de change ». Alternative : ne l'afficher que si vous le demandez transfert par transfert.
5. **Budgets en EUR** par défaut (une rubrique peut avoir un budget en CHF si besoin).
6. **Pas de type de compte « dette »** : toutes les dettes sont des Crédits, pour éviter qu'une même dette soit comptée deux fois.
7. **Dossier de sauvegarde** par défaut dans `Application Support`, modifiable.
8. **Monnaie de consolidation EUR** pour tous les indicateurs du foyer (les vues par compte restent dans la devise du compte).

Après validation : lot 1 (socle, base, migrations, sauvegardes, journal, référentiels).
