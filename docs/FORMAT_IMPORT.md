# DS Finances — Format d'import des opérations

**Version du format : 1.0.** Source unique dans le code : `src/import/format.ts` (le modèle XLSX/CSV, le lecteur, les contrôles, la notice et les consignes pour l'IA en dérivent).

## Parcours

1. Exporter ses relevés (CSV, Excel, PDF) depuis ses banques.
2. Dans DS Finances (Comptes ou Opérations › « Importer des opérations ») : **Télécharger le modèle d'import** (.xlsx ou .csv) et **Copier les consignes de préparation pour l'IA**.
3. Donner relevés + modèle + consignes à l'IA de son choix ; arbitrer avec elle les cas incertains.
4. Charger le fichier obtenu : DS Finances contrôle, présente un aperçu, et n'écrit qu'après confirmation.
5. Retrouver les opérations du lot (filtre « lot d'import »), les corriger, reclasser ou supprimer, individuellement ou par sélection multiple ; annuler le lot si besoin.

DS Finances ne contacte aucune IA et ne lit pas les PDF.

## Modèle

### XLSX

| Feuille | Contenu |
|---|---|
| `Operations` | **seule feuille lue** : ligne 1 = noms techniques des colonnes, puis une ligne par opération |
| `Notice` | cellule B1 = version du format ; mode d'emploi ; description des colonnes |
| `Exemples` | lignes **fictives**, marquées « EXEMPLES FICTIFS — NE PAS IMPORTER » |
| `Referentiels` | comptes (référence `CPT-n`, nom, devise, type, statut), natures (code, libellé), rubriques (référence stable, famille, rubrique, sens, natures compatibles, disponibilité) |

Aucune macro, formule ni lien externe. Le modèle ne contient ni solde, ni IBAN, ni autre donnée personnelle que les noms des comptes.

### CSV

UTF-8 (avec BOM), séparateur `;`, ligne 1 = noms techniques des colonnes, aucune ligne de commentaire. La notice est consultable dans l'application (« Lire la notice »).

La version est identifiée par l'ensemble des colonnes ; dans un XLSX, une version différente en `Notice!B1` est refusée.

## Colonnes

| Colonne | Obligatoire | Contenu |
|---|---|---|
| `identifiant_bancaire` | non | identifiant unique fourni par la banque (sert aux doublons) |
| `compte` | oui | `CPT-n` ou nom exact du compte |
| `date_operation` | oui | `AAAA-MM-JJ` ou `JJ/MM/AAAA` (ou cellule date Excel) ; année sur 2 chiffres refusée |
| `date_valeur` | non | même format |
| `libelle_bancaire` | oui | libellé original, jamais réécrit |
| `libelle_simplifie` | non | libellé lisible |
| `montant` | oui | signé : positif = entrée, négatif = sortie ; `-1234,56`, `-1 234,56` (espaces normales, insécables ou fines), `-1234.56`, `1'234.56` ; 2 décimales au plus ; `1.234`, `1,234`, `1.234,56` refusés (ambigus) |
| `devise` | oui | `EUR` ou `CHF`, égale à la devise du compte |
| `nature` | oui | code de nature (indépendant du signe) |
| `famille` | non | nom de famille, doit correspondre à la rubrique |
| `rubrique` | non | référence stable (ex. `DEP.ALIM.COURSES`) ou nom exact ; vide avec la nature `a_classer` = « À classer » |
| `reference_transfert` | non | même valeur sur les deux lignes d'un transfert entre comptes du foyer |
| `commentaire` | non | texte libre (doutes de classement) |
| `statut_classement` | oui | `à vérifier` ou `confirmé` |

Les identifiants internes sont générés par l'application.

## Contrôles

Étapes : lecture → structure et version → lignes → correspondances → doublons et conflits → récapitulatif → confirmation.

| Contrôle | Niveau |
|---|---|
| feuille `Operations` absente ou en double ; fichier illisible ; colonne obligatoire absente ; colonne en double ; formule | bloquant |
| colonne inconnue | avertissement (ignorée) |
| date invalide ou ambiguë ; montant absent, non numérique ou ambigu | bloquant |
| compte inconnu ou archivé ; devise incompatible avec le compte | bloquant |
| nature inconnue ; nature incompatible avec la rubrique ; famille incohérente avec la rubrique ; rubrique indisponible pour de nouvelles saisies | bloquant |
| ligne incomplète (compte, date, libellé, montant, devise, nature, statut) | bloquant |
| rubrique inconnue | bloquant jusqu'à association explicite (rubrique existante, « À classer », ou création d'une rubrique par une action dédiée) |
| identifiant bancaire en double dans le fichier | bloquant |
| doublon possible | bloquant jusqu'à décision (importer / ne pas importer) |
| chevauchement avec un total mensuel sans décision de couverture | bloquant jusqu'à décision |
| opération antérieure ou égale au dernier solde constaté du compte | avertissement |
| référence de transfert sans seconde ligne cohérente | avertissement (opération simple) |
| fichier identique déjà importé | avertissement (les doublons restent contrôlés ligne par ligne) |

Chaque message indique fichier/feuille, ligne, colonne, valeur, raison et correction attendue, par exemple :
« Ligne 18, colonne Devise : « USD » : USD n'est pas compatible avec le compte Courant CHF — attendu : CHF ».

**Erreur bloquante = aucune écriture.** Un lot confirmé est écrit en **une transaction** (lot, opérations, lignes de provenance, transferts, décisions de couverture, journal).

## Doublons

1. **Identifiant bancaire** identique dans le même compte → doublon certain. Deux identifiants différents → opérations distinctes.
2. Sinon, appariement **par multiensemble** sur (compte, date, montant, libellé original normalisé) : si le fichier contient 3 lignes identiques et la base 2, les 2 premières sont des doublons certains et la 3ᵉ est nouvelle. Deux paiements réellement identiques restent donc conservables.
3. Sinon, **ressemblance** (même compte et montant, date à ±3 jours, libellé proche ou même jour) → doublon possible, décision demandée.

Doublon certain : exclu par défaut, « importer quand même » possible. Le nom ou l'empreinte du fichier ne sont jamais l'unique protection. Un relevé partiel ne remplace jamais un mois : il ajoute seulement les lignes nouvelles.

## Lots et annulation

Chaque import est un lot : identifiant, date-heure, fichier, empreinte SHA-256, comptes, période couverte, lignes importées / exclues / signalées, version du format. Chaque opération garde son lot et sa ligne d'origine ; chaque ligne du fichier (même exclue) est conservée avec son résultat.

**Annuler un lot** présente d'abord les conséquences : opérations concernées, opérations modifiées depuis l'import (d'après le journal), rapprochements, transferts et paiements de projet liés. Les opérations modifiées peuvent être conservées ; les autres vont à la corbeille ; la provenance reste consultable.

## Sélection multiple (liste des opérations)

Sélection d'une, plusieurs ou toutes les lignes du résultat filtré (périmètre affiché) ; filtres compte, période, rubrique, statut, lot, texte. Actions : changer de rubrique (incompatibilités de nature, transferts et rapprochements expliqués ; ni signe, ni nature, ni devise modifiés), commentaire commun, suppression avec contrôle des dépendances. Pas de modification groupée des montants ni des dates. Chaque correction est journalisée.
