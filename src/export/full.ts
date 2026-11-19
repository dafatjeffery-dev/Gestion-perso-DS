// Export complet (JSON versionné, réimportable) et réimport dans une base remise à zéro.

import type { Driver, Row, SqlParam, Stmt } from '../storage/driver';

export const EXPORT_FORMAT = 'ds-finances-export';
export const EXPORT_VERSION = 1;

/** Tables dans l'ordre des dépendances (parents d'abord). */
export const TABLE_ORDER = [
  'household', 'person', 'setting', 'account', 'balance_reference', 'nature', 'nature_direction', 'family', 'rubrique', 'fx_rate',
  'import_batch', 'transfer', 'movement', 'coverage_decision', 'month_status', 'recurrence', 'recurrence_version', 'occurrence_override',
  'fund', 'scheduled_item', 'loan', 'loan_installment', 'reconciliation', 'budget_plan', 'budget_month', 'fund_allocation', 'fund_plan',
  'fund_consumption', 'asset', 'asset_valuation', 'scenario', 'import_row', 'audit_log',
] as const;

export interface FullExport {
  format: typeof EXPORT_FORMAT;
  version: number;
  schema_version: number;
  exported_at: string;
  tables: Record<string, Row[]>;
}

export async function exportFull(driver: Driver): Promise<FullExport> {
  const [v] = await driver.query('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations');
  const tables: Record<string, Row[]> = {};
  for (const t of TABLE_ORDER) tables[t] = await driver.query(`SELECT * FROM ${t}`);
  return { format: EXPORT_FORMAT, version: EXPORT_VERSION, schema_version: Number(v!.v), exported_at: new Date().toISOString(), tables };
}

export interface ImportCheck {
  ok: boolean;
  errors: string[];
  counts: Record<string, number>;
}

export async function checkFullExport(driver: Driver, data: unknown): Promise<ImportCheck> {
  const errors: string[] = [];
  const d = data as Partial<FullExport>;
  if (!d || d.format !== EXPORT_FORMAT) errors.push('Ce fichier n’est pas un export complet DS Finances.');
  else {
    if (d.version !== EXPORT_VERSION) errors.push(`Version d’export ${String(d.version)} non prise en charge (attendue : ${EXPORT_VERSION}).`);
    const [v] = await driver.query('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations');
    if (Number(d.schema_version) > Number(v!.v)) errors.push(`Export issu d’une version plus récente de l’application (schéma ${d.schema_version}).`);
    if (Number(d.schema_version) < Number(v!.v)) errors.push(`Export au schéma ${d.schema_version}, l’application est au schéma ${v!.v} : restaurez plutôt une sauvegarde (migrée automatiquement).`);
    for (const t of TABLE_ORDER) if (!Array.isArray(d.tables?.[t])) errors.push(`Table « ${t} » absente de l’export.`);
  }
  const counts = Object.fromEntries(TABLE_ORDER.map((t) => [t, d?.tables?.[t]?.length ?? 0]));
  return { ok: errors.length === 0, errors, counts };
}

/**
 * Remplace TOUTES les données par celles de l'export, en une transaction. À n'appeler qu'après
 * une sauvegarde de l'état courant (« nouveau départ »).
 */
export async function importFull(driver: Driver, data: FullExport): Promise<void> {
  const check = await checkFullExport(driver, data);
  if (!check.ok) throw new Error(check.errors.join(' '));
  const plan: Stmt[] = [];
  for (const t of [...TABLE_ORDER].reverse()) plan.push({ sql: `DELETE FROM ${t}`, params: [] });
  for (const t of TABLE_ORDER) {
    for (const row of data.tables[t]!) {
      const cols = Object.keys(row);
      plan.push({ sql: `INSERT INTO ${t} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, params: cols.map((c) => row[c] as SqlParam) });
    }
  }
  await driver.apply(plan);
}
