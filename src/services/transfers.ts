// Transferts internes (y compris EUR ↔ CHF) : deux opérations liées, neutres dans les revenus
// et dépenses ; les frais sont une troisième opération identifiée ; l'écart de change est calculé.

import { formatDateFr, isValidIsoDate, monthOf } from '../domain/dates';
import { formatMoney } from '../domain/money';
import type { IsoDate, Snapshot } from '../domain/types';
import type { Driver } from '../storage/driver';
import { Plan, ValidationError, type FieldError } from './plan';

export interface TransferInput {
  from_account_id: number;
  to_account_id: number;
  /** Date de débit ; date de crédit par défaut identique. */
  date: IsoDate;
  in_date?: IsoDate;
  /** Montant débité, en valeur positive, dans la devise du compte débité. */
  out_minor: number;
  /** Montant crédité, en valeur positive, dans la devise du compte crédité (obligatoire entre devises). */
  in_minor?: number;
  fee?: { amount_minor: number; account_id?: number; label?: string };
  reference?: string;
  label?: string;
}

export async function createTransfer(driver: Driver, snap: Snapshot, input: TransferInput): Promise<number> {
  const errs: FieldError[] = [];
  const from = snap.accounts.find((a) => a.id === input.from_account_id);
  const to = snap.accounts.find((a) => a.id === input.to_account_id);
  if (!from) errs.push({ field: 'from_account_id', message: 'Compte débité introuvable' });
  if (!to) errs.push({ field: 'to_account_id', message: 'Compte crédité introuvable' });
  if (from && to && from.id === to.id) errs.push({ field: 'to_account_id', message: 'Les deux comptes doivent être différents' });
  if (!isValidIsoDate(input.date)) errs.push({ field: 'date', message: 'Date invalide' });
  if (input.in_date && !isValidIsoDate(input.in_date)) errs.push({ field: 'in_date', message: 'Date de crédit invalide' });
  if (!(Number.isSafeInteger(input.out_minor) && input.out_minor > 0)) errs.push({ field: 'out_minor', message: 'Montant débité : positif' });
  if (from && to && from.currency !== to.currency && input.in_minor === undefined)
    errs.push({ field: 'in_minor', message: `Indiquez le montant reçu en ${to.currency} : la conversion n’est jamais devinée` });
  if (input.in_minor !== undefined && !(Number.isSafeInteger(input.in_minor) && input.in_minor > 0)) errs.push({ field: 'in_minor', message: 'Montant crédité : positif' });
  if (input.fee && !(Number.isSafeInteger(input.fee.amount_minor) && input.fee.amount_minor > 0)) errs.push({ field: 'fee', message: 'Frais : montant positif' });
  for (const a of [from, to]) if (a && a.status === 'archive') errs.push({ field: 'account', message: `Le compte « ${a.name} » est archivé` });
  if (errs.length) throw new ValidationError(errs);
  const rub = (ref: string) => snap.rubriques.find((r) => r.ref === ref)!.id;
  const feeAccount = snap.accounts.find((a) => a.id === (input.fee?.account_id ?? from!.id))!;
  const p = new Plan();
  const t = p.insert('transfer', { reference: input.reference ?? null }, `Transfert ${from!.name} → ${to!.name} du ${formatDateFr(input.date)}`);
  const label = input.label ?? `Transfert ${from!.name} → ${to!.name}`;
  const inDate = input.in_date ?? input.date;
  const base = { granularity: 'operation', value_date: null, label_original: null, bank_id: null, comment: '', classification: 'confirme', created_at: p.ts, updated_at: p.ts, nature: 'transfert', rubrique_id: rub('SYS.TECH.TRANSFERT'), transfer_id: t };
  p.insert('movement', { ...base, account_id: from!.id, op_date: input.date, period_month: monthOf(input.date), amount_minor: -input.out_minor, currency: from!.currency, label_simple: label, transfer_role: 'sortie' }, `Transfert : débit ${formatMoney(-input.out_minor, from!.currency)}`);
  p.insert('movement', { ...base, account_id: to!.id, op_date: inDate, period_month: monthOf(inDate), amount_minor: input.in_minor ?? input.out_minor, currency: to!.currency, label_simple: label, transfer_role: 'entree' }, `Transfert : crédit ${formatMoney(input.in_minor ?? input.out_minor, to!.currency)}`);
  if (input.fee) {
    p.insert('movement', { ...base, account_id: feeAccount.id, op_date: input.date, period_month: monthOf(input.date), amount_minor: -input.fee.amount_minor, currency: feeAccount.currency, nature: 'frais_transfert', rubrique_id: rub('SYS.FRAIS.TRANSFERT'), label_simple: input.fee.label ?? `Frais — ${label}`, transfer_role: 'frais' }, `Frais de transfert ${formatMoney(-input.fee.amount_minor, feeAccount.currency)}`);
  }
  return Plan.id(await p.run(driver), t);
}
