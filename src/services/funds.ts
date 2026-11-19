// Réserve de sécurité, fonds affectés et projets.

import { formatDateFr, isValidIsoDate } from '../domain/dates';
import { formatMoney } from '../domain/money';
import type { Currency, IsoDate, LoanFrequency, Snapshot } from '../domain/types';
import { buildCtx } from '../engine/context';
import { fundState } from '../engine/funds';
import type { Driver, SqlParam } from '../storage/driver';
import { Plan, ValidationError, fail, type FieldError } from './plan';

export interface FundInput {
  kind: 'reserve' | 'projet';
  name: string;
  target_minor?: number | null;
  currency?: Currency;
  target_date?: IsoDate | null;
}

export async function saveFund(driver: Driver, snap: Snapshot, input: FundInput, id: number | null = null): Promise<number> {
  const errs: FieldError[] = [];
  if (!input.name?.trim()) errs.push({ field: 'name', message: 'Nom : à renseigner' });
  if (input.target_minor !== undefined && input.target_minor !== null && input.target_minor < 0) errs.push({ field: 'target_minor', message: 'Objectif : positif' });
  if (input.target_date && !isValidIsoDate(input.target_date)) errs.push({ field: 'target_date', message: 'Échéance invalide' });
  if (!id && input.kind === 'reserve' && snap.funds.some((f) => f.kind === 'reserve')) errs.push({ field: 'kind', message: 'La réserve de sécurité existe déjà' });
  if (errs.length) throw new ValidationError(errs);
  const vals: Record<string, SqlParam> = { kind: input.kind, name: input.name.trim(), target_minor: input.target_minor ?? null, currency: input.currency ?? snap.household.base_currency, target_date: input.target_date ?? null };
  const p = new Plan();
  if (id) {
    const f = snap.funds.find((x) => x.id === id);
    if (!f) fail('id', 'Fonds introuvable');
    if (vals.currency !== f.currency && snap.fundAllocations.some((a) => a.fund_id === id)) fail('currency', 'La devise d’un fonds déjà alimenté ne peut pas changer');
    p.update('fund', id, f as unknown as Record<string, unknown>, vals, `« ${f.name} » modifié`);
    await p.run(driver);
    return id;
  }
  const ref = p.insert('fund', { ...vals, status: 'actif' }, `${input.kind === 'reserve' ? 'Réserve de sécurité' : `Projet « ${input.name.trim()} »`} créé`);
  return Plan.id(await p.run(driver), ref);
}

/** Affecter (montant positif) ou libérer (négatif) une somme réservée. */
export async function allocate(driver: Driver, snap: Snapshot, input: { fund_id: number; date: IsoDate; amount_minor: number; note?: string }, today: IsoDate): Promise<void> {
  const f = snap.funds.find((x) => x.id === input.fund_id);
  if (!f) fail('fund_id', 'Fonds introuvable');
  if (!isValidIsoDate(input.date)) fail('date', 'Date invalide');
  if (!Number.isSafeInteger(input.amount_minor) || input.amount_minor === 0) fail('amount_minor', 'Montant : non nul');
  const st = fundState(buildCtx(snap, today), f, '9999-12-31');
  if (st.reserved + input.amount_minor < 0) fail('amount_minor', `Impossible de libérer plus que le montant réservé (${formatMoney(st.reserved, f.currency)})`);
  const p = new Plan();
  p.insert('fund_allocation', { fund_id: f.id, alloc_date: input.date, amount_minor: input.amount_minor, note: input.note ?? '' }, `${input.amount_minor > 0 ? 'Affectation à' : 'Libération de'} « ${f.name} » : ${formatMoney(Math.abs(input.amount_minor), f.currency)} le ${formatDateFr(input.date)}`);
  await p.run(driver);
}

export async function setFundPlan(driver: Driver, snap: Snapshot, input: { fund_id: number; amount_minor: number | null; frequency: LoanFrequency; start_date: IsoDate; end_date?: IsoDate | null }): Promise<void> {
  const f = snap.funds.find((x) => x.id === input.fund_id);
  if (!f) fail('fund_id', 'Fonds introuvable');
  const p = new Plan();
  for (const old of snap.fundPlans.filter((x) => x.fund_id === f.id)) {
    p.raw('DELETE FROM fund_plan WHERE id = ?', [old.id]);
    p.audit('fund_plan', old.id, 'delete', `Versements prévus de « ${f.name} » remplacés`, old);
  }
  if (input.amount_minor) {
    if (!isValidIsoDate(input.start_date)) fail('start_date', 'Date invalide');
    p.insert('fund_plan', { fund_id: f.id, amount_minor: Math.abs(input.amount_minor), frequency: input.frequency, start_date: input.start_date, end_date: input.end_date ?? null }, `Versements prévus vers « ${f.name} » : ${formatMoney(Math.abs(input.amount_minor), f.currency)} (${input.frequency})`);
  }
  if (!p.isEmpty) await p.run(driver);
}

/** Paiement d'un projet : la dépense consomme la réservation (une seule fois). */
export async function consume(driver: Driver, snap: Snapshot, input: { fund_id: number; movement_id: number; amount_minor?: number }, today: IsoDate): Promise<void> {
  const f = snap.funds.find((x) => x.id === input.fund_id);
  const m = snap.movements.find((x) => x.id === input.movement_id);
  if (!f) fail('fund_id', 'Fonds introuvable');
  if (!m) fail('movement_id', 'Opération introuvable');
  if (m.amount_minor >= 0) fail('movement_id', 'Seule une sortie d’argent peut consommer une réservation');
  if (m.currency !== f.currency) fail('movement_id', `L’opération est en ${m.currency}, le fonds en ${f.currency}`);
  if (snap.fundConsumptions.some((c) => c.movement_id === m.id)) fail('movement_id', 'Cette opération est déjà rattachée à un fonds');
  const amount = input.amount_minor ?? Math.abs(m.amount_minor);
  if (!(amount > 0 && amount <= Math.abs(m.amount_minor))) fail('amount_minor', 'Montant : entre 0,01 et le montant de l’opération');
  const st = fundState(buildCtx(snap, today), f, '9999-12-31');
  if (amount > st.reserved) fail('amount_minor', `Réservation insuffisante sur « ${f.name} » (${formatMoney(st.reserved, f.currency)}) : affectez d’abord la somme manquante`);
  const p = new Plan();
  p.insert('fund_consumption', { fund_id: f.id, movement_id: m.id, amount_minor: amount }, `Paiement rattaché à « ${f.name} » : ${formatMoney(amount, f.currency)}`);
  await p.run(driver);
}

export async function unconsume(driver: Driver, snap: Snapshot, consumptionId: number): Promise<void> {
  const c = snap.fundConsumptions.find((x) => x.id === consumptionId);
  if (!c) fail('id', 'Rattachement introuvable');
  const p = new Plan();
  p.raw('DELETE FROM fund_consumption WHERE id = ?', [c.id]);
  p.audit('fund_consumption', c.id, 'delete', 'Paiement détaché du fonds', c);
  await p.run(driver);
}

export async function setFundStatus(driver: Driver, snap: Snapshot, id: number, status: 'actif' | 'termine' | 'archive'): Promise<void> {
  const f = snap.funds.find((x) => x.id === id);
  if (!f) fail('id', 'Fonds introuvable');
  const p = new Plan();
  p.update('fund', id, f as unknown as Record<string, unknown>, { status }, `« ${f.name} » : ${status}`);
  await p.run(driver);
}
