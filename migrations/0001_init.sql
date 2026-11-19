-- DS Finances — schéma initial (voir docs/ARCHITECTURE.md § 4)
-- Montants : entiers en unités mineures (*_minor). Dates : 'YYYY-MM-DD'. Mois : 'YYYY-MM'.

-- ---------------------------------------------------------------- foyer
CREATE TABLE household (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  name TEXT NOT NULL DEFAULT 'Mon foyer',
  base_currency TEXT NOT NULL DEFAULT 'EUR' CHECK (base_currency IN ('EUR','CHF')),
  forecast_horizon_months INTEGER NOT NULL DEFAULT 24 CHECK (forecast_horizon_months BETWEEN 1 AND 120),
  ref_balance_max_age_days INTEGER NOT NULL DEFAULT 35 CHECK (ref_balance_max_age_days > 0)
);
INSERT INTO household (id) VALUES (1);

CREATE TABLE person (
  id INTEGER PRIMARY KEY,
  role TEXT NOT NULL UNIQUE CHECK (role IN ('A','B')),
  display_name TEXT NOT NULL CHECK (length(trim(display_name)) > 0),
  birth_date TEXT CHECK (birth_date IS NULL OR date(birth_date) = birth_date),
  retirement_date TEXT CHECK (retirement_date IS NULL OR date(retirement_date) = retirement_date)
);
INSERT INTO person (role, display_name) VALUES ('A','Personne A'), ('B','Personne B');

CREATE TABLE setting (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);

-- ---------------------------------------------------------------- comptes
CREATE TABLE account (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  institution TEXT NOT NULL DEFAULT '',
  currency TEXT NOT NULL CHECK (currency IN ('EUR','CHF')),
  owner TEXT NOT NULL CHECK (owner IN ('A','B','commun')),
  type TEXT NOT NULL CHECK (type IN ('courant','epargne','investissement')),
  tracking TEXT NOT NULL DEFAULT 'detaille' CHECK (tracking IN ('detaille','synthetique')),
  status TEXT NOT NULL DEFAULT 'actif' CHECK (status IN ('actif','archive')),
  archived_at TEXT,
  is_default_for_currency INTEGER NOT NULL DEFAULT 0 CHECK (is_default_for_currency IN (0,1)),
  expected_return_class TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  CHECK ((status = 'archive') = (archived_at IS NOT NULL))
);
CREATE UNIQUE INDEX ux_account_default_currency ON account(currency) WHERE is_default_for_currency = 1;

CREATE TABLE balance_reference (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES account(id),
  ref_date TEXT NOT NULL CHECK (date(ref_date) = ref_date),
  amount_minor INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT 'saisie' CHECK (source IN ('saisie','import','releve')),
  note TEXT NOT NULL DEFAULT '',
  UNIQUE (account_id, ref_date)
);

-- ---------------------------------------------------------------- natures, familles, rubriques
CREATE TABLE nature (
  code TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  sort_order INTEGER NOT NULL
);
CREATE TABLE nature_direction (
  nature TEXT NOT NULL REFERENCES nature(code),
  direction TEXT NOT NULL CHECK (direction IN ('revenu','depense','technique')),
  PRIMARY KEY (nature, direction)
);

CREATE TABLE family (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  direction TEXT NOT NULL CHECK (direction IN ('revenu','depense','technique')),
  visible INTEGER NOT NULL DEFAULT 1 CHECK (visible IN (0,1)),
  is_system INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0,1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  UNIQUE (direction, name)
);

CREATE TABLE rubrique (
  id INTEGER PRIMARY KEY,
  family_id INTEGER NOT NULL REFERENCES family(id),
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  ref TEXT NOT NULL UNIQUE CHECK (ref GLOB '[A-Z]*' AND ref NOT GLOB '*[^A-Z0-9_.]*'),
  available_for_entry INTEGER NOT NULL DEFAULT 1 CHECK (available_for_entry IN (0,1)),
  visible INTEGER NOT NULL DEFAULT 1 CHECK (visible IN (0,1)),
  is_system INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0,1)),
  estimation_method TEXT NOT NULL DEFAULT 'budget' CHECK (estimation_method IN ('budget','prorata','moyenne')),
  estimation_n INTEGER NOT NULL DEFAULT 3 CHECK (estimation_n BETWEEN 1 AND 24),
  default_account_id INTEGER REFERENCES account(id),
  sort_order INTEGER NOT NULL DEFAULT 0,
  UNIQUE (family_id, name)
);

-- ---------------------------------------------------------------- taux
CREATE TABLE fx_rate (
  rate_date TEXT PRIMARY KEY CHECK (date(rate_date) = rate_date),
  eur_chf_e6 INTEGER NOT NULL CHECK (eur_chf_e6 > 0),
  source TEXT NOT NULL CHECK (source IN ('manuel','csv','bce')),
  updated_at TEXT NOT NULL
);

-- ---------------------------------------------------------------- import (référencé par movement)
CREATE TABLE import_batch (
  id INTEGER PRIMARY KEY,
  imported_at TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_sha256 TEXT NOT NULL,
  file_kind TEXT NOT NULL CHECK (file_kind IN ('csv','xlsx')),
  format_version TEXT NOT NULL,
  account_ids_json TEXT NOT NULL DEFAULT '[]',
  period_from TEXT,
  period_to TEXT,
  rows_total INTEGER NOT NULL DEFAULT 0,
  rows_imported INTEGER NOT NULL DEFAULT 0,
  rows_excluded INTEGER NOT NULL DEFAULT 0,
  rows_flagged INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'integre' CHECK (status IN ('integre','annule')),
  cancelled_at TEXT
);

-- ---------------------------------------------------------------- mouvements (synthétique + détaillé)
CREATE TABLE transfer (
  id INTEGER PRIMARY KEY,
  reference TEXT
);

CREATE TABLE movement (
  id INTEGER PRIMARY KEY,
  granularity TEXT NOT NULL CHECK (granularity IN ('operation','total')),
  account_id INTEGER REFERENCES account(id),
  op_date TEXT CHECK (op_date IS NULL OR date(op_date) = op_date),
  value_date TEXT CHECK (value_date IS NULL OR date(value_date) = value_date),
  period_month TEXT NOT NULL CHECK (period_month GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]' AND substr(period_month,6,2) BETWEEN '01' AND '12'),
  amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL CHECK (currency IN ('EUR','CHF')),
  nature TEXT NOT NULL REFERENCES nature(code),
  rubrique_id INTEGER NOT NULL REFERENCES rubrique(id),
  label_original TEXT,
  label_simple TEXT,
  bank_id TEXT,
  comment TEXT NOT NULL DEFAULT '',
  classification TEXT NOT NULL DEFAULT 'confirme' CHECK (classification IN ('a_verifier','confirme')),
  transfer_id INTEGER REFERENCES transfer(id),
  transfer_role TEXT CHECK (transfer_role IN ('sortie','entree','frais')),
  import_batch_id INTEGER REFERENCES import_batch(id),
  import_row INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  CHECK ((granularity = 'operation' AND account_id IS NOT NULL AND op_date IS NOT NULL
          AND period_month = substr(op_date, 1, 7))
      OR (granularity = 'total' AND account_id IS NULL AND op_date IS NULL AND value_date IS NULL
          AND bank_id IS NULL AND transfer_id IS NULL)),
  CHECK ((transfer_id IS NULL) = (transfer_role IS NULL))
);
CREATE UNIQUE INDEX ux_movement_bank_id ON movement(account_id, bank_id)
  WHERE bank_id IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX ux_movement_transfer_role ON movement(transfer_id, transfer_role)
  WHERE transfer_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX ix_movement_account_date ON movement(account_id, op_date);
CREATE INDEX ix_movement_rubrique_month ON movement(rubrique_id, period_month);
CREATE INDEX ix_movement_batch ON movement(import_batch_id);

CREATE TRIGGER trg_movement_currency_ins BEFORE INSERT ON movement
WHEN NEW.account_id IS NOT NULL
 AND NEW.currency <> (SELECT currency FROM account WHERE id = NEW.account_id)
BEGIN SELECT RAISE(ABORT, 'devise de l''opération différente de la devise du compte'); END;

CREATE TRIGGER trg_movement_currency_upd BEFORE UPDATE OF currency, account_id ON movement
WHEN NEW.account_id IS NOT NULL
 AND NEW.currency <> (SELECT currency FROM account WHERE id = NEW.account_id)
BEGIN SELECT RAISE(ABORT, 'devise de l''opération différente de la devise du compte'); END;

CREATE TRIGGER trg_movement_nature_ins BEFORE INSERT ON movement
WHEN NOT EXISTS (
  SELECT 1 FROM rubrique r JOIN family f ON f.id = r.family_id
  JOIN nature_direction nd ON nd.direction = f.direction AND nd.nature = NEW.nature
  WHERE r.id = NEW.rubrique_id)
BEGIN SELECT RAISE(ABORT, 'nature incompatible avec la rubrique'); END;

CREATE TRIGGER trg_movement_nature_upd BEFORE UPDATE OF nature, rubrique_id ON movement
WHEN NOT EXISTS (
  SELECT 1 FROM rubrique r JOIN family f ON f.id = r.family_id
  JOIN nature_direction nd ON nd.direction = f.direction AND nd.nature = NEW.nature
  WHERE r.id = NEW.rubrique_id)
BEGIN SELECT RAISE(ABORT, 'nature incompatible avec la rubrique'); END;

-- une rubrique ne peut pas changer de famille de direction différente si des mouvements l'utilisent
CREATE TRIGGER trg_rubrique_family_upd BEFORE UPDATE OF family_id ON rubrique
WHEN (SELECT direction FROM family WHERE id = NEW.family_id) <> (SELECT direction FROM family WHERE id = OLD.family_id)
 AND EXISTS (SELECT 1 FROM movement WHERE rubrique_id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'rubrique utilisée : changement de sens (revenu/dépense) interdit'); END;

CREATE TABLE coverage_decision (
  id INTEGER PRIMARY KEY,
  rubrique_id INTEGER NOT NULL REFERENCES rubrique(id),
  period_month TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('total_remplace','detail_remplace','complement')),
  decided_at TEXT NOT NULL,
  UNIQUE (rubrique_id, period_month)
);

CREATE TABLE month_status (
  period_month TEXT PRIMARY KEY,
  closed_at TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT ''
);

-- ---------------------------------------------------------------- engagements
CREATE TABLE recurrence (
  id INTEGER PRIMARY KEY,
  label TEXT NOT NULL CHECK (length(trim(label)) > 0),
  nature TEXT NOT NULL REFERENCES nature(code),
  rubrique_id INTEGER NOT NULL REFERENCES rubrique(id),
  planned_account_id INTEGER REFERENCES account(id),
  end_date TEXT CHECK (end_date IS NULL OR date(end_date) = end_date),
  created_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE recurrence_version (
  id INTEGER PRIMARY KEY,
  recurrence_id INTEGER NOT NULL REFERENCES recurrence(id),
  valid_from TEXT NOT NULL CHECK (date(valid_from) = valid_from),
  valid_to TEXT CHECK (valid_to IS NULL OR (date(valid_to) = valid_to AND valid_to >= valid_from)),
  amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL CHECK (currency IN ('EUR','CHF')),
  frequency TEXT NOT NULL CHECK (frequency IN ('mensuelle','trimestrielle','semestrielle','annuelle','personnalisee')),
  interval_months INTEGER NOT NULL DEFAULT 1 CHECK (interval_months BETWEEN 1 AND 120),
  day_of_month INTEGER NOT NULL CHECK (day_of_month BETWEEN 1 AND 31),
  months_mask INTEGER CHECK (months_mask IS NULL OR months_mask BETWEEN 1 AND 4095),
  change_kind TEXT NOT NULL CHECK (change_kind IN ('creation','evolution')),
  created_at TEXT NOT NULL,
  CHECK ((frequency = 'personnalisee') = (months_mask IS NOT NULL))
);

CREATE TRIGGER trg_recurrence_version_overlap_ins BEFORE INSERT ON recurrence_version
WHEN EXISTS (SELECT 1 FROM recurrence_version v WHERE v.recurrence_id = NEW.recurrence_id
  AND v.valid_from <= COALESCE(NEW.valid_to, '9999-12-31')
  AND NEW.valid_from <= COALESCE(v.valid_to, '9999-12-31'))
BEGIN SELECT RAISE(ABORT, 'versions de récurrence qui se chevauchent'); END;

CREATE TRIGGER trg_recurrence_version_overlap_upd BEFORE UPDATE OF valid_from, valid_to ON recurrence_version
WHEN EXISTS (SELECT 1 FROM recurrence_version v WHERE v.recurrence_id = NEW.recurrence_id AND v.id <> NEW.id
  AND v.valid_from <= COALESCE(NEW.valid_to, '9999-12-31')
  AND NEW.valid_from <= COALESCE(v.valid_to, '9999-12-31'))
BEGIN SELECT RAISE(ABORT, 'versions de récurrence qui se chevauchent'); END;

CREATE TABLE occurrence_override (
  recurrence_id INTEGER NOT NULL REFERENCES recurrence(id),
  due_date TEXT NOT NULL CHECK (date(due_date) = due_date),
  action TEXT NOT NULL CHECK (action IN ('annulee','montant','date')),
  amount_minor INTEGER,
  new_date TEXT CHECK (new_date IS NULL OR date(new_date) = new_date),
  PRIMARY KEY (recurrence_id, due_date),
  CHECK ((action = 'montant') = (amount_minor IS NOT NULL)),
  CHECK ((action = 'date') = (new_date IS NOT NULL))
);

CREATE TABLE fund (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('reserve','projet')),
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  target_minor INTEGER CHECK (target_minor IS NULL OR target_minor >= 0),
  currency TEXT NOT NULL DEFAULT 'EUR' CHECK (currency IN ('EUR','CHF')),
  target_date TEXT CHECK (target_date IS NULL OR date(target_date) = target_date),
  status TEXT NOT NULL DEFAULT 'actif' CHECK (status IN ('actif','termine','archive')),
  deleted_at TEXT
);
CREATE UNIQUE INDEX ux_single_reserve ON fund(kind) WHERE kind = 'reserve' AND deleted_at IS NULL;

CREATE TABLE scheduled_item (
  id INTEGER PRIMARY KEY,
  label TEXT NOT NULL CHECK (length(trim(label)) > 0),
  due_date TEXT NOT NULL CHECK (date(due_date) = due_date),
  amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL CHECK (currency IN ('EUR','CHF')),
  nature TEXT NOT NULL REFERENCES nature(code),
  rubrique_id INTEGER NOT NULL REFERENCES rubrique(id),
  planned_account_id INTEGER REFERENCES account(id),
  fund_id INTEGER REFERENCES fund(id),
  status TEXT NOT NULL DEFAULT 'prevue' CHECK (status IN ('prevue','annulee')),
  created_at TEXT NOT NULL,
  deleted_at TEXT
);

-- ---------------------------------------------------------------- crédits
CREATE TABLE loan (
  id INTEGER PRIMARY KEY,
  label TEXT NOT NULL CHECK (length(trim(label)) > 0),
  lender TEXT NOT NULL DEFAULT '',
  currency TEXT NOT NULL CHECK (currency IN ('EUR','CHF')),
  mode TEXT NOT NULL CHECK (mode IN ('simplifie','bancaire','theorique')),
  principal_minor INTEGER CHECK (principal_minor IS NULL OR principal_minor > 0),
  annual_rate_e6 INTEGER CHECK (annual_rate_e6 IS NULL OR annual_rate_e6 >= 0),
  periods INTEGER CHECK (periods IS NULL OR periods > 0),
  frequency TEXT NOT NULL DEFAULT 'mensuelle' CHECK (frequency IN ('mensuelle','trimestrielle','semestrielle','annuelle')),
  first_due_date TEXT NOT NULL CHECK (date(first_due_date) = first_due_date),
  insurance_mode TEXT NOT NULL DEFAULT 'aucune' CHECK (insurance_mode IN ('aucune','montant_fixe','pct_capital_initial','pct_crd')),
  insurance_value INTEGER,
  fees_per_installment_minor INTEGER NOT NULL DEFAULT 0 CHECK (fees_per_installment_minor >= 0),
  fees_initial_minor INTEGER NOT NULL DEFAULT 0 CHECK (fees_initial_minor >= 0),
  simple_installment_minor INTEGER,
  simple_crd_minor INTEGER,
  simple_crd_date TEXT CHECK (simple_crd_date IS NULL OR date(simple_crd_date) = simple_crd_date),
  payment_account_id INTEGER REFERENCES account(id),
  recurrence_id INTEGER REFERENCES recurrence(id),
  status TEXT NOT NULL DEFAULT 'actif' CHECK (status IN ('actif','archive','solde')),
  archived_at TEXT,
  created_at TEXT NOT NULL,
  deleted_at TEXT,
  CHECK (mode <> 'theorique' OR (principal_minor IS NOT NULL AND annual_rate_e6 IS NOT NULL AND periods IS NOT NULL)),
  CHECK (mode <> 'simplifie' OR (simple_installment_minor IS NOT NULL AND simple_crd_minor IS NOT NULL AND simple_crd_date IS NOT NULL))
);

CREATE TABLE loan_installment (
  loan_id INTEGER NOT NULL REFERENCES loan(id),
  seq INTEGER NOT NULL CHECK (seq >= 0),
  due_date TEXT NOT NULL CHECK (date(due_date) = due_date),
  principal_minor INTEGER NOT NULL,
  interest_minor INTEGER NOT NULL,
  insurance_minor INTEGER NOT NULL DEFAULT 0,
  fees_minor INTEGER NOT NULL DEFAULT 0,
  total_minor INTEGER NOT NULL,
  crd_after_minor INTEGER NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('banque','calcule','estime')),
  PRIMARY KEY (loan_id, seq),
  CHECK (total_minor = principal_minor + interest_minor + insurance_minor + fees_minor)
);

CREATE TABLE reconciliation (
  id INTEGER PRIMARY KEY,
  movement_id INTEGER NOT NULL REFERENCES movement(id),
  target_kind TEXT NOT NULL CHECK (target_kind IN ('occurrence','echeance','credit')),
  recurrence_id INTEGER REFERENCES recurrence(id),
  occurrence_date TEXT,
  scheduled_item_id INTEGER REFERENCES scheduled_item(id),
  loan_id INTEGER REFERENCES loan(id),
  installment_seq INTEGER,
  allocated_minor INTEGER NOT NULL,
  closes_target INTEGER NOT NULL DEFAULT 0 CHECK (closes_target IN (0,1)),
  created_at TEXT NOT NULL,
  CHECK ((target_kind = 'occurrence') = (recurrence_id IS NOT NULL AND occurrence_date IS NOT NULL)),
  CHECK ((target_kind = 'echeance') = (scheduled_item_id IS NOT NULL)),
  CHECK ((target_kind = 'credit') = (loan_id IS NOT NULL AND installment_seq IS NOT NULL))
);
CREATE INDEX ix_reconciliation_movement ON reconciliation(movement_id);

-- ---------------------------------------------------------------- budgets
CREATE TABLE budget_plan (
  id INTEGER PRIMARY KEY,
  rubrique_id INTEGER NOT NULL REFERENCES rubrique(id),
  valid_from_month TEXT NOT NULL,
  valid_to_month TEXT CHECK (valid_to_month IS NULL OR valid_to_month >= valid_from_month),
  monthly_minor INTEGER NOT NULL CHECK (monthly_minor >= 0),
  currency TEXT NOT NULL DEFAULT 'EUR' CHECK (currency IN ('EUR','CHF'))
);
CREATE TRIGGER trg_budget_plan_overlap BEFORE INSERT ON budget_plan
WHEN EXISTS (SELECT 1 FROM budget_plan p WHERE p.rubrique_id = NEW.rubrique_id
  AND p.valid_from_month <= COALESCE(NEW.valid_to_month, '9999-12')
  AND NEW.valid_from_month <= COALESCE(p.valid_to_month, '9999-12'))
BEGIN SELECT RAISE(ABORT, 'plans de budget qui se chevauchent'); END;

CREATE TABLE budget_month (
  id INTEGER PRIMARY KEY,
  rubrique_id INTEGER NOT NULL REFERENCES rubrique(id),
  period_month TEXT NOT NULL,
  initial_minor INTEGER NOT NULL CHECK (initial_minor >= 0),
  actualise_minor INTEGER CHECK (actualise_minor IS NULL OR actualise_minor >= 0),
  currency TEXT NOT NULL DEFAULT 'EUR' CHECK (currency IN ('EUR','CHF')),
  UNIQUE (rubrique_id, period_month)
);

-- ---------------------------------------------------------------- fonds
CREATE TABLE fund_allocation (
  id INTEGER PRIMARY KEY,
  fund_id INTEGER NOT NULL REFERENCES fund(id),
  alloc_date TEXT NOT NULL CHECK (date(alloc_date) = alloc_date),
  amount_minor INTEGER NOT NULL CHECK (amount_minor <> 0),
  note TEXT NOT NULL DEFAULT ''
);
CREATE TABLE fund_plan (
  id INTEGER PRIMARY KEY,
  fund_id INTEGER NOT NULL REFERENCES fund(id),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  frequency TEXT NOT NULL CHECK (frequency IN ('mensuelle','trimestrielle','semestrielle','annuelle')),
  start_date TEXT NOT NULL CHECK (date(start_date) = start_date),
  end_date TEXT CHECK (end_date IS NULL OR end_date >= start_date)
);
CREATE TABLE fund_consumption (
  id INTEGER PRIMARY KEY,
  fund_id INTEGER NOT NULL REFERENCES fund(id),
  movement_id INTEGER NOT NULL REFERENCES movement(id),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  UNIQUE (fund_id, movement_id)
);

-- ---------------------------------------------------------------- patrimoine
CREATE TABLE asset (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('immobilier','autre')),
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  currency TEXT NOT NULL CHECK (currency IN ('EUR','CHF')),
  ownership_pct_e2 INTEGER NOT NULL DEFAULT 10000 CHECK (ownership_pct_e2 BETWEEN 1 AND 10000),
  status TEXT NOT NULL DEFAULT 'actif' CHECK (status IN ('actif','archive')),
  deleted_at TEXT
);
CREATE TABLE asset_valuation (
  asset_id INTEGER NOT NULL REFERENCES asset(id),
  valuation_date TEXT NOT NULL CHECK (date(valuation_date) = valuation_date),
  value_minor INTEGER NOT NULL CHECK (value_minor >= 0),
  source TEXT NOT NULL DEFAULT 'declaration',
  PRIMARY KEY (asset_id, valuation_date)
);
CREATE TABLE scenario (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL UNIQUE CHECK (kind IN ('prudent','central','favorable')),
  params_json TEXT NOT NULL
);

-- ---------------------------------------------------------------- import : provenance ligne à ligne
CREATE TABLE import_row (
  batch_id INTEGER NOT NULL REFERENCES import_batch(id),
  row_no INTEGER NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('importee','exclue','signalee')),
  reason TEXT,
  movement_id INTEGER REFERENCES movement(id),
  raw_json TEXT NOT NULL,
  PRIMARY KEY (batch_id, row_no)
);

-- ---------------------------------------------------------------- journal
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  actor TEXT NOT NULL,
  action_group TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('create','update','delete','restore','move')),
  summary TEXT NOT NULL DEFAULT '',
  before_json TEXT,
  after_json TEXT
);
CREATE INDEX ix_audit_entity ON audit_log(entity, entity_id);
CREATE INDEX ix_audit_group ON audit_log(action_group);
