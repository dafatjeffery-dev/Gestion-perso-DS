# DS Finances — Règles de calcul

Chaque indicateur affiché : définition, formule, exemple chiffré fictif. Le code de référence est indiqué entre crochets ; les tests correspondants sont dans `tests/engine/`.

Conventions générales (voir aussi `ARCHITECTURE.md` § 3) :

- montants en centimes entiers ; arrondi au centime, demi vers l'extérieur ;
- conversion **ligne par ligne**, puis somme : un sous-total est toujours la somme exacte des lignes affichées ;
- taux EUR/CHF : nombre de CHF pour 1 € ; « taux d'une date » = dernier taux connu à cette date ou avant (à défaut, premier taux postérieur, signalé) ;
- une valeur absente s'affiche « — » avec sa raison, jamais 0.

---

## 1. Soldes

### Solde d'un compte [engine/balances.ts `accountBalance`]

**Définition.** Solde reconstitué à une date J à partir du dernier solde de référence daté au plus tard J.

**Formule.** `solde(J) = solde de référence (date R ≤ J) + Σ opérations du compte datées entre R exclu et J inclus`.

Un solde de référence daté R est le solde **en fin de journée R** : les opérations datées R ou avant y sont déjà incluses. Les totaux mensuels (sans compte) n'entrent jamais dans un solde.

**Exemple.** Référence 3 000,00 € au 31/10. Opérations : −10,00 € le 31/10 (déjà incluse), −25,00 € le 02/11, −7,00 € le 25/11. Solde au 19/11 = 3 000,00 − 25,00 = **2 975,00 €** ; au 01/12 = **2 968,00 €**. Au 01/10 : **—** (« aucun solde de référence au 01/10/2026 ou avant »).

**Ancienneté.** Le solde de référence est signalé « ancien » au-delà de 35 jours (paramètre du foyer).

### Liquidités totales [`liquidities`]

**Définition.** Somme des soldes des comptes courants et d'épargne, **actifs et archivés**, en euros.

**Formule.** `Σ solde(compte) converti au taux de la date de son solde de référence`.

**Exemple.** Courant 3 000,00 € ; Courant CHF 5 120,00 CHF (référence au 31/10, taux du 31/10 : 0,9412 → 5 439,86 €) ; Livret A 22 950,00 €. Liquidités = **31 389,86 €**. Archiver le Livret A ne change pas ce total. Un compte sans aucun solde de référence rend le total **absent** (avec le nom du compte en cause), plutôt que de le compter pour zéro.

---

## 2. Réel : synthétique et détaillé [engine/lines.ts `realLines`]

Opérations (rattachées à un compte) et totaux mensuels (sans compte) sont des lignes de la même table. Pour une rubrique et un mois :

| Contenu | Réel retenu |
|---|---|
| seulement des opérations | somme des opérations |
| seulement un (des) total(aux) | somme des totaux |
| les deux, décision « le total remplace » | totaux ; les opérations restent dans les soldes des comptes |
| les deux, décision « le détail remplace » | opérations ; le total est conservé, marqué remplacé |
| les deux, décision « complément » | opérations + totaux (le total = « complément non détaillé ») |
| les deux, **sans décision** | **aucun montant** (« conflit à résoudre »), signalé dans « À vérifier » |

**Exemple.** Courses de novembre : une opération de −40,00 € et un total de −300,00 €. Total remplace → 300,00 € ; détail remplace → 40,00 € ; complément → 340,00 €. Le solde du compte ne bouge que de −40,00 €, dans les trois cas.

**Conversion d'un total** : au taux du dernier jour du mois (ou d'aujourd'hui pour le mois en cours).

---

## 3. Transferts et change [`fxDiffLines`]

Les deux jambes d'un transfert ont la nature « transfert interne » : elles sont **exclues** des revenus et des dépenses. Les frais facturés sont une opération distincte (rubrique « Frais de transfert »).

**Écart de change** = somme, en euros, des deux jambes (chacune convertie au taux de sa date). Ligne calculée, rubrique « Écart de change », rattachée au transfert.

**Exemple.** Le 18/11, 1 000,00 € débités, 935,00 CHF crédités, frais 7,50 €, taux 0,9412. Jambe crédit = 935,00 / 0,9412 = 993,41 €. Écart de change = 993,41 − 1 000,00 = **−6,59 €**. Dépenses de consommation du mois : frais −7,50 € + écart −6,59 € = **−14,09 €**, visibles dans la famille « Frais bancaires », ses deux rubriques et, au clic, le transfert lui-même.

---

## 4. Échéances attendues [engine/occurrences.ts]

- **Occurrences** générées depuis les versions des récurrences : mensuelle (tous les *n* mois), trimestrielle, semestrielle, annuelle, personnalisée (mois cochés). Le rythme est ancré sur le mois de début de la première version. Jour 29–31 absent → dernier jour du mois.
- **Corriger** modifie une version (passé compris) ; **faire évoluer** clôt la version la veille de la date et en ouvre une nouvelle ; **arrêter** fixe la date de fin. Une récurrence sans date de fin reste attendue indéfiniment.
- Un ajustement ponctuel peut annuler une occurrence, changer son montant ou sa date.
- Désactiver ou masquer la rubrique d'une récurrence **n'a aucun effet** sur ses occurrences.

**État d'une échéance** : *soldée* (montant affecté ≥ attendu, ou soldée avec écart accepté), *partielle*, *à venir*, *en retard* (date passée, postérieure au dernier solde constaté de son compte, rien d'affecté), *réputée incluse* (date passée, antérieure ou égale au dernier solde constaté de son compte : ce solde l'inclut déjà, elle n'est plus attendue). Le compte d'une échéance est son compte prévu, sinon le compte par défaut de sa devise.

**Exemple.** Solde du Livret constaté au 15/10. Une facture prévue le 10/10 et non rapprochée est *réputée incluse* ; une facture du 20/10 non rapprochée est *en retard* et reportée dans le reste attendu de novembre. Cela évite qu'une récurrence ou un crédit saisi avec une date de début ancienne ne génère des « retards » fictifs.

**Exemple.** Loyer de 100,00 € le 31 de chaque mois depuis le 31/01 : 28/02, 31/03, 30/04… Évolution à 110,00 € à partir du 01/07 : 100,00 € jusqu'en juin, 110,00 € ensuite.

### Annuel, lissage, calendrier [`annualView`]

| Notion | Formule | Utilisation |
|---|---|---|
| Montant annuel | Σ occurrences sur 12 mois | information de la fiche |
| Repère lissé | annuel / 12 | colonne facultative ; **ne s'ajoute à rien** |
| Calendrier | chaque occurrence dans son mois | **seule** base du prévu, du reste attendu et de la trésorerie |

**Exemple.** Taxe foncière 1 200,00 € le 15/10 : annuel 1 200,00 € ; repère lissé 100,00 € ; prévu d'octobre 1 200,00 €, prévu des autres mois 0 €.

---

## 5. Suivi mensuel [engine/tracking.ts `trackRubrique`]

Pour une rubrique *r* et un mois *m*, en euros, dépenses en valeur positive (règle symétrique pour les revenus) :

| Symbole | Définition |
|---|---|
| B | budget de référence : **actualisé** s'il existe, sinon **initial** ; absent si aucun budget |
| E | somme des échéances identifiées de *r* dont la date tombe en *m* |
| L | **enveloppe libre** = max(0, B − E) |
| Prévu | E + L (sans budget : E) |
| Réel | lignes retenues (§ 2) |
| R_nr | réel **non rapproché** = réel − part des paiements affectée à des échéances |
| U | échéances non soldées = Σ (attendu − affecté) ; au mois en cours, + échéances en retard des mois précédents |
| Reste attendu | mois en cours ou futur : max(0, L − R_nr) + U ; mois écoulé : 0 |
| Écart | mois en cours / futur : Réel + Reste attendu − B (« écart projeté ») ; mois écoulé : Réel − B ; « provisoire » tant que le mois n'est pas clôturé |

Les échéances sont **incluses** dans le budget. Si B < E, c'est signalé (« Budget inférieur aux échéances identifiées ») et le prévu retenu est E.

**Exemple.** B = 500 €, une échéance de 200 €.

| Situation | Réel | Reste attendu | Écart projeté |
|---|---|---|---|
| rien de payé | 0 | 300 + 200 = 500 | 0 |
| autre facture de 200 € non rapprochée | 200 | max(0, 300 − 200) + 200 = 300 | 0 |
| échéance payée 230 € (écart accepté) + 50 € d'autres dépenses | 280 | max(0, 300 − 50) + 0 = 250 | +30 |

**Rapprochement individuel.** Un paiement est affecté explicitement à une échéance de **la même rubrique** et du même sens. Un paiement non affecté réduit l'enveloppe libre, jamais une échéance. Paiement partiel : l'échéance reste ouverte pour le solde. Écart de montant : « solder avec écart » (choix explicite) ou laisser ouvert.

### Estimation des dépenses variables (mois en cours)

Méthode choisie par rubrique, affichée à côté du chiffre :

- **budget** (par défaut) : reste libre = max(0, L − R_nr) ;
- **prorata** : reste libre = max(0, R_nr × jours du mois / jours écoulés − R_nr). Exemple : 190 € dépensés au 19 novembre (30 jours) → 300 € estimés → reste 110 € ;
- **moyenne** : reste libre = max(0, moyenne de R_nr sur les N derniers mois **complets** − R_nr). Sans mois complet : méthode budget, signalé.

### Mois complet

Un mois est **complet** quand il est écoulé **et clôturé** (action « Clôturer le mois »). Le mois en cours ne peut pas être clôturé. Modifier un mois clôturé reste possible.

### Sous-totaux

Le prévu, le réel et le reste attendu d'une famille sont la somme exacte de ceux de ses rubriques. L'écart d'une famille est la somme des écarts de ses rubriques **budgétées**.

---

## 6. Analyse d'une période [engine/analysis.ts]

### Périmètre

- **Foyer** : toutes les lignes ; budgets comparables.
- **Compte** ou **personne** : seules les opérations des comptes concernés. Sont exclus et annoncés : totaux synthétiques, écarts de change calculés, budgets (affichés à part, « non comparable »).

### Entrées et sorties [`flows`]

| Catégorie | Natures |
|---|---|
| Revenus structurels | revenu ordinaire |
| Revenus exceptionnels | revenu exceptionnel |
| Dépenses de consommation | dépense courante, remboursement de dépense (en déduction), intérêts/assurance/frais de crédit, frais de transfert, écarts de change |
| À classer | opérations « À classer » |
| Capital remboursé | remboursement de capital |
| Emprunts reçus | emprunt reçu |
| Épargne placée | épargne / investissement (vers un placement non suivi comme compte) |

Les transferts internes ne figurent dans aucune catégorie (leur nombre est indiqué). **Solde de trésorerie de la période** = somme des catégories.

### Répartition des dépenses (anneau) [`expenseDonut`]

Dépense nette par famille (dépenses − remboursements). Les familles dont le net est un gain sont présentées **à part**. **Dénominateur** = somme des familles en dépense nette positive ; il est écrit sous l'anneau.

---

## 7. Crédits [engine/loans.ts]

### Trois modes

| Mode | Saisie | Échéancier |
|---|---|---|
| Simplifié | mensualité hors assurance, capital restant dû à une date, taux facultatif | estimé par le moteur (origine « estimé ») ; sans taux : échéances « non ventilées », capital restant dû constant jusqu'à la prochaine mise à jour |
| Bancaire | échéancier collé (date ; capital ; intérêts ; assurance ; frais ; capital restant dû) | conservé **tel quel** (origine « banque ») ; seule la cohérence total = somme des composants est contrôlée |
| Théorique | capital, taux nominal annuel, nombre d'échéances, fréquence, assurance, frais | calculé et enregistré avec la fiche (origine « calculé ») |

### Calcul théorique

- taux périodique *i* = taux nominal annuel / nombre d'échéances par an (12, 4, 2 ou 1) ;
- échéance constante hors assurance M = P·i / (1 − (1+i)^−n), arrondie au centime (taux nul : P / n) ;
- intérêts = arrondi(capital restant dû × *i*) ; capital = M − intérêts ; **dernière échéance** : capital = capital restant dû (ajustement d'arrondi) ;
- assurance : montant fixe, % annuel du capital initial / nb d'échéances par an, ou % annuel du capital restant dû ;
- frais de dossier : échéance n° 0 une période avant la première échéance.

**Exemple (référence du test).** 200 000 € à 1,85 % sur 240 mois, assurance 0,30 %/an du capital initial : M = 997,62 € ; échéance 1 = 689,29 € de capital + 308,33 € d'intérêts + 50,00 € d'assurance = 1 047,62 € ; échéance 240 = 996,09 + 1,54 + 50,00 = 1 047,63 € ; intérêts totaux 39 428,81 €.

**Limites affichées.** Pas de différé, de taux variable, de remboursement anticipé, d'intérêts intercalaires ni de calcul au jour près. Seul l'échéancier de la banque fait foi.

### Dans les analyses et les prévisions

- Un paiement **rapproché** d'une échéance est ventilé selon elle : **capital** (rubrique « Capital remboursé », catégorie « Capital remboursé » : sortie de trésorerie, pas une consommation), **intérêts**, **assurance**, **frais** (famille Crédits, dépenses de consommation). Un paiement partiel est ventilé au prorata ; la part non affectée reste dans sa rubrique.
- Un paiement **non rapproché** reste dans « Crédits › Échéance non ventilée » et figure dans « À vérifier ».
- Si une récurrence est associée au crédit, ses occurrences sont **remplacées** par les échéances du crédit (jamais additionnées).
- Le suivi mensuel prévoit, dans chaque rubrique, la part de l'échéance qui la concerne.
- **Capital restant dû** au jour J : celui de la dernière échéance échue (bancaire, théorique) ; en simplifié, capital déclaré diminué du capital estimé des échéances suivantes.
- **Archiver** retire les échéances futures des prévisions ; **réactiver** les y remet. Aucun paiement n'est recréé (les paiements sont des opérations).
- Les associations (compte de prélèvement, récurrence) ne sont enregistrées qu'avec la fiche.

---

## 8. Réserve, fonds et projets [engine/funds.ts]

- **Réservé d'un fonds** = Σ affectations datées ≤ J − Σ paiements rattachés datés ≤ J.
- **Réservé** = réservé de la réserve de sécurité + réservé des fonds et projets actifs (converti en euros).
- **Non affecté** = Liquidités totales − Réservé (peut être négatif ; c'est alors signalé).
- Un **paiement de projet** est une dépense ordinaire de sa rubrique, rattachée au projet : il diminue les liquidités **et** le réservé du même montant. Le non affecté ne bouge pas.

**Exemple.** Liquidités 31 389,86 € ; réserve 15 000 € ; projet Véhicule 9 000 € → réservé 24 000 €, non affecté 7 389,86 €. Acompte de 3 000 € payé et rattaché au projet : liquidités 28 389,86 €, réservé 21 000 €, non affecté **7 389,86 €** (inchangé).

---

## 9. Prévision de trésorerie [engine/forecast.ts]

Pour chaque compte courant ou d'épargne **ayant un solde constaté**, au dernier jour de chaque mois de l'horizon (24 mois par défaut) :

```
solde prévu = dernier solde constaté
            + opérations réelles postérieures à ce solde (jusqu'à aujourd'hui)
            + flux attendus postérieurs à ce solde et non soldés, datés au plus tard ce jour-là
```

Flux attendus, chacun compté **une seule fois** :

| Flux | Date retenue | Montant |
|---|---|---|
| Échéance à venir (récurrence, ponctuelle, projet) | sa date | reste à payer |
| Échéance de crédit | sa date | échéance totale (capital + intérêts + assurance + frais) |
| Échéance passée, compte détaillé, non rapprochée (« en retard ») | aujourd'hui | reste à payer |
| Échéance passée, compte suivi par soldes | sa date (supposée réalisée) | montant prévu |
| Enveloppe libre d'un budget | dernier jour du mois | mois en cours : reste de l'enveloppe (méthode de la rubrique) ; mois futurs : enveloppe libre (budget − échéances) |

- Un flux sans compte prévu va sur le compte par défaut de sa devise (le premier compte courant créé dans une devise le devient automatiquement). Sans compte par défaut, il n'est compté que dans le total consolidé, et c'est signalé.
- Les échéances identifiées ne sont jamais ajoutées en plus du budget : seule l'enveloppe libre (budget − échéances) est un flux de budget.
- Les comptes sans solde constaté sont **exclus et nommés** (« hors … ») ; ils ne sont jamais comptés pour zéro.
- Les comptes en CHF sont convertis au **taux d'hypothèse** (dernier taux connu), affiché au-dessus de la courbe.

**Réservé prévu** (fin de mois) = réservé aujourd'hui + versements prévus vers les fonds − paiements prévus des projets (au moins 0 par fonds).

**Minimum des soldes prévus en fin de mois** = plus bas des liquidités prévues sur l'horizon, avec le mois concerné.

**Marge après réserve et fonds** = plus bas, sur l'horizon, de (liquidités prévues − réservé prévu), avec le mois concerné.

**Exemple.** Courant : solde constaté 3 000 € au 31/10 ; dépense réelle de 150 € le 08/11 ; abonnement de 13,99 € du 05/11 non rapproché (en retard) ; salaire de 3 200 € le 25 ; budget Courses 400 €/mois. Fin novembre : 3 000 − 150 − 13,99 + 3 200 − (400 − 150) = **5 786,01 €**. Fin décembre : + 3 200 − 13,99 − 400 = **8 572,02 €**.

## 10. À vérifier [engine/checks.ts]

Conflits total/détail non résolus ; opérations « à vérifier » ou « À classer » ; échéances en retard ; paiements de crédit non ventilés ; mois écoulés non clôturés (3 derniers) ; comptes sans solde constaté ou au solde ancien ; comptes archivés avec un solde ; taux EUR/CHF manquants ou de plus de 7 jours ; non affecté négatif.

---

## 11. Patrimoine et projection [engine/wealth.ts]

### Patrimoine net

**Patrimoine net** = Liquidités totales + Investissements + Biens − Capital restant dû.

- **Investissements** : dernière valeur déclarée datée de chaque compte « Investissement », convertie au taux de sa date.
- **Biens** : dernière valeur déclarée datée × quote-part du foyer, convertie au taux de sa date.
- **Capital restant dû** : crédits non soldés (archivés compris), § 7.

**Exemple.** Liquidités 31 389,86 € ; PEA 40 000 € (valeur du 30/09) ; résidence 420 000 € (30/06) ; appartement en Suisse 500 000 CHF à 50 %, taux du 31/10 0,9412 → 265 618,36 € ; capital restant dû 189 000 € → patrimoine net **568 008,22 €**.

### Projection (3 scénarios)

Horizon : de l'année en cours à l'année de la dernière date de retraite renseignée (à défaut 25 ans, signalé). Points annuels.

| Élément | Règle |
|---|---|
| Départ | soldes et valeurs déclarées actuels, par devise |
| Revenus structurels annuels | échéances identifiées de revenus ordinaires sur les 12 prochains mois + enveloppes libres des budgets de revenus ; × (1 + évolution des revenus)^t |
| Dépenses annuelles | échéances identifiées et enveloppes libres des dépenses sur 12 mois (coûts de crédit compris) ; × (1 + inflation)^t |
| Capital remboursé | selon les échéanciers des crédits, année par année |
| Liquidités | + (revenus − dépenses − capital remboursé) chaque année, sans rendement |
| Placements | × (1 + rendement du scénario) chaque année |
| Biens | × (1 + évolution immobilière) chaque année |
| Dettes | capital restant dû au 31/12 selon les échéanciers |
| CHF | converti au taux EUR/CHF du scénario |
| Euros constants | nominal / (1 + inflation)^t |

Paramètres par défaut (modifiables) : prudent (inflation 3 %, rendement 1 %, immobilier 0 %, 0,90 CHF/€, revenus +0,5 %), central (2 %, 3 %, 1 %, 0,94, +1,5 %), favorable (1,5 %, 5 %, 2 %, 0,98, +2,5 %).

**Affichage** : fourchette prudent – favorable avec le central en trait, montants arrondis au millier d'euros. Les revenus exceptionnels sont exclus des flux structurels.

**Limites.** Pas d'impôt sur les plus-values, pas de fiscalité de la retraite, pas de baisse de revenus à la retraite, dépenses indexées uniformément sur l'inflation. Ce sont des ordres de grandeur.
