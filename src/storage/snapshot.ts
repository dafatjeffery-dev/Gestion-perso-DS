// Chargement de toutes les données du foyer en mémoire pour le moteur (lecture seule).

import type { Snapshot } from '../domain/types';
import type { Driver } from './driver';

const TABLES: Record<Exclude<keyof Snapshot, 'household'>, string> = {
  persons: 'SELECT * FROM person ORDER BY role',
  accounts: 'SELECT * FROM account ORDER BY sort_order, id',
  balanceRefs: 'SELECT * FROM balance_reference ORDER BY account_id, ref_date',
  natures: 'SELECT * FROM nature ORDER BY sort_order',
  families: 'SELECT * FROM family ORDER BY sort_order, id',
  rubriques: 'SELECT * FROM rubrique ORDER BY family_id, sort_order, id',
  fxRates: 'SELECT * FROM fx_rate ORDER BY rate_date',
  movements: 'SELECT * FROM movement WHERE deleted_at IS NULL ORDER BY period_month, op_date, id',
  coverage: 'SELECT * FROM coverage_decision',
  monthStatus: 'SELECT * FROM month_status',
  transfers: 'SELECT * FROM transfer',
  recurrences: 'SELECT * FROM recurrence WHERE deleted_at IS NULL',
  recurrenceVersions:
    'SELECT v.* FROM recurrence_version v JOIN recurrence r ON r.id = v.recurrence_id WHERE r.deleted_at IS NULL ORDER BY v.recurrence_id, v.valid_from',
  overrides: 'SELECT * FROM occurrence_override',
  scheduled: 'SELECT * FROM scheduled_item WHERE deleted_at IS NULL',
  loans: 'SELECT * FROM loan WHERE deleted_at IS NULL',
  installments:
    'SELECT i.* FROM loan_installment i JOIN loan l ON l.id = i.loan_id WHERE l.deleted_at IS NULL ORDER BY i.loan_id, i.seq',
  reconciliations:
    'SELECT c.* FROM reconciliation c JOIN movement m ON m.id = c.movement_id WHERE m.deleted_at IS NULL',
  budgetPlans: 'SELECT * FROM budget_plan',
  budgetMonths: 'SELECT * FROM budget_month',
  funds: 'SELECT * FROM fund WHERE deleted_at IS NULL',
  fundAllocations: 'SELECT a.* FROM fund_allocation a JOIN fund f ON f.id = a.fund_id WHERE f.deleted_at IS NULL',
  fundPlans: 'SELECT p.* FROM fund_plan p JOIN fund f ON f.id = p.fund_id WHERE f.deleted_at IS NULL',
  fundConsumptions:
    'SELECT c.* FROM fund_consumption c JOIN movement m ON m.id = c.movement_id WHERE m.deleted_at IS NULL',
  assets: 'SELECT * FROM asset WHERE deleted_at IS NULL',
  assetValuations: 'SELECT * FROM asset_valuation ORDER BY asset_id, valuation_date',
  scenarios: 'SELECT * FROM scenario',
  importBatches: 'SELECT * FROM import_batch ORDER BY id',
};

export async function loadSnapshot(driver: Driver): Promise<Snapshot> {
  const [household] = await driver.query('SELECT * FROM household WHERE id = 1');
  const out: Record<string, unknown> = { household };
  await Promise.all(
    Object.entries(TABLES).map(async ([key, sql]) => {
      out[key] = await driver.query(sql);
    }),
  );
  return out as unknown as Snapshot;
}
