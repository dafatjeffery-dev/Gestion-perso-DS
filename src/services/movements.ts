// Opérations (détail) et totaux mensuels (synthétique) : un seul système, une seule table.
// Règle de couverture, déplacement / duplication sans écrasement silencieux, suppression avec
// dépendances, annulation d'une action à partir du journal.

import { formatDateFr, formatMonthFr, isValidIsoDate, monthOf } from '../domain/dates';
import { formatMoney } from '../domain/money';
import type { CoverageMode, Currency, IsoDate, Month, Movement, NatureCode, Snapshot } from '../domain/types';
import type { Driver, SqlParam } from '../storage/driver';
import { Plan, ValidationError, fail, type FieldError, type Actor } from './plan';

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export const COVERAGE_LABEL: Record<CoverageMode, string> = {
  total_remplace: 'Le total remplace le détail (les opérations restent dans les soldes des comptes)',
  detail_remplace: 'Le détail remplace le total (le total est conservé, marqué « remplacé »)',
  complement: 'Le total devient un « complément non détaillé » qui s’ajoute au détail',
};

/** Levée quand une écriture ferait coexister opérations et total sans décision explicite. */
export class CoverageRequired extends Error {
  constructor(
    readonly rubrique_id: number,
    readonly month: Month,
    readonly operations: number,
    readonly totals: number,
    rubriqueName: string,
  ) {
    super(
      `« ${rubriqueName} » en ${formatMonthFr(month)} aurait ${operations} opération(s) et ${totals} total(aux). ` +
        'Choisissez comment les compter : le total remplace le détail, le détail remplace le total, ou le total est un complément.',
    );
    this.name = 'CoverageRequired';
  }
}

function rubriqueInfo(snap: Snapshot, id: number) {
  const r = snap.rubriques.find((x) => x.id === id);
  if (!r) fail('rubrique_id', `Rubrique introuvable (n° ${id})`);
  const f = snap.families.find((x) => x.id === r.family_id)!;
  return { r, f };
}

const NATURES_BY_DIRECTION: Record<string, NatureCode[]> = {
  revenu: ['revenu_ordinaire', 'revenu_exceptionnel'],
  depense: ['depense', 'remboursement_depense', 'cout_credit', 'frais_transfert'],
  technique: ['transfert', 'emprunt_recu', 'capital_credit', 'epargne', 'a_classer'],
};

export function checkNature(snap: Snapshot, rubriqueId: number, nature: NatureCode, errs: FieldError[]): void {
  const { r, f } = rubriqueInfo(snap, rubriqueId);
  if (!NATURES_BY_DIRECTION[f.direction]!.includes(nature)) {
    const label = snap.natures.find((n) => n.code === nature)?.label ?? nature;
    errs.push({ field: 'nature', message: `La nature « ${label} » n’est pas compatible avec la rubrique « ${r.name} » (famille ${f.name})` });
  }
}

function coverageState(snap: Snapshot, rubriqueId: number, month: Month, extra: { ops?: number; totals?: number; excludeIds?: number[] } = {}) {
  const ex = new Set(extra.excludeIds ?? []);
  const ms = snap.movements.filter((m) => m.rubrique_id === rubriqueId && m.period_month === month && !ex.has(m.id));
  const ops = ms.filter((m) => m.granularity === 'operation').length + (extra.ops ?? 0);
  const totals = ms.filter((m) => m.granularity === 'total').length + (extra.totals ?? 0);
  const decision = snap.coverage.find((d) => d.rubrique_id === rubriqueId && d.period_month === month) ?? null;
  return { ops, totals, decision, needs: ops > 0 && totals > 0 && !decision };
}

function addCoverage(p: Plan, snap: Snapshot, rubriqueId: number, month: Month, mode: CoverageMode | undefined, extra: Parameters<typeof coverageState>[3]) {
  const st = coverageState(snap, rubriqueId, month, extra);
  if (!st.needs) return;
  if (!mode) throw new CoverageRequired(rubriqueId, month, st.ops, st.totals, rubriqueInfo(snap, rubriqueId).r.name);
  p.insert('coverage_decision', { rubrique_id: rubriqueId, period_month: month, mode, decided_at: p.ts }, `Couverture ${formatMonthFr(month)} : ${COVERAGE_LABEL[mode]}`);
}

// ------------------------------------------------------------------ opérations

export interface OperationInput {
  account_id: number;
  op_date: IsoDate;
  value_date?: IsoDate | null;
  amount_minor: number;
  nature: NatureCode;
  rubrique_id: number;
  label_original?: string | null;
  label_simple?: string | null;
  bank_id?: string | null;
  comment?: string;
  classification?: 'a_verifier' | 'confirme';
}

export function validateOperation(snap: Snapshot, input: OperationInput, opts: { isNew: boolean }): FieldError[] {
  const errs: FieldError[] = [];
  const acc = snap.accounts.find((a) => a.id === input.account_id);
  if (!acc) errs.push({ field: 'account_id', message: 'Compte introuvable' });
  else if (opts.isNew && acc.status === 'archive') errs.push({ field: 'account_id', message: `Le compte « ${acc.name} » est archivé : il n’est plus proposé pour de nouvelles saisies (réactivez-le si besoin)` });
  if (!isValidIsoDate(input.op_date)) errs.push({ field: 'op_date', message: 'Date d’opération invalide' });
  if (input.value_date && !isValidIsoDate(input.value_date)) errs.push({ field: 'value_date', message: 'Date de valeur invalide' });
  if (!Number.isSafeInteger(input.amount_minor)) errs.push({ field: 'amount_minor', message: 'Montant invalide' });
  const r = snap.rubriques.find((x) => x.id === input.rubrique_id);
  if (!r) errs.push({ field: 'rubrique_id', message: 'Rubrique introuvable' });
  else {
    if (opts.isNew && !r.available_for_entry) errs.push({ field: 'rubrique_id', message: `La rubrique « ${r.name} » n’est plus proposée pour de nouvelles saisies` });
    checkNature(snap, r.id, input.nature, errs);
  }
  if (input.bank_id && acc && snap.movements.some((m) => m.account_id === acc.id && m.bank_id === input.bank_id))
    errs.push({ field: 'bank_id', message: `L’identifiant bancaire « ${input.bank_id} » existe déjà sur ce compte` });
  return errs;
}

export function operationValues(snap: Snapshot, input: OperationInput, ts: string, extra: Record<string, SqlParam> = {}): Record<string, SqlParam> {
  const acc = snap.accounts.find((a) => a.id === input.account_id)!;
  return {
    granularity: 'operation',
    account_id: input.account_id,
    op_date: input.op_date,
    value_date: input.value_date ?? null,
    period_month: monthOf(input.op_date),
    amount_minor: input.amount_minor,
    currency: acc.currency,
    nature: input.nature,
    rubrique_id: input.rubrique_id,
    label_original: input.label_original ?? null,
    label_simple: input.label_simple ?? null,
    bank_id: input.bank_id ?? null,
    comment: input.comment ?? '',
    classification: input.classification ?? 'confirme',
    created_at: ts,
    updated_at: ts,
    ...extra,
  };
}

export async function createOperation(driver: Driver, snap: Snapshot, input: OperationInput, opts: { coverage?: CoverageMode; actor?: Actor } = {}): Promise<number> {
  const errs = validateOperation(snap, input, { isNew: true });
  if (errs.length) throw new ValidationError(errs);
  const p = new Plan(opts.actor);
  addCoverage(p, snap, input.rubrique_id, monthOf(input.op_date), opts.coverage, { ops: 1 });
  const ref = p.insert('movement', operationValues(snap, input, p.ts), `Opération du ${formatDateFr(input.op_date)} : ${formatMoney(input.amount_minor, snap.accounts.find((a) => a.id === input.account_id)!.currency)}`);
  return Plan.id(await p.run(driver), ref);
}

const EDITABLE_OP = ['op_date', 'value_date', 'amount_minor', 'nature', 'rubrique_id', 'label_simple', 'comment', 'classification', 'account_id'] as const;

/** Modifier une opération. Le libellé bancaire original n'est jamais réécrit. */
export async function updateOperation(
  driver: Driver,
  snap: Snapshot,
  id: number,
  patch: Partial<Pick<OperationInput, (typeof EDITABLE_OP)[number]>>,
  opts: { coverage?: CoverageMode } = {},
): Promise<void> {
  const m = snap.movements.find((x) => x.id === id && x.granularity === 'operation');
  if (!m) fail('id', 'Opération introuvable');
  if (m.transfer_id && (patch.amount_minor !== undefined || patch.account_id !== undefined || patch.nature !== undefined))
    fail('transfer', 'Cette opération fait partie d’un transfert : modifiez le transfert lui-même');
  const merged: OperationInput = {
    account_id: patch.account_id ?? m.account_id!,
    op_date: patch.op_date ?? m.op_date!,
    value_date: patch.value_date === undefined ? m.value_date : patch.value_date,
    amount_minor: patch.amount_minor ?? m.amount_minor,
    nature: patch.nature ?? m.nature,
    rubrique_id: patch.rubrique_id ?? m.rubrique_id,
  };
  const errs = validateOperation({ ...snap, movements: snap.movements.filter((x) => x.id !== id) }, merged, { isNew: false });
  if (patch.account_id !== undefined && patch.account_id !== m.account_id) {
    const to = snap.accounts.find((a) => a.id === patch.account_id);
    if (to && to.currency !== m.currency) errs.push({ field: 'account_id', message: `Le compte « ${to.name} » est en ${to.currency} : la devise d’une opération ne change jamais automatiquement` });
  }
  if (errs.length) throw new ValidationError(errs);
  const p = new Plan();
  const month = monthOf(merged.op_date);
  if (month !== m.period_month || merged.rubrique_id !== m.rubrique_id) {
    addCoverage(p, snap, merged.rubrique_id, month, opts.coverage, { ops: 1, excludeIds: [id] });
  }
  const changes: Record<string, SqlParam> = {};
  for (const k of EDITABLE_OP) if (patch[k] !== undefined && patch[k] !== m[k]) changes[k] = patch[k] as SqlParam;
  if (changes.op_date) changes.period_month = month;
  if (Object.keys(changes).length === 0) return;
  changes.updated_at = p.ts;
  p.update('movement', id, m as unknown as Record<string, unknown>, changes, `Opération du ${formatDateFr(m.op_date!)} modifiée`);
  await p.run(driver);
}

// ------------------------------------------------------------------ totaux synthétiques

export interface TotalInput {
  rubrique_id: number;
  period_month: Month;
  amount_minor: number;
  currency: Currency;
  nature: NatureCode;
  comment?: string;
  label_simple?: string | null;
}

export function validateTotal(snap: Snapshot, input: TotalInput, opts: { isNew: boolean }): FieldError[] {
  const errs: FieldError[] = [];
  if (!MONTH_RE.test(input.period_month)) errs.push({ field: 'period_month', message: 'Mois invalide (AAAA-MM)' });
  if (!Number.isSafeInteger(input.amount_minor)) errs.push({ field: 'amount_minor', message: 'Montant invalide' });
  if (!['EUR', 'CHF'].includes(input.currency)) errs.push({ field: 'currency', message: 'Devise : EUR ou CHF' });
  const r = snap.rubriques.find((x) => x.id === input.rubrique_id);
  if (!r) errs.push({ field: 'rubrique_id', message: 'Rubrique introuvable' });
  else {
    if (opts.isNew && !r.available_for_entry) errs.push({ field: 'rubrique_id', message: `La rubrique « ${r.name} » n’est plus proposée pour de nouvelles saisies` });
    checkNature(snap, r.id, input.nature, errs);
    if (['transfert', 'emprunt_recu', 'capital_credit'].includes(input.nature))
      errs.push({ field: 'nature', message: 'Un total mensuel ne peut pas représenter un transfert, un emprunt ou du capital : ces mouvements concernent des comptes' });
  }
  return errs;
}

/** Note affichée au moment de la saisie d'un total. */
export const TOTAL_NOTICE = 'Ce total n’est rattaché à aucun compte : il n’agit pas sur les soldes bancaires.';

export async function createTotal(driver: Driver, snap: Snapshot, input: TotalInput, opts: { coverage?: CoverageMode } = {}): Promise<number> {
  const errs = validateTotal(snap, input, { isNew: true });
  if (errs.length) throw new ValidationError(errs);
  const p = new Plan();
  addCoverage(p, snap, input.rubrique_id, input.period_month, opts.coverage, { totals: 1 });
  const ref = p.insert('movement', totalValues(input, p.ts), `Total ${formatMonthFr(input.period_month)} : ${formatMoney(input.amount_minor, input.currency)}`);
  return Plan.id(await p.run(driver), ref);
}

function totalValues(input: TotalInput, ts: string): Record<string, SqlParam> {
  return {
    granularity: 'total',
    account_id: null,
    op_date: null,
    period_month: input.period_month,
    amount_minor: input.amount_minor,
    currency: input.currency,
    nature: input.nature,
    rubrique_id: input.rubrique_id,
    label_simple: input.label_simple ?? null,
    comment: input.comment ?? '',
    classification: 'confirme',
    created_at: ts,
    updated_at: ts,
  };
}

function getTotal(snap: Snapshot, id: number): Movement {
  const m = snap.movements.find((x) => x.id === id && x.granularity === 'total');
  if (!m) fail('id', 'Total introuvable');
  return m;
}

/** MODIFIER : corrige l'enregistrement existant (montant, devise, nature, commentaire). Ne change pas de période. */
export async function updateTotal(driver: Driver, snap: Snapshot, id: number, patch: Partial<Pick<TotalInput, 'amount_minor' | 'currency' | 'nature' | 'comment' | 'label_simple'>>): Promise<void> {
  const m = getTotal(snap, id);
  const merged: TotalInput = { rubrique_id: m.rubrique_id, period_month: m.period_month, amount_minor: patch.amount_minor ?? m.amount_minor, currency: patch.currency ?? m.currency, nature: patch.nature ?? m.nature };
  const errs = validateTotal(snap, merged, { isNew: false });
  if (errs.length) throw new ValidationError(errs);
  const changes: Record<string, SqlParam> = {};
  for (const k of ['amount_minor', 'currency', 'nature', 'comment', 'label_simple'] as const) if (patch[k] !== undefined && patch[k] !== m[k]) changes[k] = patch[k] as SqlParam;
  if (!Object.keys(changes).length) return;
  const p = new Plan();
  changes.updated_at = p.ts;
  p.update('movement', id, m as unknown as Record<string, unknown>, changes, `Total ${formatMonthFr(m.period_month)} corrigé`);
  await p.run(driver);
}

export type DestinationResolution = 'fusionner' | 'remplacer';

export type MoveOutcome =
  | { kind: 'fait'; group: string; message: string }
  | {
      kind: 'conflit';
      /** Explication à présenter avant toute action. */
      message: string;
      destinationTotals: Movement[];
      destinationOperations: number;
      needsResolution: boolean;
      needsCoverage: boolean;
      options: { resolution?: DestinationResolution[]; coverage?: CoverageMode[] };
    };

/**
 * DÉPLACER (retire de la source) ou DUPLIQUER (sur demande explicite) un total vers un autre mois.
 * En cas de total existant à destination, rien n'est fait sans choix explicite ; l'opération est
 * atomique, tracée en un groupe du journal et réversible par undoGroup().
 */
export async function moveOrDuplicateTotal(
  driver: Driver,
  snap: Snapshot,
  id: number,
  toMonth: Month,
  mode: 'deplacer' | 'dupliquer',
  choice: { resolution?: DestinationResolution; coverage?: CoverageMode } = {},
): Promise<MoveOutcome> {
  const m = getTotal(snap, id);
  if (!MONTH_RE.test(toMonth)) fail('toMonth', 'Mois de destination invalide');
  if (mode === 'deplacer' && toMonth === m.period_month) fail('toMonth', 'Le mois de destination est le mois actuel du total');
  const destTotals = snap.movements.filter((x) => x.granularity === 'total' && x.rubrique_id === m.rubrique_id && x.period_month === toMonth && x.id !== id);
  const destOps = snap.movements.filter((x) => x.granularity === 'operation' && x.rubrique_id === m.rubrique_id && x.period_month === toMonth).length;
  const decision = snap.coverage.find((d) => d.rubrique_id === m.rubrique_id && d.period_month === toMonth);
  const needsResolution = destTotals.length > 0 && !choice.resolution;
  const needsCoverage = destOps > 0 && !decision && !choice.coverage;
  const { r } = rubriqueInfo(snap, m.rubrique_id);
  if (needsResolution || needsCoverage) {
    const parts: string[] = [];
    if (destTotals.length)
      parts.push(`${formatMonthFr(toMonth)} contient déjà un total « ${r.name} » de ${destTotals.map((t) => formatMoney(t.amount_minor, t.currency)).join(', ')}. Fusionner additionne les deux montants dans un seul total ; remplacer met l’ancien total à la corbeille.`);
    if (destOps) parts.push(`${formatMonthFr(toMonth)} contient ${destOps} opération(s) détaillée(s) dans « ${r.name} » : choisissez comment compter le total et le détail.`);
    return {
      kind: 'conflit',
      message: parts.join(' '),
      destinationTotals: destTotals,
      destinationOperations: destOps,
      needsResolution,
      needsCoverage,
      options: { resolution: needsResolution ? ['fusionner', 'remplacer'] : undefined, coverage: needsCoverage ? ['total_remplace', 'detail_remplace', 'complement'] : undefined },
    };
  }
  const p = new Plan();
  const verb = mode === 'deplacer' ? 'déplacé' : 'dupliqué';
  if (destOps > 0 && !decision && choice.coverage) {
    p.insert('coverage_decision', { rubrique_id: m.rubrique_id, period_month: toMonth, mode: choice.coverage, decided_at: p.ts }, `Couverture ${formatMonthFr(toMonth)} : ${COVERAGE_LABEL[choice.coverage]}`);
  }
  if (destTotals.length && choice.resolution === 'fusionner') {
    const target = destTotals[0]!;
    if (target.currency !== m.currency) fail('currency', `Fusion impossible : le total de destination est en ${target.currency}, celui-ci en ${m.currency}`);
    p.update('movement', target.id, target as unknown as Record<string, unknown>, { amount_minor: target.amount_minor + m.amount_minor, updated_at: p.ts }, `Total ${formatMonthFr(toMonth)} : fusion avec le total ${verb} depuis ${formatMonthFr(m.period_month)}`);
    if (mode === 'deplacer') p.update('movement', id, m as unknown as Record<string, unknown>, { deleted_at: p.ts }, `Total ${formatMonthFr(m.period_month)} retiré (fusionné dans ${formatMonthFr(toMonth)})`, { action: 'move' });
  } else {
    if (destTotals.length && choice.resolution === 'remplacer') {
      for (const t of destTotals) p.update('movement', t.id, t as unknown as Record<string, unknown>, { deleted_at: p.ts }, `Total ${formatMonthFr(toMonth)} remplacé (mis à la corbeille)`, { action: 'delete' });
    }
    if (mode === 'deplacer') {
      p.update('movement', id, m as unknown as Record<string, unknown>, { period_month: toMonth, updated_at: p.ts }, `Total ${verb} de ${formatMonthFr(m.period_month)} vers ${formatMonthFr(toMonth)}`, { action: 'move' });
    } else {
      p.insert('movement', totalValues({ ...m, period_month: toMonth, comment: m.comment }, p.ts), `Total ${verb} de ${formatMonthFr(m.period_month)} vers ${formatMonthFr(toMonth)}`);
    }
  }
  await p.run(driver);
  return { kind: 'fait', group: p.group, message: `Total ${verb} vers ${formatMonthFr(toMonth)}.` };
}

// ------------------------------------------------------------------ suppression avec dépendances

export interface Dependencies {
  movements: Movement[];
  reconciliations: Snapshot['reconciliations'];
  fundConsumptions: Snapshot['fundConsumptions'];
  /** Autres jambes de transferts concernés, supprimées avec eux. */
  transferPartners: Movement[];
  /** Explication des conséquences, à présenter avant confirmation. */
  consequences: string[];
}

export function movementDependencies(snap: Snapshot, ids: number[]): Dependencies {
  const set = new Set(ids);
  const movements = snap.movements.filter((m) => set.has(m.id));
  const tids = new Set(movements.map((m) => m.transfer_id).filter((x): x is number => x !== null));
  const transferPartners = snap.movements.filter((m) => m.transfer_id !== null && tids.has(m.transfer_id) && !set.has(m.id));
  const all = new Set([...ids, ...transferPartners.map((m) => m.id)]);
  const reconciliations = snap.reconciliations.filter((r) => all.has(r.movement_id));
  const fundConsumptions = snap.fundConsumptions.filter((c) => all.has(c.movement_id));
  const consequences: string[] = [];
  if (transferPartners.length) consequences.push(`${transferPartners.length} autre(s) opération(s) de transfert lié(es) seront supprimées avec elles (un transfert ne peut pas rester boiteux).`);
  if (reconciliations.length) consequences.push(`${reconciliations.length} rapprochement(s) avec des échéances seront annulés : ces échéances redeviendront « non soldées ».`);
  if (fundConsumptions.length) consequences.push(`${fundConsumptions.length} paiement(s) de projet seront retirés : la réservation correspondante redeviendra disponible.`);
  return { movements, reconciliations, fundConsumptions, transferPartners, consequences };
}

/** Mise à la corbeille, avec traitement explicite des dépendances. */
export async function deleteMovements(driver: Driver, snap: Snapshot, ids: number[], opts: { confirmed: boolean; actor?: Actor }): Promise<{ deleted: number; group: string } | { kind: 'confirmation'; deps: Dependencies }> {
  const deps = movementDependencies(snap, ids);
  if (deps.movements.length !== ids.length) fail('ids', 'Certaines opérations sont introuvables ou déjà supprimées');
  if (!opts.confirmed) return { kind: 'confirmation', deps };
  const p = new Plan(opts.actor);
  for (const r of deps.reconciliations) {
    p.raw('DELETE FROM reconciliation WHERE id = ?', [r.id]);
    p.audit('reconciliation', r.id, 'delete', 'Rapprochement annulé (opération supprimée)', r);
  }
  for (const c of deps.fundConsumptions) {
    p.raw('DELETE FROM fund_consumption WHERE id = ?', [c.id]);
    p.audit('fund_consumption', c.id, 'delete', 'Paiement de projet retiré (opération supprimée)', c);
  }
  for (const m of [...deps.movements, ...deps.transferPartners]) {
    p.update('movement', m.id, m as unknown as Record<string, unknown>, { deleted_at: p.ts }, `${m.granularity === 'total' ? 'Total' : 'Opération'} mis(e) à la corbeille`, { action: 'delete' });
  }
  await p.run(driver);
  return { deleted: deps.movements.length + deps.transferPartners.length, group: p.group };
}

export async function restoreMovement(driver: Driver, id: number): Promise<void> {
  const [m] = await driver.query('SELECT * FROM movement WHERE id = ?', [id]);
  if (!m || m.deleted_at === null) fail('id', 'Rien à restaurer');
  const p = new Plan();
  p.update('movement', id, m as Record<string, unknown>, { deleted_at: null }, 'Restauré depuis la corbeille', { action: 'restore' });
  await p.run(driver);
}

// ------------------------------------------------------------------ annulation d'une action

const SOFT_DELETE_TABLES = new Set(['movement', 'recurrence', 'scheduled_item', 'loan', 'fund', 'asset']);

/**
 * Annule un groupe d'actions du journal (ex. un déplacement de total), si aucune des lignes
 * concernées n'a été modifiée depuis. L'annulation est elle-même journalisée.
 */
export async function undoGroup(driver: Driver, group: string): Promise<{ undone: number }> {
  const rows = await driver.query('SELECT * FROM audit_log WHERE action_group = ? ORDER BY id DESC', [group]);
  if (!rows.length) fail('group', 'Action introuvable dans le journal');
  const maxId = Math.max(...rows.map((r) => Number(r.id)));
  for (const r of rows) {
    const later = await driver.query('SELECT COUNT(*) AS n FROM audit_log WHERE entity = ? AND entity_id = ? AND id > ?', [r.entity as string, r.entity_id as string, maxId]);
    if (Number(later[0]!.n) > 0) fail('group', `Annulation impossible : « ${String(r.summary)} » a été modifié depuis. Corrigez directement l’élément.`);
  }
  const p = new Plan();
  for (const r of rows) {
    const table = String(r.entity);
    if (!/^[a-z_]+$/.test(table)) fail('entity', 'Entité inconnue');
    const idCol = table === 'fx_rate' ? 'rate_date' : 'id';
    const id: string | number = idCol === 'id' ? Number(r.entity_id) : String(r.entity_id);
    const before = r.before_json ? (JSON.parse(String(r.before_json)) as Record<string, SqlParam>) : null;
    const after = r.after_json ? (JSON.parse(String(r.after_json)) as Record<string, SqlParam>) : null;
    if (r.action === 'create') {
      if (SOFT_DELETE_TABLES.has(table)) p.raw(`UPDATE ${table} SET deleted_at = ? WHERE ${idCol} = ?`, [p.ts, id]);
      else p.raw(`DELETE FROM ${table} WHERE ${idCol} = ?`, [id]);
      p.audit(table, id, 'delete', `Annulation : ${String(r.summary)}`, after);
    } else if (before) {
      const exists = await driver.query(`SELECT 1 AS x FROM ${table} WHERE ${idCol} = ?`, [id]);
      if (exists.length) {
        const cols = Object.keys(before);
        p.raw(`UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE ${idCol} = ?`, [...cols.map((c) => before[c]!), id]);
      } else {
        const cols = Object.keys(before);
        p.raw(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map((c) => before[c]!));
      }
      p.audit(table, id, 'restore', `Annulation : ${String(r.summary)}`, after, before);
    }
  }
  await p.run(driver);
  return { undone: rows.length };
}
