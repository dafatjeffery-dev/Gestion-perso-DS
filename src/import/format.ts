// DÉFINITION UNIQUE du format d'import (docs/FORMAT_IMPORT.md). Le modèle XLSX et CSV,
// le lecteur, les contrôles, la notice et les consignes pour l'IA en dérivent tous.

export const FORMAT_VERSION = '1.0';
export const SHEET_OPERATIONS = 'Operations';
export const SHEET_NOTICE = 'Notice';
export const SHEET_EXAMPLES = 'Exemples';
export const SHEET_REFERENTIALS = 'Referentiels';
export const CSV_SEPARATOR = ';';

export type ColumnKey =
  | 'identifiant_bancaire'
  | 'compte'
  | 'date_operation'
  | 'date_valeur'
  | 'libelle_bancaire'
  | 'libelle_simplifie'
  | 'montant'
  | 'devise'
  | 'nature'
  | 'famille'
  | 'rubrique'
  | 'reference_transfert'
  | 'commentaire'
  | 'statut_classement';

export interface ColumnDef {
  key: ColumnKey;
  label: string;
  required: boolean;
  description: string;
  example: string;
}

/** Colonnes, dans l'ordre. L'en-tête du fichier est la clé technique (1re ligne). */
export const COLUMNS: readonly ColumnDef[] = [
  { key: 'identifiant_bancaire', label: 'Identifiant bancaire', required: false, description: 'Identifiant unique fourni par la banque pour l’opération, s’il existe. Sert à reconnaître les doublons.', example: 'FR-TX-000123' },
  { key: 'compte', label: 'Compte', required: true, description: 'Référence du compte (CPT-n) ou son nom exact, tel que listé dans la feuille Referentiels.', example: 'CPT-1' },
  { key: 'date_operation', label: 'Date d’opération', required: true, description: 'Date AAAA-MM-JJ ou JJ/MM/AAAA (année sur 4 chiffres).', example: '2026-11-03' },
  { key: 'date_valeur', label: 'Date de valeur', required: false, description: 'Même format, facultative.', example: '' },
  { key: 'libelle_bancaire', label: 'Libellé bancaire original', required: true, description: 'Libellé exact du relevé, jamais réécrit.', example: 'CB MARCHE 02/11' },
  { key: 'libelle_simplifie', label: 'Libellé simplifié', required: false, description: 'Libellé lisible, facultatif.', example: 'Marché' },
  { key: 'montant', label: 'Montant signé', required: true, description: 'Positif = entrée, négatif = sortie. Virgule ou point décimal, 2 décimales au plus, sans symbole monétaire.', example: '-42,10' },
  { key: 'devise', label: 'Devise', required: true, description: 'EUR ou CHF ; doit être la devise du compte.', example: 'EUR' },
  { key: 'nature', label: 'Nature', required: true, description: 'Code de nature financière (feuille Referentiels), indépendant du signe.', example: 'depense' },
  { key: 'famille', label: 'Famille', required: false, description: 'Nom de la famille ; doit correspondre à la rubrique.', example: 'Alimentation' },
  { key: 'rubrique', label: 'Rubrique', required: false, description: 'Référence de rubrique (ex. DEP.ALIM.COURSES) ou nom exact. Vide = « À classer ».', example: 'DEP.ALIM.COURSES' },
  { key: 'reference_transfert', label: 'Référence de transfert', required: false, description: 'Même valeur sur les deux lignes d’un transfert entre comptes du foyer.', example: '' },
  { key: 'commentaire', label: 'Commentaire', required: false, description: 'Texte libre, notamment les doutes de classement.', example: '' },
  { key: 'statut_classement', label: 'Statut de classement', required: true, description: '« à vérifier » ou « confirmé ».', example: 'confirmé' },
];

export const STATUS_VALUES: Record<string, 'a_verifier' | 'confirme'> = {
  'à vérifier': 'a_verifier',
  'a verifier': 'a_verifier',
  a_verifier: 'a_verifier',
  confirmé: 'confirme',
  confirme: 'confirme',
};

/** Lignes d'exemple, fictives, clairement marquées. */
export const EXAMPLE_ROWS: Record<ColumnKey, string>[] = [
  { identifiant_bancaire: 'EXEMPLE-1', compte: 'CPT-1', date_operation: '2026-11-03', date_valeur: '', libelle_bancaire: 'EXEMPLE FICTIF CB SUPERMARCHE', libelle_simplifie: 'Courses', montant: '-86,40', devise: 'EUR', nature: 'depense', famille: 'Alimentation', rubrique: 'DEP.ALIM.COURSES', reference_transfert: '', commentaire: 'exemple fictif', statut_classement: 'confirmé' },
  { identifiant_bancaire: 'EXEMPLE-2', compte: 'CPT-1', date_operation: '2026-11-05', date_valeur: '', libelle_bancaire: 'EXEMPLE FICTIF REMBT MUTUELLE', libelle_simplifie: 'Remboursement santé', montant: '23,50', devise: 'EUR', nature: 'remboursement_depense', famille: 'Santé', rubrique: 'DEP.SANTE.FRAIS', reference_transfert: '', commentaire: 'exemple fictif : entrée d’argent, nature remboursement', statut_classement: 'confirmé' },
  { identifiant_bancaire: 'EXEMPLE-3', compte: 'CPT-1', date_operation: '2026-11-10', date_valeur: '', libelle_bancaire: 'EXEMPLE FICTIF VIR VERS COMPTE CHF', libelle_simplifie: 'Virement vers compte CHF', montant: '-1000,00', devise: 'EUR', nature: 'transfert', famille: 'Mouvements techniques', rubrique: 'SYS.TECH.TRANSFERT', reference_transfert: 'T-2026-11-10', commentaire: 'exemple fictif', statut_classement: 'confirmé' },
  { identifiant_bancaire: 'EXEMPLE-4', compte: 'CPT-2', date_operation: '2026-11-10', date_valeur: '', libelle_bancaire: 'EXEMPLE FICTIF VIR RECU', libelle_simplifie: 'Virement reçu', montant: '935,00', devise: 'CHF', nature: 'transfert', famille: 'Mouvements techniques', rubrique: 'SYS.TECH.TRANSFERT', reference_transfert: 'T-2026-11-10', commentaire: 'exemple fictif : seconde ligne du même transfert', statut_classement: 'confirmé' },
  { identifiant_bancaire: '', compte: 'CPT-1', date_operation: '2026-11-12', date_valeur: '', libelle_bancaire: 'EXEMPLE FICTIF PRLV SEPA XYZ', libelle_simplifie: '', montant: '-15,00', devise: 'EUR', nature: 'a_classer', famille: '', rubrique: '', reference_transfert: '', commentaire: 'exemple fictif : bénéficiaire inconnu, à classer', statut_classement: 'à vérifier' },
];

export const NOTICE_LINES: string[] = [
  `DS Finances — modèle d’import des opérations, format ${FORMAT_VERSION}.`,
  `Remplissez uniquement la feuille « ${SHEET_OPERATIONS} » : une ligne par opération, sans ligne vide entre deux opérations, sans solde, sous-total ni total.`,
  'La première ligne contient les noms techniques des colonnes : ne les modifiez pas, ne les déplacez pas.',
  'Montant signé : positif = entrée d’argent, négatif = sortie. La nature financière est indépendante du signe (ex. un remboursement de santé est positif, nature « remboursement_depense »).',
  'Comptes, familles, rubriques et natures : utilisez seulement les valeurs de la feuille « Referentiels ».',
  'Transfert entre deux comptes du foyer : deux lignes, nature « transfert », même référence de transfert.',
  'En cas de doute sur le classement : statut « à vérifier » et explication en commentaire. Rubrique inconnue : laissez vide (« À classer »).',
  `La feuille « ${SHEET_EXAMPLES} » contient des exemples FICTIFS : ne les importez pas.`,
  'Le fichier CSV équivalent : UTF-8, séparateur point-virgule, mêmes colonnes, première ligne = noms techniques, aucune ligne de commentaire.',
  'DS Finances contrôle le fichier, affiche un aperçu, puis n’écrit rien sans votre confirmation. Une erreur bloquante empêche toute écriture.',
];

/** Consignes à copier pour l'IA, versionnées avec le modèle. */
export function aiInstructions(): string {
  const cols = COLUMNS.map((c) => `- ${c.key}${c.required ? ' (obligatoire)' : ''} : ${c.description}`).join('\n');
  return [
    `Consignes de préparation — import DS Finances, format ${FORMAT_VERSION}`,
    '',
    'Je te fournis des relevés bancaires (CSV, Excel ou PDF) et le modèle d’import DS Finances (feuilles Notice, Exemples, Referentiels). Produis un fichier conforme au modèle :',
    '',
    `1. Respecte exactement la structure : feuille « ${SHEET_OPERATIONS} » (ou CSV UTF-8 séparé par des points-virgules), première ligne = noms techniques des colonnes, dans cet ordre :`,
    cols,
    '2. Conserve sans les modifier les dates, devises, montants et libellés bancaires originaux. N’arrondis pas, ne convertis pas de devise.',
    '3. N’utilise que les comptes, familles, rubriques et natures de la feuille « Referentiels ». N’invente aucune valeur.',
    '4. Ne fusionne jamais deux opérations qui se ressemblent : deux paiements identiques le même jour restent deux lignes.',
    '5. Repère les transferts internes entre comptes du foyer : garde les deux lignes, nature « transfert », même reference_transfert. Ne les supprime pas.',
    '6. Exclus les soldes, sous-totaux, totaux, reports et lignes d’en-tête des relevés.',
    '7. Quand un classement est incertain : statut_classement = « à vérifier » et explique le doute dans commentaire. Si aucune rubrique ne convient : rubrique vide et nature « a_classer ».',
    '8. Signale-moi, avant de produire le fichier : un PDF illisible ou partiellement lu, une période manquante entre deux relevés, une extraction douteuse (montants ou dates incertains), un compte non identifié.',
    '9. Liste-moi les cas incertains pour que nous les arbitrions ensemble avant la version finale.',
    '10. N’ajoute ni solde, ni IBAN, ni donnée personnelle qui ne serait pas dans les colonnes.',
  ].join('\n');
}

export const REQUIRED_KEYS = COLUMNS.filter((c) => c.required).map((c) => c.key);
export const ALL_KEYS = COLUMNS.map((c) => c.key);
export const accountCode = (id: number) => `CPT-${id}`;
