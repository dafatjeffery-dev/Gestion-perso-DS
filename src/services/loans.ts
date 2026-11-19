// Crédits : fiche enregistrée en une transaction (associations comprises), échéancier
// bancaire préservé tel quel, échéancier théorique calculé, archivage et réactivation.

import { formatDateFr, isValidIsoDate, parseDate } from '../domain/dates';
import { parseAmount } from '../domain/money';
import type { Currency, IsoDate, Loan, LoanFrequency, LoanInstallment, Snapshot } from '../domain/types';
import { amortize, checkBankSchedule } from '../engine/loans';
import type { Driver, SqlParam } from '../storage/driver';
import { Plan, ValidationError, fail, type FieldError, type Ref } from './plan';

export interface LoanInput {
  label: string;
  lender?: string;
  currency: Currency;
  mode: Loan['mode'];
  frequency: LoanFrequency;
  first_due_date: IsoDate;
  principal_minor?: number | null;
  annual_rate_e6?: number | null;
  periods?: number | null;
  insurance_mode?: Loan['insurance_mode'];
  insurance_value?: number | null;
  fees_per_installment_minor?: number;
  fees_initial_minor?: number;
  simple_installment_minor?: number | null;
  simple_crd_minor?: number | null;
  simple_crd_date?: IsoDate | null;
  /** Associations : enregistrées uniquement avec la fiche. */
  payment_account_id?: number | null;
  recurrence_id?: number | null;
  /** Mode bancaire : échéancier fourni. */
  bankSchedule?: Omit<LoanInstallment, 'loan_id' | 'origin'>[];
}

function validate(snap: Snapshot, input: LoanInput, selfId: number | null): FieldError[] {
  const errs: FieldError[] = [];
  if (!input.label?.trim()) errs.push({ field: 'label', message: 'Nom du crédit : à renseigner' });
  if (!isValidIsoDate(input.first_due_date)) errs.push({ field: 'first_due_date', message: 'Date de la première échéance invalide' });
  if (input.mode === 'theorique') {
    if (!(input.principal_minor && input.principal_minor > 0)) errs.push({ field: 'principal_minor', message: 'Capital emprunté : positif' });
    if (!(input.annual_rate_e6 !== null && input.annual_rate_e6 !== undefined && input.annual_rate_e6 >= 0)) errs.push({ field: 'annual_rate_e6', message: 'Taux : à renseigner (0 accepté)' });
    if (!(input.periods && input.periods > 0 && input.periods <= 1200)) errs.push({ field: 'periods', message: 'Nombre d’échéances : 1 à 1200' });
  }
  if (input.mode === 'simplifie') {
    if (!(input.simple_installment_minor && input.simple_installment_minor > 0)) errs.push({ field: 'simple_installment_minor', message: 'Mensualité hors assurance : positive' });
    if (!(input.simple_crd_minor && input.simple_crd_minor > 0)) errs.push({ field: 'simple_crd_minor', message: 'Capital restant dû : positif' });
    if (!input.simple_crd_date || !isValidIsoDate(input.simple_crd_date)) errs.push({ field: 'simple_crd_date', message: 'Date du capital restant dû : à renseigner' });
  }
  if (input.mode === 'bancaire') {
    if (!input.bankSchedule?.length) errs.push({ field: 'bankSchedule', message: 'Collez l’échéancier fourni par la banque' });
    else for (const m of checkBankSchedule(input.bankSchedule).messages) errs.push({ field: 'bankSchedule', message: m });
  }
  if (input.payment_account_id) {
    const a = snap.accounts.find((x) => x.id === input.payment_account_id);
    if (!a) errs.push({ field: 'payment_account_id', message: 'Compte introuvable' });
    else if (a.currency !== input.currency) errs.push({ field: 'payment_account_id', message: `Le compte « ${a.name} » est en ${a.currency}, le crédit en ${input.currency}` });
  }
  if (input.recurrence_id) {
    const r = snap.recurrences.find((x) => x.id === input.recurrence_id);
    if (!r) errs.push({ field: 'recurrence_id', message: 'Récurrence introuvable' });
    const other = snap.loans.find((l) => l.recurrence_id === input.recurrence_id && l.id !== selfId);
    if (other) errs.push({ field: 'recurrence_id', message: `Cette récurrence est déjà portée par le crédit « ${other.label} »` });
  }
  return errs;
}

function loanValues(input: LoanInput): Record<string, SqlParam> {
  return {
    label: input.label.trim(),
    lender: input.lender ?? '',
    currency: input.currency,
    mode: input.mode,
    principal_minor: input.principal_minor ?? null,
    annual_rate_e6: input.annual_rate_e6 ?? null,
    periods: input.periods ?? null,
    frequency: input.frequency,
    first_due_date: input.first_due_date,
    insurance_mode: input.insurance_mode ?? 'aucune',
    insurance_value: input.insurance_value ?? null,
    fees_per_installment_minor: input.fees_per_installment_minor ?? 0,
    fees_initial_minor: input.fees_initial_minor ?? 0,
    simple_installment_minor: input.simple_installment_minor ?? null,
    simple_crd_minor: input.simple_crd_minor ?? null,
    simple_crd_date: input.simple_crd_date ?? null,
    payment_account_id: input.payment_account_id ?? null,
    recurrence_id: input.recurrence_id ?? null,
  };
}

function scheduleRows(input: LoanInput, loanId: number | Ref): Omit<LoanInstallment, 'loan_id'>[] {
  if (input.mode === 'bancaire') return input.bankSchedule!.map((r) => ({ ...r, origin: 'banque' as const }));
  if (input.mode === 'theorique')
    return amortize(0, {
      principal_minor: input.principal_minor!,
      annual_rate_e6: input.annual_rate_e6!,
      periods: input.periods!,
      frequency: input.frequency,
      first_due_date: input.first_due_date,
      insurance_mode: input.insurance_mode,
      insurance_value: input.insurance_value,
      fees_per_installment_minor: input.fees_per_installment_minor,
      fees_initial_minor: input.fees_initial_minor,
    }).map(({ loan_id: _ignored, ...r }) => r);
  void loanId;
  return [];
}

/** Enregistre la fiche (création ou modification) : crédit, échéancier et associations en une transaction. */
export async function saveLoan(driver: Driver, snap: Snapshot, input: LoanInput, id: number | null = null): Promise<number> {
  const existing = id ? snap.loans.find((l) => l.id === id) : null;
  if (id && !existing) fail('id', 'Crédit introuvable');
  const errs = validate(snap, input, id);
  if (errs.length) throw new ValidationError(errs);
  const p = new Plan();
  const vals = loanValues(input);
  let ref: number | Ref;
  if (existing) {
    const reconciledSeqs = new Set(snap.reconciliations.filter((r) => r.loan_id === id).map((r) => r.installment_seq));
    const newRows = scheduleRows(input, id!);
    const oldRows = snap.installments.filter((i) => i.loan_id === id);
    for (const seq of reconciledSeqs) {
      const a = oldRows.find((r) => r.seq === seq);
      const b = newRows.find((r) => r.seq === seq);
      if (a && (!b || b.total_minor !== a.total_minor)) fail('schedule', `L’échéance ${seq} a déjà un paiement rapproché : son montant ne peut pas changer (annulez d’abord le rapprochement)`);
    }
    const changes: Record<string, SqlParam> = {};
    for (const [k, v] of Object.entries(vals)) if ((existing as unknown as Record<string, unknown>)[k] !== v) changes[k] = v;
    p.update('loan', id!, existing as unknown as Record<string, unknown>, changes, `Crédit « ${existing.label} » modifié`);
    if (input.mode !== 'simplifie' || oldRows.length) {
      p.raw('DELETE FROM loan_installment WHERE loan_id = ?', [id!]);
      p.audit('loan_installment', id!, 'delete', `Échéancier de « ${existing.label} » remplacé (${oldRows.length} échéances)`, { rows: oldRows.length });
    }
    ref = id!;
  } else {
    ref = p.insert('loan', { ...vals, status: 'actif', created_at: p.ts }, `Crédit « ${input.label.trim()} » créé (${input.mode})`);
  }
  const rows = scheduleRows(input, ref);
  for (const r of rows) {
    p.raw('INSERT INTO loan_installment (loan_id, seq, due_date, principal_minor, interest_minor, insurance_minor, fees_minor, total_minor, crd_after_minor, origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [ref, r.seq, r.due_date, r.principal_minor, r.interest_minor, r.insurance_minor, r.fees_minor, r.total_minor, r.crd_after_minor, r.origin]);
  }
  if (rows.length) p.audit('loan_installment', ref, 'create', `Échéancier enregistré : ${rows.length} échéance(s)`, undefined, { rows: rows.length });
  const r = await p.run(driver);
  return typeof ref === 'number' ? ref : Plan.id(r, ref);
}

/** Archiver : le crédit sort des prévisions ; rien n'est supprimé. */
export async function archiveLoan(driver: Driver, snap: Snapshot, id: number, status: 'archive' | 'solde' = 'archive'): Promise<void> {
  const l = snap.loans.find((x) => x.id === id);
  if (!l) fail('id', 'Crédit introuvable');
  const p = new Plan();
  p.update('loan', id, l as unknown as Record<string, unknown>, { status, archived_at: p.ts }, `Crédit « ${l.label} » ${status === 'solde' ? 'marqué soldé' : 'archivé'}`);
  await p.run(driver);
}

/** Réactiver : explicite ; ne recrée aucun paiement passé (les paiements sont des opérations). */
export async function reactivateLoan(driver: Driver, snap: Snapshot, id: number): Promise<void> {
  const l = snap.loans.find((x) => x.id === id);
  if (!l) fail('id', 'Crédit introuvable');
  if (l.status === 'actif') return;
  const p = new Plan();
  p.update('loan', id, l as unknown as Record<string, unknown>, { status: 'actif', archived_at: null }, `Crédit « ${l.label} » réactivé`);
  await p.run(driver);
}

export interface ParsedSchedule {
  rows: Omit<LoanInstallment, 'loan_id' | 'origin'>[];
  errors: string[];
}

/**
 * Lecture d'un échéancier collé depuis un tableur : une ligne par échéance,
 * colonnes date ; capital ; intérêts ; assurance ; frais ; capital restant dû (séparateur ; ou tabulation).
 * Les valeurs sont conservées telles quelles.
 */
export function parseBankSchedule(text: string): ParsedSchedule {
  const rows: ParsedSchedule['rows'] = [];
  const errors: string[] = [];
  let seq = 0;
  text.split(/\r?\n/).forEach((line, idx) => {
    if (!line.trim()) return;
    const c = line.split(/[;\t]/).map((x) => x.trim());
    if (idx === 0 && !/\d/.test(c[0] ?? '')) return;
    const n = idx + 1;
    if (c.length < 6) {
      errors.push(`Ligne ${n} : 6 colonnes attendues (date ; capital ; intérêts ; assurance ; frais ; capital restant dû)`);
      return;
    }
    const d = parseDate(c[0]);
    const nums = c.slice(1, 6).map((x) => (x === '' ? ({ ok: true, value: 0 } as const) : parseAmount(x)));
    const labels = ['capital', 'intérêts', 'assurance', 'frais', 'capital restant dû'];
    if (!d.ok) errors.push(`Ligne ${n}, colonne date : ${d.reason}`);
    nums.forEach((r, i) => !r.ok && errors.push(`Ligne ${n}, colonne ${labels[i]} : ${r.reason}`));
    if (!d.ok || nums.some((r) => !r.ok)) return;
    const [p, it, ins, fe, crd] = nums.map((r) => Math.abs((r as { value: number }).value)) as [number, number, number, number, number];
    seq++;
    rows.push({ seq, due_date: d.value, principal_minor: p, interest_minor: it, insurance_minor: ins, fees_minor: fe, total_minor: p + it + ins + fe, crd_after_minor: crd });
  });
  return { rows, errors };
}

export function describeLoan(l: Loan): string {
  return l.mode === 'simplifie' ? `saisie simplifiée (capital restant dû au ${l.simple_crd_date ? formatDateFr(l.simple_crd_date) : '?'})` : l.mode === 'bancaire' ? 'échéancier de la banque' : 'calcul théorique';
}
