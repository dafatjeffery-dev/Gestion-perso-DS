# DS Finances — Guide utilisateur

DS Finances est une application locale : vos données restent sur votre Mac, dans un fichier unique (Paramètres › Données et sauvegardes indique son emplacement exact). Rien n'est envoyé à un service externe, sauf la récupération facultative des taux de change auprès de la BCE, que vous déclenchez vous-même.

Objectif : **10 à 20 minutes par mois**.

---

## 1. Démarrer avec ses comptes

1. **Comptes › Nouveau compte** : nom, établissement, devise (EUR ou CHF), propriétaire, type (courant, épargne, investissement) et mode de suivi :
   - *Détaillé* : vous saisissez ou importez les opérations ;
   - *Par soldes constatés* : vous mettez seulement le solde à jour de temps en temps.
2. Indiquez le **dernier solde connu** et sa date. Un solde constaté daté J est le solde **en fin de journée J** : les opérations de ce jour-là y sont déjà comprises.
3. Le premier compte courant d'une devise devient son **compte par défaut** (celui des prévisions sans compte précisé).
4. **Paramètres › Taux de change** : saisissez un taux EUR/CHF, importez un CSV `date;taux`, ou cliquez « Récupérer les taux (BCE) » (connexion explicite, seules des dates sont envoyées).

Archiver un compte ne supprime rien : il n'est plus proposé à la saisie, mais son historique et son solde restent dans les liquidités.

## 2. Saisir un salaire et un abonnement

**Engagements › Nouvelle récurrence** :

- *Salaire* : rubrique « Salaire A », montant reçu 3 200 €, mensuelle, le 25, compte prévu « Courant ».
- *Abonnement* : rubrique « Abonnements », montant payé 13,99 €, mensuelle, le 5.

Laissez la date de fin vide si elle n'est pas connue : la récurrence reste prévue jusqu'à son arrêt explicite. Pour une dépense annuelle (taxe foncière en octobre), choisissez « Annuelle » : le **montant annuel**, le **repère lissé** (annuel / 12) et le **calendrier réel** sont affichés séparément, sans jamais s'additionner ; seul le calendrier compte dans la trésorerie.

## 3. Saisir ou importer un mois

Trois manières, combinables :

- **Saisie détaillée** : Opérations › Nouvelle opération.
- **Total du mois** (sans compte) : Suivi mensuel › rubrique › « Total du mois ». Un total n'agit jamais sur les soldes. Si la rubrique a déjà des opérations ce mois-là, l'application vous demande de choisir : le total remplace le détail, le détail remplace le total, ou le total est un complément.
- **Import** : Comptes ou Opérations › « Importer des opérations » (voir `FORMAT_IMPORT.md`) :
  1. téléchargez le modèle (XLSX ou CSV) et copiez les consignes pour l'IA ;
  2. donnez relevés + modèle + consignes à votre IA, arbitrez avec elle les cas incertains ;
  3. chargez le fichier : contrôles, correspondances des rubriques inconnues, doublons, conflits, récapitulatif ;
  4. confirmez. Rien n'est écrit tant qu'il reste une erreur bloquante.

Puis **rapprochez** les paiements de leurs échéances (fiche de l'opération › Rapprochement) et **clôturez le mois** (Suivi mensuel › « Clôturer le mois ») : un mois clôturé est un « mois complet » pour les moyennes.

## 4. Corriger une ancienne saisie

- **Opération** : cliquez son libellé dans la liste, corrigez, enregistrez. Le libellé bancaire original n'est jamais modifié. Toute modification est inscrite au journal (Paramètres › Données › Journal).
- **Plusieurs opérations** : cochez-les (ou « tout sélectionner » le résultat filtré), puis « Changer de rubrique », « Commentaire commun » ou « Supprimer… ». Les incompatibilités sont expliquées ; signe, nature et devise ne changent jamais automatiquement.
- **Total mensuel** : « Total du mois » › *Corriger* (même enregistrement), *Déplacer* (vers un autre mois, retiré de la source) ou *Dupliquer* (copie). En cas de total existant à destination, l'application explique et attend votre choix ; « Annuler cette action » remet tout en place.
- **Suppression** : les éléments liés (rapprochements, transferts, paiements de projet) sont présentés avant confirmation ; les opérations vont à la corbeille (Paramètres › Données › Corbeille).

## 5. Faire évoluer une récurrence

Engagements › récurrence :

- **Corriger** — l'erreur était déjà là : la version est modifiée, passé compris.
- **Faire évoluer** — le montant change à partir d'une date : une nouvelle version commence, l'ancienne reste valable avant.
- **Arrêter** — date de fin.

« Versions » affiche l'historique.

## 6. Créer un projet

Réserve, fonds et projets :

1. **Définir la réserve de sécurité** (montant cible), puis « Affecter » le montant que vous mettez de côté.
2. **Nouveau projet** (véhicule, travaux…) : objectif, échéance, versements prévus.
3. « Affecter / libérer » : l'argent reste sur vos comptes, il est seulement réservé.
4. « Paiement prévu » : apparaît dans la prévision de trésorerie.
5. Quand le paiement a lieu : fiche de l'opération › Projet › « Rattacher ». La réservation est consommée ; le non affecté ne change pas.

Indicateurs : **Liquidités totales**, **Réservé**, **Non affecté = liquidités − réservé**.

## 7. Renseigner un crédit

Crédits › Nouveau crédit, trois modes :

- **Simplifié** : mensualité hors assurance + capital restant dû à une date (+ taux si connu).
- **Échéancier de la banque** : collez le tableau (date ; capital ; intérêts ; assurance ; frais ; capital restant dû) ; il est conservé tel quel.
- **Calcul théorique** : capital, taux, nombre d'échéances, fréquence, assurance ; les limites du calcul sont affichées.

Associez le compte de prélèvement et, si vous en aviez créé une, la récurrence correspondante : ses occurrences sont alors remplacées par les échéances du crédit. Ces associations ne sont enregistrées qu'avec la fiche (annuler n'enregistre rien).

Rapprochez chaque prélèvement de son échéance : il est ventilé en capital (sortie de trésorerie) et intérêts / assurance / frais (dépenses). Archiver retire le crédit des prévisions ; réactiver l'y remet sans rien dupliquer.

## 8. Comprendre un écart budget / réel

Suivi mensuel, pour chaque rubrique :

- **Prévu** = échéances identifiées + enveloppe libre (budget − échéances) ;
- **Réalisé** = opérations et totaux retenus ;
- **Reste attendu** = ce qui reste de l'enveloppe + échéances non soldées (mois en cours ou futur) ;
- **Écart** = réalisé + reste attendu − budget (mois en cours : « projeté ») ; mois écoulé : réalisé − budget, « provisoire » tant que le mois n'est pas clôturé.

Cliquez n'importe quel montant : le panneau « Détail » montre sa définition, sa composition et les opérations concernées. Exemple : budget 500 €, une facture prévue de 200 € payée 230 € (écart accepté), 50 € d'autres dépenses → réalisé 280 €, reste 250 €, écart +30 €.

Budgets : « Budget » sur la rubrique ; le **budget initial** d'un mois est figé, le **budget actualisé** est une révision explicite. « Budgets initial et actualisé » les affiche côte à côte.

Une analyse limitée à un compte ou une personne n'est jamais comparée au budget familial : la comparaison est indiquée indisponible.

## 9. Sauvegarder et restaurer

Application Mac :

- **Automatique** : au démarrage, avant une migration, une restauration ou un nouveau départ, au plus toutes les 10 minutes après des modifications, et à la fermeture. Rotation : 10 plus récentes, une par jour (14 jours), une par semaine (8 semaines), une par mois (12 mois).
- **Manuelle** : Paramètres › Données › « Sauvegarder maintenant ».
- **Restaurer** : choisissez une sauvegarde › « Restaurer… ». Elle est d'abord vérifiée (et migrée si besoin) sur une copie isolée ; un résumé s'affiche ; l'état courant est sauvegardé juste avant le remplacement.

Aperçu navigateur (développement) : les données sont dans le navigateur ; « Télécharger une sauvegarde (.sqlite) » et « Restaurer depuis un fichier » remplacent les sauvegardes automatiques.

## Exports

| Export | Contenu | Omissions |
|---|---|---|
| Export complet (JSON) | toutes les tables : foyer, comptes, soldes constatés, référentiels, taux, mouvements (corbeille comprise), décisions de couverture, mois clôturés, récurrences et versions, échéances, crédits et échéanciers, rapprochements, budgets, fonds, biens, scénarios, lots d'import et lignes de provenance, journal ; version du format et du schéma | brouillons de formulaires non enregistrés ; fichiers de sauvegarde |
| Opérations (CSV/XLSX) | date, date de valeur, compte, libellés, montant, devise, nature, famille, rubrique, statut, commentaire, transfert, lot, identifiant bancaire | opérations à la corbeille ; lignes calculées (écarts de change, ventilation des paiements de crédit) |
| Totaux | mois, rubrique, montant, devise, nature, règle de couverture, commentaire | totaux à la corbeille |
| Budgets | plans mensuels et budgets de mois (initial, actualisé) | prévus et restes attendus (calculés) |
| Crédits | échéancier de chaque crédit (capital, intérêts, assurance, frais, total, capital restant dû, origine) | rapprochements |

L'export complet est réimportable : Paramètres › Données › « Nouveau départ à partir d'un export complet » (après sauvegarde de l'état courant).
