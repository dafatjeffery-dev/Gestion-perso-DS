// Échéances attendues : occurrences des récurrences (générées depuis leurs versions),
// échéances ponctuelles et échéances de crédit, avec leur état de rapprochement.

import { addMonths, dateInMonth, firstDay, lastDay, monthOf, monthsBetween } from '../domain/dates';
import { divRound } from '../domain/money';
import type {
  Currency,
  IsoDate,
  Month,
  NatureCode,
  Reconciliation,
  Recurrence,
  RecurrenceVersion,
} from '../domain/types';
import type { Ctx } from './context';

export type TargetKind = 'occurrence' | 'echeance' | 'credit';

export interface Expected {
  key: string;
  kind: TargetKind;
  recurrence_id: number | null;
  version_id: number | null;
  scheduled_item_id: number | null;
  loan_id: number | null;
  seq: number | null;
  label: string;
  /** Date d'origine (identité de l'occurrence). */
  nominal_date: IsoDate;
  /** Date effective (après un éventuel décalage ponctuel). */
  due_date: IsoDate;
  amount_minor: number;
  currency: Currency;
  nature: NatureCode;
  rubrique_id: number;
  account_id: number | null;
  fund_id: number | null;
  reconciliations: Reconciliation[];
  /** Montant affecté par les paiements, en valeur absolue, dans la devise de l'échéance. */
  allocated: number;
  closed: boolean;
  /** Reste à payer en valeur absolue (0 si soldée). */
  remaining: number;
  status: 'soldee' | 'partielle' | 'ouverte' | 'en_retard';
  /** Écart constaté (payé − attendu, en valeur absolue) quand l'échéance est soldée. */
  gap: number;
}

export const occurrenceKey = (recurrenceId: number, date: IsoDate) => `occ:${recurrenceId}:${date}`;
export const echeanceKey = (id: number) => `ech:${id}`;
export const creditKey = (loanId: number, seq: number) => `cr:${loanId}:${seq}`;

export function reconciliationKey(r: Reconciliation): string {
  if (r.target_kind === 'occurrence') return occurrenceKey(r.recurrence_id!, r.occurrence_date!);
  if (r.target_kind === 'echeance') return echeanceKey(r.scheduled_item_id!);
  return creditKey(r.loan_id!, r.installment_seq!);
}

export function stepMonths(v: Pick<RecurrenceVersion, 'frequency' | 'interval_months'>): number {
  switch (v.frequency) {
    case 'mensuelle':
      return Math.max(1, v.interval_months);
    case 'trimestrielle':
      return 3;
    case 'semestrielle':
      return 6;
    case 'annuelle':
      return 12;
    case 'personnalisee':
      return 1;
  }
}

export function versionsOf(ctx: Ctx, recurrenceId: number): RecurrenceVersion[] {
  return ctx.snap.recurrenceVersions.filter((v) => v.recurrence_id === recurrenceId).sort((a, b) => (a.valid_from < b.valid_from ? -1 : 1));
}

/** Récurrences dont les occurrences sont remplacées par les échéances d'un crédit associé. */
export function recurrencesCarriedByLoans(ctx: Ctx): Map<number, number> {
  const m = new Map<number, number>();
  for (const l of ctx.snap.loans) if (l.recurrence_id) m.set(l.recurrence_id, l.id);
  return m;
}

/** Dates nominales d'une récurrence dans [from, to] (avant ajustements ponctuels). */
export function nominalDates(
  rec: Recurrence,
  versions: RecurrenceVersion[],
  from: IsoDate,
  to: IsoDate,
): { date: IsoDate; version: RecurrenceVersion }[] {
  if (versions.length === 0) return [];
  const anchor = monthOf(versions[0]!.valid_from);
  const out: { date: IsoDate; version: RecurrenceVersion }[] = [];
  const end = rec.end_date && rec.end_date < to ? rec.end_date : to;
  for (const v of versions) {
    const vFrom = v.valid_from > from ? v.valid_from : from;
    const vTo = v.valid_to && v.valid_to < end ? v.valid_to : end;
    if (vFrom > vTo) continue;
    const step = stepMonths(v);
    for (let m = monthOf(vFrom); m <= monthOf(vTo); m = addMonths(m, 1)) {
      if (v.frequency === 'personnalisee') {
        const bit = Number(m.slice(5, 7)) - 1;
        if (!((v.months_mask ?? 0) & (1 << bit))) continue;
      } else {
        const k = monthsBetween(anchor, m);
        if (k < 0 || k % step !== 0) continue;
      }
      const d = dateInMonth(m, v.day_of_month);
      if (d >= vFrom && d <= vTo && d >= v.valid_from) out.push({ date: d, version: v });
    }
  }
  return out;
}

function settle(e: Omit<Expected, 'allocated' | 'closed' | 'remaining' | 'status' | 'gap' | 'reconciliations'>, recs: Reconciliation[], today: IsoDate): Expected {
  const allocated = recs.reduce((s, r) => s + Math.abs(r.allocated_minor), 0);
  const expectedAbs = Math.abs(e.amount_minor);
  const closed = recs.some((r) => r.closes_target === 1);
  const soldee = closed || allocated >= expectedAbs;
  const remaining = soldee ? 0 : expectedAbs - allocated;
  const status = soldee ? 'soldee' : allocated > 0 ? 'partielle' : e.due_date < today ? 'en_retard' : 'ouverte';
  return { ...e, reconciliations: recs, allocated, closed, remaining, status, gap: soldee ? allocated - expectedAbs : 0 };
}

function reconciliationsByKey(ctx: Ctx): Map<string, Reconciliation[]> {
  const m = new Map<string, Reconciliation[]>();
  for (const r of ctx.snap.reconciliations) {
    const k = reconciliationKey(r);
    const l = m.get(k);
    if (l) l.push(r);
    else m.set(k, [r]);
  }
  return m;
}

/**
 * Toutes les échéances attendues dont la date effective est dans [from, to].
 * Les occurrences de récurrences portées par un crédit sont remplacées par les échéances du crédit.
 */
export function expectedBetween(ctx: Ctx, from: IsoDate, to: IsoDate): Expected[] {
  const recs = reconciliationsByKey(ctx);
  const carried = recurrencesCarriedByLoans(ctx);
  const out: Expected[] = [];
  // marge de 62 jours pour attraper les occurrences décalées vers la fenêtre
  const wideFrom = firstDay(addMonths(monthOf(from), -2));
  const wideTo = lastDay(addMonths(monthOf(to), 2));
  for (const rec of ctx.snap.recurrences) {
    if (carried.has(rec.id)) continue;
    const versions = versionsOf(ctx, rec.id);
    for (const { date, version } of nominalDates(rec, versions, wideFrom, wideTo)) {
      const ov = ctx.snap.overrides.find((o) => o.recurrence_id === rec.id && o.due_date === date);
      if (ov?.action === 'annulee') continue;
      const due = ov?.action === 'date' ? ov.new_date! : date;
      if (due < from || due > to) continue;
      const key = occurrenceKey(rec.id, date);
      out.push(
        settle(
          {
            key,
            kind: 'occurrence',
            recurrence_id: rec.id,
            version_id: version.id,
            scheduled_item_id: null,
            loan_id: null,
            seq: null,
            label: rec.label,
            nominal_date: date,
            due_date: due,
            amount_minor: ov?.action === 'montant' ? ov.amount_minor! : version.amount_minor,
            currency: version.currency,
            nature: rec.nature,
            rubrique_id: rec.rubrique_id,
            account_id: rec.planned_account_id,
            fund_id: null,
          },
          recs.get(key) ?? [],
          ctx.today,
        ),
      );
    }
  }
  for (const s of ctx.snap.scheduled) {
    if (s.status !== 'prevue' || s.due_date < from || s.due_date > to) continue;
    const key = echeanceKey(s.id);
    out.push(
      settle(
        {
          key,
          kind: 'echeance',
          recurrence_id: null,
          version_id: null,
          scheduled_item_id: s.id,
          loan_id: null,
          seq: null,
          label: s.label,
          nominal_date: s.due_date,
          due_date: s.due_date,
          amount_minor: s.amount_minor,
          currency: s.currency,
          nature: s.nature,
          rubrique_id: s.rubrique_id,
          account_id: s.planned_account_id,
          fund_id: s.fund_id,
        },
        recs.get(key) ?? [],
        ctx.today,
      ),
    );
  }
  out.push(...loanExpected(ctx, from, to, recs));
  return out.sort((a, b) => (a.due_date < b.due_date ? -1 : a.due_date > b.due_date ? 1 : a.key < b.key ? -1 : 1));
}

/** Échéances de crédit (le détail de la ventilation est traité par le module crédits). */
function loanExpected(ctx: Ctx, from: IsoDate, to: IsoDate, recs: Map<string, Reconciliation[]>): Expected[] {
  const out: Expected[] = [];
  const total = ctx.rubriqueByRef.get('SYS.CREDIT.NON_VENTILEE');
  if (!total) return out;
  for (const loan of ctx.snap.loans) {
    if (loan.status !== 'actif') continue;
    for (const i of ctx.snap.installments) {
      if (i.loan_id !== loan.id || i.due_date < from || i.due_date > to) continue;
      const key = creditKey(loan.id, i.seq);
      out.push(
        settle(
          {
            key,
            kind: 'credit',
            recurrence_id: null,
            version_id: null,
            scheduled_item_id: null,
            loan_id: loan.id,
            seq: i.seq,
            label: `${loan.label} — échéance ${i.seq}`,
            nominal_date: i.due_date,
            due_date: i.due_date,
            amount_minor: -i.total_minor,
            currency: loan.currency,
            nature: 'cout_credit',
            rubrique_id: total.id,
            account_id: loan.payment_account_id,
            fund_id: null,
          },
          recs.get(key) ?? [],
          ctx.today,
        ),
      );
    }
  }
  return out;
}

export function findExpected(ctx: Ctx, key: string, around: IsoDate): Expected | null {
  const from = firstDay(addMonths(monthOf(around), -24));
  const to = lastDay(addMonths(monthOf(around), 24));
  return expectedBetween(ctx, from, to).find((e) => e.key === key) ?? null;
}

// ------------------------------------------------------------------ annuel, lissage, calendrier

export interface AnnualView {
  /** Somme des occurrences sur les 12 mois à partir de `fromMonth` (valeur signée). */
  annual_minor: number;
  /** Repère budgétaire lissé = annuel / 12, arrondi au centime. NE S'AJOUTE À RIEN. */
  smoothed_minor: number;
  /** Calendrier réel : seule valeur utilisée par le prévu et la trésorerie. */
  calendar: { month: Month; amount_minor: number; date: IsoDate }[];
  currency: Currency;
}

export function annualView(ctx: Ctx, recurrenceId: number, fromMonth: Month): AnnualView {
  const rec = ctx.snap.recurrences.find((r) => r.id === recurrenceId);
  if (!rec) throw new Error('récurrence inconnue');
  const from = firstDay(fromMonth);
  const to = lastDay(addMonths(fromMonth, 11));
  const items = expectedBetween(ctx, from, to).filter((e) => e.recurrence_id === recurrenceId);
  const currency = items[0]?.currency ?? versionsOf(ctx, recurrenceId)[0]?.currency ?? ctx.base;
  const annual = items.reduce((s, e) => s + e.amount_minor, 0);
  return {
    annual_minor: annual,
    smoothed_minor: Number(divRound(BigInt(annual), 12n)),
    calendar: items.map((e) => ({ month: monthOf(e.due_date), amount_minor: e.amount_minor, date: e.due_date })),
    currency,
  };
}
