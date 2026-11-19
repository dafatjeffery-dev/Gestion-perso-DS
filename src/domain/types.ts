// Types du domaine. Les noms de champs reprennent ceux des colonnes SQL (snake_case)
// pour éviter toute couche de traduction entre la base et le moteur.

export type Currency = 'EUR' | 'CHF';
export const CURRENCIES: readonly Currency[] = ['EUR', 'CHF'];

/** Date civile 'YYYY-MM-DD'. */
export type IsoDate = string;
/** Mois 'YYYY-MM'. */
export type Month = string;
export type Flag = 0 | 1;

export type Owner = 'A' | 'B' | 'commun';
export type AccountType = 'courant' | 'epargne' | 'investissement';
export type Tracking = 'detaille' | 'synthetique';
export type Direction = 'revenu' | 'depense' | 'technique';

export type NatureCode =
  | 'revenu_ordinaire'
  | 'revenu_exceptionnel'
  | 'depense'
  | 'remboursement_depense'
  | 'transfert'
  | 'emprunt_recu'
  | 'capital_credit'
  | 'cout_credit'
  | 'epargne'
  | 'frais_transfert'
  | 'a_classer';

export interface Household {
  id: 1;
  name: string;
  base_currency: Currency;
  forecast_horizon_months: number;
  ref_balance_max_age_days: number;
}

export interface Person {
  id: number;
  role: 'A' | 'B';
  display_name: string;
  birth_date: IsoDate | null;
  retirement_date: IsoDate | null;
}

export interface Account {
  id: number;
  name: string;
  institution: string;
  currency: Currency;
  owner: Owner;
  type: AccountType;
  tracking: Tracking;
  status: 'actif' | 'archive';
  archived_at: string | null;
  is_default_for_currency: Flag;
  expected_return_class: string | null;
  sort_order: number;
}

export interface BalanceReference {
  id: number;
  account_id: number;
  ref_date: IsoDate;
  amount_minor: number;
  source: 'saisie' | 'import' | 'releve';
  note: string;
}

export interface Nature {
  code: NatureCode;
  label: string;
  sort_order: number;
}

export interface Family {
  id: number;
  name: string;
  direction: Direction;
  visible: Flag;
  is_system: Flag;
  sort_order: number;
}

export interface Rubrique {
  id: number;
  family_id: number;
  name: string;
  ref: string;
  available_for_entry: Flag;
  visible: Flag;
  is_system: Flag;
  estimation_method: 'budget' | 'prorata' | 'moyenne';
  estimation_n: number;
  default_account_id: number | null;
  sort_order: number;
}

export interface FxRate {
  rate_date: IsoDate;
  /** CHF pour 1 EUR × 10⁶. */
  eur_chf_e6: number;
  source: 'manuel' | 'csv' | 'bce';
  updated_at: string;
}

export interface Movement {
  id: number;
  granularity: 'operation' | 'total';
  account_id: number | null;
  op_date: IsoDate | null;
  value_date: IsoDate | null;
  period_month: Month;
  amount_minor: number;
  currency: Currency;
  nature: NatureCode;
  rubrique_id: number;
  label_original: string | null;
  label_simple: string | null;
  bank_id: string | null;
  comment: string;
  classification: 'a_verifier' | 'confirme';
  transfer_id: number | null;
  transfer_role: 'sortie' | 'entree' | 'frais' | null;
  import_batch_id: number | null;
  import_row: number | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export type CoverageMode = 'total_remplace' | 'detail_remplace' | 'complement';
export interface CoverageDecision {
  id: number;
  rubrique_id: number;
  period_month: Month;
  mode: CoverageMode;
  decided_at: string;
}

export interface MonthStatusRow {
  period_month: Month;
  closed_at: string;
  note: string;
}

export interface Transfer {
  id: number;
  reference: string | null;
}

export type Frequency = 'mensuelle' | 'trimestrielle' | 'semestrielle' | 'annuelle' | 'personnalisee';

export interface Recurrence {
  id: number;
  label: string;
  nature: NatureCode;
  rubrique_id: number;
  planned_account_id: number | null;
  end_date: IsoDate | null;
  created_at: string;
  deleted_at: string | null;
}

export interface RecurrenceVersion {
  id: number;
  recurrence_id: number;
  valid_from: IsoDate;
  valid_to: IsoDate | null;
  amount_minor: number;
  currency: Currency;
  frequency: Frequency;
  interval_months: number;
  day_of_month: number;
  months_mask: number | null;
  change_kind: 'creation' | 'evolution';
  created_at: string;
}

export interface OccurrenceOverride {
  recurrence_id: number;
  due_date: IsoDate;
  action: 'annulee' | 'montant' | 'date';
  amount_minor: number | null;
  new_date: IsoDate | null;
}

export interface ScheduledItem {
  id: number;
  label: string;
  due_date: IsoDate;
  amount_minor: number;
  currency: Currency;
  nature: NatureCode;
  rubrique_id: number;
  planned_account_id: number | null;
  fund_id: number | null;
  status: 'prevue' | 'annulee';
  created_at: string;
  deleted_at: string | null;
}

export type LoanFrequency = 'mensuelle' | 'trimestrielle' | 'semestrielle' | 'annuelle';
export interface Loan {
  id: number;
  label: string;
  lender: string;
  currency: Currency;
  mode: 'simplifie' | 'bancaire' | 'theorique';
  principal_minor: number | null;
  annual_rate_e6: number | null;
  periods: number | null;
  frequency: LoanFrequency;
  first_due_date: IsoDate;
  insurance_mode: 'aucune' | 'montant_fixe' | 'pct_capital_initial' | 'pct_crd';
  /** montant_fixe : unités mineures par échéance ; pct_* : taux annuel × 10⁶. */
  insurance_value: number | null;
  fees_per_installment_minor: number;
  fees_initial_minor: number;
  simple_installment_minor: number | null;
  simple_crd_minor: number | null;
  simple_crd_date: IsoDate | null;
  payment_account_id: number | null;
  recurrence_id: number | null;
  status: 'actif' | 'archive' | 'solde';
  archived_at: string | null;
  created_at: string;
  deleted_at: string | null;
}

export interface LoanInstallment {
  loan_id: number;
  seq: number;
  due_date: IsoDate;
  principal_minor: number;
  interest_minor: number;
  insurance_minor: number;
  fees_minor: number;
  total_minor: number;
  crd_after_minor: number;
  origin: 'banque' | 'calcule' | 'estime';
}

export interface Reconciliation {
  id: number;
  movement_id: number;
  target_kind: 'occurrence' | 'echeance' | 'credit';
  recurrence_id: number | null;
  occurrence_date: IsoDate | null;
  scheduled_item_id: number | null;
  loan_id: number | null;
  installment_seq: number | null;
  allocated_minor: number;
  closes_target: Flag;
  created_at: string;
}

export interface BudgetPlan {
  id: number;
  rubrique_id: number;
  valid_from_month: Month;
  valid_to_month: Month | null;
  monthly_minor: number;
  currency: Currency;
}

export interface BudgetMonth {
  id: number;
  rubrique_id: number;
  period_month: Month;
  initial_minor: number;
  actualise_minor: number | null;
  currency: Currency;
}

export interface Fund {
  id: number;
  kind: 'reserve' | 'projet';
  name: string;
  target_minor: number | null;
  currency: Currency;
  target_date: IsoDate | null;
  status: 'actif' | 'termine' | 'archive';
  deleted_at: string | null;
}
export interface FundAllocation {
  id: number;
  fund_id: number;
  alloc_date: IsoDate;
  amount_minor: number;
  note: string;
}
export interface FundPlan {
  id: number;
  fund_id: number;
  amount_minor: number;
  frequency: LoanFrequency;
  start_date: IsoDate;
  end_date: IsoDate | null;
}
export interface FundConsumption {
  id: number;
  fund_id: number;
  movement_id: number;
  amount_minor: number;
}

export interface Asset {
  id: number;
  kind: 'immobilier' | 'autre';
  name: string;
  currency: Currency;
  ownership_pct_e2: number;
  status: 'actif' | 'archive';
  deleted_at: string | null;
}
export interface AssetValuation {
  asset_id: number;
  valuation_date: IsoDate;
  value_minor: number;
  source: string;
}

export interface ScenarioParams {
  inflation: number;
  return_default: number;
  real_estate: number;
  eur_chf: number;
  income_growth: number;
}
export interface Scenario {
  id: number;
  kind: 'prudent' | 'central' | 'favorable';
  params_json: string;
}

export interface ImportBatch {
  id: number;
  imported_at: string;
  file_name: string;
  file_sha256: string;
  file_kind: 'csv' | 'xlsx';
  format_version: string;
  account_ids_json: string;
  period_from: IsoDate | null;
  period_to: IsoDate | null;
  rows_total: number;
  rows_imported: number;
  rows_excluded: number;
  rows_flagged: number;
  status: 'integre' | 'annule';
  cancelled_at: string | null;
}

export interface ImportRow {
  batch_id: number;
  row_no: number;
  outcome: 'importee' | 'exclue' | 'signalee';
  reason: string | null;
  movement_id: number | null;
  raw_json: string;
}

export interface AuditEntry {
  id: number;
  ts: string;
  actor: string;
  action_group: string;
  entity: string;
  entity_id: string;
  action: 'create' | 'update' | 'delete' | 'restore' | 'move';
  summary: string;
  before_json: string | null;
  after_json: string | null;
}

/** Toutes les données du foyer, chargées en mémoire pour le moteur. */
export interface Snapshot {
  household: Household;
  persons: Person[];
  accounts: Account[];
  balanceRefs: BalanceReference[];
  natures: Nature[];
  families: Family[];
  rubriques: Rubrique[];
  fxRates: FxRate[];
  movements: Movement[];
  coverage: CoverageDecision[];
  monthStatus: MonthStatusRow[];
  transfers: Transfer[];
  recurrences: Recurrence[];
  recurrenceVersions: RecurrenceVersion[];
  overrides: OccurrenceOverride[];
  scheduled: ScheduledItem[];
  loans: Loan[];
  installments: LoanInstallment[];
  reconciliations: Reconciliation[];
  budgetPlans: BudgetPlan[];
  budgetMonths: BudgetMonth[];
  funds: Fund[];
  fundAllocations: FundAllocation[];
  fundPlans: FundPlan[];
  fundConsumptions: FundConsumption[];
  assets: Asset[];
  assetValuations: AssetValuation[];
  scenarios: Scenario[];
  importBatches: ImportBatch[];
}
