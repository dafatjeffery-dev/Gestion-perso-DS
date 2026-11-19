// Engagements : récurrences versionnées, échéances ponctuelles, rapprochement individuel,
// budgets, clôture des mois.

import { addDays, addMonths, formatDateFr, formatMonthFr, isValidIsoDate } from '../domain/dates';
import { formatMoney } from '../domain/money';
import type { Currency, Frequency, IsoDate, Month, NatureCode, RecurrenceVersion, Snapshot } from '../domain/types';
import { buildCtx } from '../engine/context';
import { findExpected } from '../engine/occurrences';
import type { Driver, SqlParam } from '../storage/driver';
import { checkNature } from './movements';
import { Plan, ValidationError, fail, type FieldError } from './plan';

/** Explications courtes affichées à côté des trois actions sur une récurrence. */
export const RECURRENCE_ACTIONS = {
  corriger: 'Corriger : l’erreur était déjà là. La version concernée est modifiée, y compris pour le passé.',
  evoluer: 'Faire évoluer à partir d’une date : une nouvelle version commence ; l’ancienne reste valable avant cette date.',
  arreter: 'Arrêter : la récurrence prend fin à la date indiquée ; elle reste prise en compte jusque-là.',
} as const;

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export interface VersionInput {
  amount_minor: number;
  currency: Currency;
  frequency: Frequency;
  interval_months?: number;
  day_of_month: number;
  months_mask?: number | null;
}

function validateVersion(v: Partial<VersionInput>, errs: FieldError[]) {
  if (v.amount_minor !== undefined && (!Number.isSafeInteger(v.amount_minor) || v.amount_minor === 0)) errs.push({ field: 'amount_minor', message: 'Montant : non nul' });
  if (v.currency !== undefined && !['EUR', 'CHF'].includes(v.currency)) errs.push({ field: 'currency', message: 'Devise : EUR ou CHF' });
  if (v.day_of_month !== undefined && !(v.day_of_month >= 1 && v.day_of_month <= 31)) errs.push({ field: 'day_of_month', message: 'Jour du mois : entre 1 et 31 (31 = dernier jour)' });
  if (v.frequency === 'personnalisee' && !(v.months_mask && v.months_mask > 0 && v.months_mask < 4096)) errs.push({ field: 'months_mask', message: 'Fréquence personnalisée : choisissez au moins un mois' });
  if (v.interval_months !== undefined && !(v.interval_months >= 1 && v.interval_months <= 120)) errs.push({ field: 'interval_months', message: 'Intervalle : 1 à 120 mois' });
}

function versionValues(v: VersionInput): Record<string, SqlParam> {
  return {
    amount_minor: v.amount_minor,
    currency: v.currency,
    frequency: v.frequency,
    interval_months: v.frequency === 'mensuelle' ? (v.interval_months ?? 1) : 1,
    day_of_month: v.day_of_month,
    months_mask: v.frequency === 'personnalisee' ? (v.months_mask ?? null) : null,
  };
}

export interface RecurrenceInput extends VersionInput {
  label: string;
  nature: NatureCode;
  rubrique_id: number;
  planned_account_id?: number | null;
  start_date: IsoDate;
  end_date?: IsoDate | null;
}

export async function createRecurrence(driver: Driver, snap: Snapshot, input: RecurrenceInput): Promise<number> {
  const errs: FieldError[] = [];
  if (!input.label?.trim()) errs.push({ field: 'label', message: 'Libellé : à renseigner' });
  if (!isValidIsoDate(input.start_date)) errs.push({ field: 'start_date', message: 'Date de début invalide' });
  if (input.end_date && (!isValidIsoDate(input.end_date) || input.end_date < input.start_date)) errs.push({ field: 'end_date', message: 'Date de fin invalide ou antérieure au début' });
  validateVersion(input, errs);
  const r = snap.rubriques.find((x) => x.id === input.rubrique_id);
  if (!r) errs.push({ field: 'rubrique_id', message: 'Rubrique introuvable' });
  else {
    if (!r.available_for_entry) errs.push({ field: 'rubrique_id', message: `La rubrique « ${r.name} » n’est plus proposée pour de nouvelles saisies` });
    checkNature(snap, r.id, input.nature, errs);
  }
  if (input.planned_account_id) {
    const a = snap.accounts.find((x) => x.id === input.planned_account_id);
    if (!a) errs.push({ field: 'planned_account_id', message: 'Compte introuvable' });
    else if (a.currency !== input.currency) errs.push({ field: 'planned_account_id', message: `Le compte « ${a.name} » est en ${a.currency}, la récurrence en ${input.currency}` });
  }
  if (errs.length) throw new ValidationError(errs);
  const p = new Plan();
  const ref = p.insert(
    'recurrence',
    { label: input.label.trim(), nature: input.nature, rubrique_id: input.rubrique_id, planned_account_id: input.planned_account_id ?? null, end_date: input.end_date ?? null, created_at: p.ts },
    `Récurrence « ${input.label.trim()} » créée`,
  );
  p.insert('recurrence_version', { recurrence_id: ref, valid_from: input.start_date, valid_to: null, ...versionValues(input), change_kind: 'creation', created_at: p.ts }, `Version du ${formatDateFr(input.start_date)} : ${formatMoney(input.amount_minor, input.currency)}`);
  return Plan.id(await p.run(driver), ref);
}

/** Modifie les informations générales (libellé, compte prévu, rubrique) sans toucher aux montants. */
export async function updateRecurrenceInfo(driver: Driver, snap: Snapshot, id: number, patch: { label?: string; planned_account_id?: number | null; rubrique_id?: number; nature?: NatureCode }): Promise<void> {
  const rec = snap.recurrences.find((r) => r.id === id);
  if (!rec) fail('id', 'Récurrence introuvable');
  const errs: FieldError[] = [];
  if (patch.label !== undefined && !patch.label.trim()) errs.push({ field: 'label', message: 'Libellé : à renseigner' });
  checkNature(snap, patch.rubrique_id ?? rec.rubrique_id, patch.nature ?? rec.nature, errs);
  if (errs.length) throw new ValidationError(errs);
  const p = new Plan();
  const changes: Record<string, SqlParam> = {};
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) changes[k] = typeof v === 'string' && k === 'label' ? v.trim() : (v as SqlParam);
  p.update('recurrence', id, rec as unknown as Record<string, unknown>, changes, `Récurrence « ${rec.label} » modifiée`);
  await p.run(driver);
}

function getVersions(snap: Snapshot, recurrenceId: number): RecurrenceVersion[] {
  return snap.recurrenceVersions.filter((v) => v.recurrence_id === recurrenceId).sort((a, b) => (a.valid_from < b.valid_from ? -1 : 1));
}

/** CORRIGER une version : l'erreur était déjà là. */
export async function correctVersion(driver: Driver, snap: Snapshot, versionId: number, patch: Partial<VersionInput> & { valid_from?: IsoDate }): Promise<void> {
  const v = snap.recurrenceVersions.find((x) => x.id === versionId);
  if (!v) fail('id', 'Version introuvable');
  const errs: FieldError[] = [];
  validateVersion({ ...v, ...patch } as VersionInput, errs);
  if (patch.valid_from !== undefined && !isValidIsoDate(patch.valid_from)) errs.push({ field: 'valid_from', message: 'Date invalide' });
  if (errs.length) throw new ValidationError(errs);
  const merged = { ...v, ...patch } as VersionInput & { valid_from: IsoDate };
  const changes: Record<string, SqlParam> = {};
  const vals = versionValues(merged);
  for (const [k, val] of Object.entries(vals)) if ((v as unknown as Record<string, unknown>)[k] !== val) changes[k] = val;
  if (patch.valid_from && patch.valid_from !== v.valid_from) changes.valid_from = patch.valid_from;
  if (!Object.keys(changes).length) return;
  const rec = snap.recurrences.find((r) => r.id === v.recurrence_id)!;
  const p = new Plan();
  p.update('recurrence_version', versionId, v as unknown as Record<string, unknown>, changes, `Récurrence « ${rec.label} » corrigée (version du ${formatDateFr(v.valid_from)})`);
  await p.run(driver);
}

/** FAIRE ÉVOLUER à partir d'une date : ferme la version en cours la veille et crée une nouvelle version. */
export async function evolveRecurrence(driver: Driver, snap: Snapshot, recurrenceId: number, fromDate: IsoDate, patch: Partial<VersionInput>): Promise<number> {
  const rec = snap.recurrences.find((r) => r.id === recurrenceId);
  if (!rec) fail('id', 'Récurrence introuvable');
  if (!isValidIsoDate(fromDate)) fail('fromDate', 'Date invalide');
  const versions = getVersions(snap, recurrenceId);
  const current = versions.find((v) => v.valid_from <= fromDate && (v.valid_to === null || v.valid_to >= fromDate));
  if (!current) fail('fromDate', `Aucune version n’est en vigueur au ${formatDateFr(fromDate)}`);
  if (current.valid_from === fromDate) fail('fromDate', `Une version commence déjà le ${formatDateFr(fromDate)} : utilisez « Corriger » pour la modifier`);
  if (versions.some((v) => v.valid_from > fromDate)) fail('fromDate', 'Une version plus récente existe déjà : faites évoluer à partir d’une date postérieure, ou corrigez la version suivante');
  if (rec.end_date && rec.end_date < fromDate) fail('fromDate', `La récurrence est arrêtée au ${formatDateFr(rec.end_date)}`);
  const next = { ...current, ...patch } as VersionInput;
  const errs: FieldError[] = [];
  validateVersion(next, errs);
  if (errs.length) throw new ValidationError(errs);
  const p = new Plan();
  p.update('recurrence_version', current.id, current as unknown as Record<string, unknown>, { valid_to: addDays(fromDate, -1) }, `Version du ${formatDateFr(current.valid_from)} close au ${formatDateFr(addDays(fromDate, -1))}`);
  const ref = p.insert('recurrence_version', { recurrence_id: recurrenceId, valid_from: fromDate, valid_to: null, ...versionValues(next), change_kind: 'evolution', created_at: p.ts }, `« ${rec.label} » évolue à partir du ${formatDateFr(fromDate)} : ${formatMoney(next.amount_minor, next.currency)}`);
  return Plan.id(await p.run(driver), ref);
}

/** ARRÊTER : date de fin (dernière occurrence possible). `null` relance une récurrence arrêtée. */
export async function stopRecurrence(driver: Driver, snap: Snapshot, recurrenceId: number, endDate: IsoDate | null): Promise<void> {
  const rec = snap.recurrences.find((r) => r.id === recurrenceId);
  if (!rec) fail('id', 'Récurrence introuvable');
  if (endDate && !isValidIsoDate(endDate)) fail('end_date', 'Date de fin invalide');
  const first = getVersions(snap, recurrenceId)[0];
  if (endDate && first && endDate < first.valid_from) fail('end_date', 'La date de fin précède le début de la récurrence');
  const p = new Plan();
  p.update('recurrence', recurrenceId, rec as unknown as Record<string, unknown>, { end_date: endDate }, endDate ? `« ${rec.label} » arrêtée au ${formatDateFr(endDate)}` : `« ${rec.label} » relancée (sans fin)`);
  await p.run(driver);
}

/** Ajustement d'une seule occurrence : annulée, montant ou date différents. */
export async function overrideOccurrence(driver: Driver, snap: Snapshot, recurrenceId: number, nominalDate: IsoDate, change: { action: 'annulee' } | { action: 'montant'; amount_minor: number } | { action: 'date'; new_date: IsoDate } | { action: 'retablir' }): Promise<void> {
  const rec = snap.recurrences.find((r) => r.id === recurrenceId);
  if (!rec) fail('id', 'Récurrence introuvable');
  const existing = snap.overrides.find((o) => o.recurrence_id === recurrenceId && o.due_date === nominalDate);
  const p = new Plan();
  const id = `${recurrenceId}:${nominalDate}`;
  if (existing) {
    p.raw('DELETE FROM occurrence_override WHERE recurrence_id = ? AND due_date = ?', [recurrenceId, nominalDate]);
    p.audit('occurrence_override', id, 'delete', `Ajustement de l’occurrence du ${formatDateFr(nominalDate)} retiré`, existing);
  }
  if (change.action !== 'retablir') {
    if (change.action === 'date' && !isValidIsoDate(change.new_date)) fail('new_date', 'Date invalide');
    const vals = { recurrence_id: recurrenceId, due_date: nominalDate, action: change.action, amount_minor: change.action === 'montant' ? change.amount_minor : null, new_date: change.action === 'date' ? change.new_date : null };
    p.raw('INSERT INTO occurrence_override (recurrence_id, due_date, action, amount_minor, new_date) VALUES (?, ?, ?, ?, ?)', [vals.recurrence_id, vals.due_date, vals.action, vals.amount_minor, vals.new_date]);
    p.audit('occurrence_override', id, 'create', `« ${rec.label} » : occurrence du ${formatDateFr(nominalDate)} ${change.action === 'annulee' ? 'annulée' : 'ajustée'}`, undefined, vals);
  }
  if (!p.isEmpty) await p.run(driver);
}

export async function deleteRecurrence(driver: Driver, snap: Snapshot, recurrenceId: number): Promise<void> {
  const rec = snap.recurrences.find((r) => r.id === recurrenceId);
  if (!rec) fail('id', 'Récurrence introuvable');
  if (snap.reconciliations.some((r) => r.recurrence_id === recurrenceId)) fail('id', 'Des paiements sont rapprochés de cette récurrence : arrêtez-la plutôt que de la supprimer');
  if (snap.loans.some((l) => l.recurrence_id === recurrenceId)) fail('id', 'Cette récurrence est associée à un crédit');
  const p = new Plan();
  p.update('recurrence', recurrenceId, rec as unknown as Record<string, unknown>, { deleted_at: p.ts }, `Récurrence « ${rec.label} » mise à la corbeille`, { action: 'delete' });
  await p.run(driver);
}

// ------------------------------------------------------------------ échéances ponctuelles

export interface ScheduledInput {
  label: string;
  due_date: IsoDate;
  amount_minor: number;
  currency: Currency;
  nature: NatureCode;
  rubrique_id: number;
  planned_account_id?: number | null;
  fund_id?: number | null;
}

export async function createScheduled(driver: Driver, snap: Snapshot, input: ScheduledInput): Promise<number> {
  const errs: FieldError[] = [];
  if (!input.label?.trim()) errs.push({ field: 'label', message: 'Libellé : à renseigner' });
  if (!isValidIsoDate(input.due_date)) errs.push({ field: 'due_date', message: 'Date invalide' });
  if (!Number.isSafeInteger(input.amount_minor) || input.amount_minor === 0) errs.push({ field: 'amount_minor', message: 'Montant : non nul' });
  checkNature(snap, input.rubrique_id, input.nature, errs);
  if (errs.length) throw new ValidationError(errs);
  const p = new Plan();
  const ref = p.insert('scheduled_item', { label: input.label.trim(), due_date: input.due_date, amount_minor: input.amount_minor, currency: input.currency, nature: input.nature, rubrique_id: input.rubrique_id, planned_account_id: input.planned_account_id ?? null, fund_id: input.fund_id ?? null, status: 'prevue', created_at: p.ts }, `Échéance « ${input.label.trim()} » du ${formatDateFr(input.due_date)}`);
  return Plan.id(await p.run(driver), ref);
}

export async function updateScheduled(driver: Driver, snap: Snapshot, id: number, patch: Partial<Pick<ScheduledInput, 'label' | 'due_date' | 'amount_minor' | 'planned_account_id'>> & { status?: 'prevue' | 'annulee' }): Promise<void> {
  const s = snap.scheduled.find((x) => x.id === id);
  if (!s) fail('id', 'Échéance introuvable');
  if (patch.due_date && !isValidIsoDate(patch.due_date)) fail('due_date', 'Date invalide');
  const p = new Plan();
  const changes: Record<string, SqlParam> = {};
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) changes[k] = v as SqlParam;
  p.update('scheduled_item', id, s as unknown as Record<string, unknown>, changes, `Échéance « ${s.label} » ${patch.status === 'annulee' ? 'annulée' : 'modifiée'}`);
  await p.run(driver);
}

// ------------------------------------------------------------------ rapprochement

/**
 * Un paiement solde SON échéance : rapprochement explicite d'un mouvement avec une échéance de
 * la même rubrique. Paiement partiel : l'échéance reste ouverte pour le solde. Écart de
 * montant : `closesTarget` solde l'échéance malgré l'écart (choix explicite).
 */
export async function reconcile(
  driver: Driver,
  snap: Snapshot,
  input: { movement_id: number; target_key: string; allocated_minor?: number; closes_target?: boolean },
  today: IsoDate,
): Promise<number> {
  const m = snap.movements.find((x) => x.id === input.movement_id);
  if (!m) fail('movement_id', 'Opération introuvable');
  const ctx = buildCtx(snap, today);
  const target = findExpected(ctx, input.target_key, m.op_date ?? `${m.period_month}-15`);
  if (!target) fail('target_key', 'Échéance introuvable');
  if (target.kind !== 'credit' && target.rubrique_id !== m.rubrique_id) {
    const a = snap.rubriques.find((r) => r.id === target.rubrique_id)!.name;
    const b = snap.rubriques.find((r) => r.id === m.rubrique_id)!.name;
    fail('target_key', `L’échéance « ${target.label} » est dans la rubrique « ${a} », l’opération dans « ${b} » : reclassez d’abord l’opération`);
  }
  if (target.currency !== m.currency) fail('target_key', `L’échéance est en ${target.currency}, l’opération en ${m.currency}`);
  if (Math.sign(target.amount_minor) !== Math.sign(m.amount_minor)) fail('target_key', 'Le sens de l’opération (entrée / sortie) ne correspond pas à celui de l’échéance');
  const used = snap.reconciliations.filter((r) => r.movement_id === m.id).reduce((s, r) => s + Math.abs(r.allocated_minor), 0);
  const free = Math.abs(m.amount_minor) - used;
  if (free <= 0) fail('allocated_minor', 'Ce paiement est déjà entièrement affecté à d’autres échéances');
  if (target.status === 'soldee') fail('target_key', `L’échéance « ${target.label} » est déjà soldée`);
  const alloc = input.allocated_minor ?? (target.remaining <= free && !input.closes_target ? target.remaining : free);
  if (!(alloc > 0 && alloc <= free)) fail('allocated_minor', `Montant à affecter : entre 0,01 et ${formatMoney(free, m.currency)} (part non encore affectée du paiement)`);
  const p = new Plan();
  const ref = p.insert(
    'reconciliation',
    {
      movement_id: m.id,
      target_kind: target.kind,
      recurrence_id: target.recurrence_id,
      occurrence_date: target.kind === 'occurrence' ? target.nominal_date : null,
      scheduled_item_id: target.scheduled_item_id,
      loan_id: target.loan_id,
      installment_seq: target.seq,
      allocated_minor: alloc,
      closes_target: input.closes_target ? 1 : 0,
      created_at: p.ts,
    },
    `Paiement rapproché de « ${target.label} » (${formatDateFr(target.due_date)}) : ${formatMoney(alloc, m.currency)}`,
  );
  return Plan.id(await p.run(driver), ref);
}

export async function unreconcile(driver: Driver, snap: Snapshot, reconciliationId: number): Promise<void> {
  const r = snap.reconciliations.find((x) => x.id === reconciliationId);
  if (!r) fail('id', 'Rapprochement introuvable');
  const p = new Plan();
  p.raw('DELETE FROM reconciliation WHERE id = ?', [reconciliationId]);
  p.audit('reconciliation', reconciliationId, 'delete', 'Rapprochement annulé', r);
  await p.run(driver);
}

// ------------------------------------------------------------------ budgets

/** Budget mensuel d'une rubrique à partir d'un mois (le plan précédent est clos la veille). `null` arrête le budget. */
export async function setBudgetPlan(driver: Driver, snap: Snapshot, input: { rubrique_id: number; from_month: Month; monthly_minor: number | null; currency?: Currency }): Promise<void> {
  if (!MONTH_RE.test(input.from_month)) fail('from_month', 'Mois invalide');
  if (input.monthly_minor !== null && !(Number.isSafeInteger(input.monthly_minor) && input.monthly_minor >= 0)) fail('monthly_minor', 'Budget : montant positif ou nul');
  const r = snap.rubriques.find((x) => x.id === input.rubrique_id);
  if (!r) fail('rubrique_id', 'Rubrique introuvable');
  const fam = snap.families.find((f) => f.id === r.family_id)!;
  if (fam.direction === 'technique') fail('rubrique_id', 'Pas de budget sur un mouvement technique');
  const plans = snap.budgetPlans.filter((b) => b.rubrique_id === r.id);
  if (plans.some((b) => b.valid_from_month > input.from_month)) fail('from_month', 'Un budget commence déjà après ce mois : modifiez-le directement');
  const p = new Plan();
  for (const b of plans) {
    if (b.valid_from_month === input.from_month) {
      p.raw('DELETE FROM budget_plan WHERE id = ?', [b.id]);
      p.audit('budget_plan', b.id, 'delete', `Budget « ${r.name} » à partir de ${formatMonthFr(b.valid_from_month)} remplacé`, b);
    } else if (b.valid_to_month === null || b.valid_to_month >= input.from_month) {
      p.update('budget_plan', b.id, b as unknown as Record<string, unknown>, { valid_to_month: addMonths(input.from_month, -1) }, `Budget « ${r.name} » clos fin ${formatMonthFr(addMonths(input.from_month, -1))}`);
    }
  }
  if (input.monthly_minor !== null) {
    p.insert('budget_plan', { rubrique_id: r.id, valid_from_month: input.from_month, valid_to_month: null, monthly_minor: input.monthly_minor, currency: input.currency ?? snap.household.base_currency }, `Budget « ${r.name} » : ${formatMoney(input.monthly_minor, input.currency ?? 'EUR')} par mois à partir de ${formatMonthFr(input.from_month)}`);
  }
  await p.run(driver);
}

/**
 * Budget d'un mois : le budget initial est figé à la première modification (valeur du plan) ;
 * le budget actualisé est la révision explicite du mois.
 */
export async function setMonthBudget(driver: Driver, snap: Snapshot, input: { rubrique_id: number; month: Month; actualise_minor?: number | null; initial_minor?: number }): Promise<void> {
  if (!MONTH_RE.test(input.month)) fail('month', 'Mois invalide');
  const r = snap.rubriques.find((x) => x.id === input.rubrique_id);
  if (!r) fail('rubrique_id', 'Rubrique introuvable');
  for (const v of [input.actualise_minor, input.initial_minor]) if (v !== undefined && v !== null && !(Number.isSafeInteger(v) && v >= 0)) fail('montant', 'Budget : montant positif ou nul');
  const existing = snap.budgetMonths.find((b) => b.rubrique_id === r.id && b.period_month === input.month);
  const plan = snap.budgetPlans.find((p) => p.rubrique_id === r.id && p.valid_from_month <= input.month && (p.valid_to_month === null || p.valid_to_month >= input.month));
  const p = new Plan();
  if (existing) {
    const changes: Record<string, SqlParam> = {};
    if (input.initial_minor !== undefined) changes.initial_minor = input.initial_minor;
    if (input.actualise_minor !== undefined) changes.actualise_minor = input.actualise_minor;
    p.update('budget_month', existing.id, existing as unknown as Record<string, unknown>, changes, `Budget « ${r.name} » de ${formatMonthFr(input.month)} modifié`);
  } else {
    const initial = input.initial_minor ?? plan?.monthly_minor ?? 0;
    p.insert('budget_month', { rubrique_id: r.id, period_month: input.month, initial_minor: initial, actualise_minor: input.actualise_minor ?? null, currency: plan?.currency ?? snap.household.base_currency }, `Budget « ${r.name} » de ${formatMonthFr(input.month)} : initial ${formatMoney(initial, 'EUR')}${input.actualise_minor != null ? `, actualisé ${formatMoney(input.actualise_minor, 'EUR')}` : ''}`);
  }
  await p.run(driver);
}

/** Fige le budget initial de chaque rubrique budgétée pour un mois (ouverture du mois). */
export async function openMonthBudgets(driver: Driver, snap: Snapshot, month: Month): Promise<number> {
  const p = new Plan('systeme');
  let n = 0;
  for (const plan of snap.budgetPlans) {
    if (plan.valid_from_month > month || (plan.valid_to_month !== null && plan.valid_to_month < month)) continue;
    if (snap.budgetMonths.some((b) => b.rubrique_id === plan.rubrique_id && b.period_month === month)) continue;
    p.insert('budget_month', { rubrique_id: plan.rubrique_id, period_month: month, initial_minor: plan.monthly_minor, actualise_minor: null, currency: plan.currency }, `Budget initial de ${formatMonthFr(month)} figé`);
    n++;
  }
  if (n) await p.run(driver);
  return n;
}

// ------------------------------------------------------------------ clôture des mois

export async function closeMonth(driver: Driver, snap: Snapshot, month: Month, today: IsoDate, note = ''): Promise<void> {
  if (!MONTH_RE.test(month)) fail('month', 'Mois invalide');
  if (month >= today.slice(0, 7)) fail('month', `${formatMonthFr(month)} n’est pas terminé : il ne peut pas être clôturé`);
  if (snap.monthStatus.some((m) => m.period_month === month)) return;
  const p = new Plan();
  p.raw('INSERT INTO month_status (period_month, closed_at, note) VALUES (?, ?, ?)', [month, p.ts, note]);
  p.audit('month_status', month, 'create', `${formatMonthFr(month)} clôturé`, undefined, { note });
  await p.run(driver);
}

export async function reopenMonth(driver: Driver, snap: Snapshot, month: Month): Promise<void> {
  const st = snap.monthStatus.find((m) => m.period_month === month);
  if (!st) return;
  const p = new Plan();
  p.raw('DELETE FROM month_status WHERE period_month = ?', [month]);
  p.audit('month_status', month, 'delete', `${formatMonthFr(month)} rouvert`, st);
  await p.run(driver);
}
