// Crédits : échéancier théorique, échéancier estimé (mode simplifié), capital restant dû,
// ventilation des paiements rapprochés. Conventions et limites : docs/REGLES_DE_CALCUL.md § 7.

import Decimal from 'decimal.js';
import { addMonths, dateInMonth, monthOf } from '../domain/dates';
import type { IsoDate, Loan, LoanFrequency, LoanInstallment } from '../domain/types';
import type { Ctx } from './context';

export const PERIODS_PER_YEAR: Record<LoanFrequency, number> = { mensuelle: 12, trimestrielle: 4, semestrielle: 2, annuelle: 1 };
export const STEP_MONTHS: Record<LoanFrequency, number> = { mensuelle: 1, trimestrielle: 3, semestrielle: 6, annuelle: 12 };

/** Limites affichées sur la fiche d'un crédit calculé. */
export const THEORETICAL_LIMITS =
  'Calcul théorique : taux nominal annuel proportionnel (taux / nombre d’échéances par an), échéance constante hors assurance, intérêts arrondis au centime à chaque échéance, dernière échéance ajustée. Non modélisés : différé, taux variable, remboursement anticipé, intérêts intercalaires, calcul au jour près. Seul l’échéancier de votre banque fait foi.';

const D = (x: number | string) => new Decimal(x);
const cents = (x: Decimal): number => x.toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber();

export function dueDate(first: IsoDate, frequency: LoanFrequency, k: number): IsoDate {
  const day = Number(first.slice(8, 10));
  return dateInMonth(addMonths(monthOf(first), k * STEP_MONTHS[frequency]), day);
}

export interface AmortizeInput {
  principal_minor: number;
  /** Taux nominal annuel × 10⁶ (1,85 % → 18 500). */
  annual_rate_e6: number;
  periods: number;
  frequency: LoanFrequency;
  first_due_date: IsoDate;
  insurance_mode?: Loan['insurance_mode'];
  insurance_value?: number | null;
  fees_per_installment_minor?: number;
  fees_initial_minor?: number;
}

/** Échéance constante hors assurance, en centimes. */
export function constantInstallment(principal: number, annualRateE6: number, periods: number, ppy: number): number {
  const i = D(annualRateE6).div(1_000_000).div(ppy);
  if (i.isZero()) return cents(D(principal).div(periods));
  const m = D(principal).mul(i).div(D(1).minus(i.plus(1).pow(-periods)));
  return cents(m);
}

function insuranceFor(input: Pick<AmortizeInput, 'insurance_mode' | 'insurance_value' | 'principal_minor'>, crdBefore: number, ppy: number): number {
  const v = input.insurance_value ?? 0;
  switch (input.insurance_mode ?? 'aucune') {
    case 'aucune':
      return 0;
    case 'montant_fixe':
      return v;
    case 'pct_capital_initial':
      return cents(D(input.principal_minor).mul(v).div(1_000_000).div(ppy));
    case 'pct_crd':
      return cents(D(crdBefore).mul(v).div(1_000_000).div(ppy));
  }
}

/** Tableau d'amortissement théorique (origine « calcule »). */
export function amortize(loanId: number, input: AmortizeInput): LoanInstallment[] {
  const ppy = PERIODS_PER_YEAR[input.frequency];
  const i = D(input.annual_rate_e6).div(1_000_000).div(ppy);
  const m = constantInstallment(input.principal_minor, input.annual_rate_e6, input.periods, ppy);
  const fees = input.fees_per_installment_minor ?? 0;
  const out: LoanInstallment[] = [];
  if (input.fees_initial_minor) {
    out.push({ loan_id: loanId, seq: 0, due_date: dueDate(input.first_due_date, input.frequency, -1), principal_minor: 0, interest_minor: 0, insurance_minor: 0, fees_minor: input.fees_initial_minor, total_minor: input.fees_initial_minor, crd_after_minor: input.principal_minor, origin: 'calcule' });
  }
  let crd = input.principal_minor;
  for (let k = 1; k <= input.periods; k++) {
    const interest = cents(D(crd).mul(i));
    const principal = k < input.periods ? Math.min(crd, m - interest) : crd;
    const insurance = insuranceFor(input, crd, ppy);
    crd -= principal;
    out.push({
      loan_id: loanId,
      seq: k,
      due_date: dueDate(input.first_due_date, input.frequency, k - 1),
      principal_minor: principal,
      interest_minor: interest,
      insurance_minor: insurance,
      fees_minor: fees,
      total_minor: principal + interest + insurance + fees,
      crd_after_minor: crd,
      origin: 'calcule',
    });
  }
  return out;
}

export interface VirtualInstallment extends LoanInstallment {
  /** Mode simplifié sans taux : l'échéance n'est pas ventilée. */
  unventilated: number;
}

/**
 * Mode simplifié : à partir de la mensualité (hors assurance) et du capital restant dû à une
 * date. Avec un taux : ventilation estimée. Sans taux : échéances non ventilées, le capital
 * restant dû ne change qu'avec les mises à jour de l'utilisateur.
 */
export function simplifiedSchedule(loan: Loan): VirtualInstallment[] {
  const m = loan.simple_installment_minor ?? 0;
  const crd0 = loan.simple_crd_minor ?? 0;
  if (m <= 0 || crd0 <= 0 || !loan.simple_crd_date) return [];
  const ppy = PERIODS_PER_YEAR[loan.frequency];
  const out: VirtualInstallment[] = [];
  let k = 0;
  while (dueDate(loan.first_due_date, loan.frequency, k) <= loan.simple_crd_date && k < 1200) k++;
  const insuranceInput = { insurance_mode: loan.insurance_mode, insurance_value: loan.insurance_value, principal_minor: loan.principal_minor ?? crd0 };
  if (loan.annual_rate_e6 === null) {
    const n = Math.ceil(crd0 / m);
    for (let j = 0; j < n && j < 600; j++) {
      const ins = insuranceFor(insuranceInput, crd0, ppy);
      const fees = loan.fees_per_installment_minor;
      out.push({ loan_id: loan.id, seq: k + j + 1, due_date: dueDate(loan.first_due_date, loan.frequency, k + j), principal_minor: 0, interest_minor: 0, insurance_minor: ins, fees_minor: fees, total_minor: m + ins + fees, crd_after_minor: crd0, origin: 'estime', unventilated: m });
    }
    return out;
  }
  const i = D(loan.annual_rate_e6).div(1_000_000).div(ppy);
  let crd = crd0;
  for (let j = 0; crd > 0 && j < 1200; j++) {
    const interest = cents(D(crd).mul(i));
    const principal = Math.min(crd, Math.max(0, m - interest));
    if (principal === 0) break; // mensualité insuffisante pour amortir : arrêt (signalé par la fiche)
    const ins = insuranceFor(insuranceInput, crd, ppy);
    const fees = loan.fees_per_installment_minor;
    crd -= principal;
    out.push({ loan_id: loan.id, seq: k + j + 1, due_date: dueDate(loan.first_due_date, loan.frequency, k + j), principal_minor: principal, interest_minor: interest, insurance_minor: ins, fees_minor: fees, total_minor: principal + interest + ins + fees, crd_after_minor: crd, origin: 'estime', unventilated: 0 });
  }
  return out;
}

/** Échéances d'un crédit : enregistrées (bancaire, théorique) ou estimées (simplifié). */
export function installmentsOf(ctx: Ctx, loan: Loan): VirtualInstallment[] {
  if (loan.mode === 'simplifie') return simplifiedSchedule(loan);
  return ctx.snap.installments.filter((i) => i.loan_id === loan.id).map((i) => ({ ...i, unventilated: 0 }));
}

export interface CrdInfo {
  minor: number | null;
  asOf: IsoDate;
  source: string;
}

/** Capital restant dû à une date. */
export function crdAt(ctx: Ctx, loan: Loan, date: IsoDate): CrdInfo {
  if (loan.status === 'solde') return { minor: 0, asOf: date, source: 'crédit soldé' };
  if (loan.mode === 'simplifie') {
    if (loan.simple_crd_minor === null || !loan.simple_crd_date) return { minor: null, asOf: date, source: 'capital restant dû non renseigné' };
    if (date < loan.simple_crd_date) return { minor: null, asOf: date, source: 'date antérieure au capital restant dû renseigné' };
    const paid = simplifiedSchedule(loan).filter((i) => i.due_date <= date).reduce((s, i) => s + i.principal_minor, 0);
    return { minor: loan.simple_crd_minor - paid, asOf: date, source: loan.annual_rate_e6 === null ? `capital déclaré au ${loan.simple_crd_date} (sans taux : non amorti automatiquement)` : `capital déclaré au ${loan.simple_crd_date}, amortissement estimé` };
  }
  const rows = installmentsOf(ctx, loan).filter((i) => i.seq > 0);
  if (rows.length === 0) return { minor: loan.principal_minor, asOf: date, source: 'aucun échéancier' };
  const past = rows.filter((i) => i.due_date <= date);
  if (past.length === 0) return { minor: loan.principal_minor ?? rows[0]!.crd_after_minor + rows[0]!.principal_minor, asOf: date, source: 'avant la première échéance' };
  return { minor: past[past.length - 1]!.crd_after_minor, asOf: date, source: `échéancier ${loan.mode === 'bancaire' ? 'de la banque' : 'théorique'}` };
}

/** Composants d'une échéance, avec leur rubrique et leur nature (pour l'analyse et le suivi). */
export function installmentComponents(ctx: Ctx, i: VirtualInstallment): { ref: string; nature: 'capital_credit' | 'cout_credit'; amount: number; label: string }[] {
  const out: { ref: string; nature: 'capital_credit' | 'cout_credit'; amount: number; label: string }[] = [];
  if (i.principal_minor) out.push({ ref: 'SYS.TECH.CAPITAL', nature: 'capital_credit', amount: i.principal_minor, label: 'capital' });
  if (i.interest_minor) out.push({ ref: 'SYS.CREDIT.INTERETS', nature: 'cout_credit', amount: i.interest_minor, label: 'intérêts' });
  if (i.insurance_minor) out.push({ ref: 'SYS.CREDIT.ASSURANCE', nature: 'cout_credit', amount: i.insurance_minor, label: 'assurance' });
  if (i.fees_minor) out.push({ ref: 'SYS.CREDIT.FRAIS', nature: 'cout_credit', amount: i.fees_minor, label: 'frais' });
  if (i.unventilated) out.push({ ref: 'SYS.CREDIT.NON_VENTILEE', nature: 'cout_credit', amount: i.unventilated, label: 'non ventilée' });
  void ctx;
  return out;
}

export interface ScheduleCheck {
  ok: boolean;
  messages: string[];
}

/** Contrôle d'un échéancier bancaire saisi : total = somme des composants, dates croissantes. */
export function checkBankSchedule(rows: Omit<LoanInstallment, 'loan_id' | 'origin'>[]): ScheduleCheck {
  const messages: string[] = [];
  rows.forEach((r, idx) => {
    if (r.total_minor !== r.principal_minor + r.interest_minor + r.insurance_minor + r.fees_minor)
      messages.push(`Échéance ${r.seq} : le total ne correspond pas à la somme capital + intérêts + assurance + frais`);
    if (idx > 0 && r.due_date <= rows[idx - 1]!.due_date) messages.push(`Échéance ${r.seq} : date non postérieure à l’échéance précédente`);
  });
  return { ok: messages.length === 0, messages };
}
