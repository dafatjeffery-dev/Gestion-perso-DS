// Prévision de trésorerie mois par mois (docs/ARCHITECTURE.md § 5.7, REGLES_DE_CALCUL.md § 9).

import { addMonths, formatDateFr, formatMonthFr, lastDay } from '../domain/dates';
import type { Account, Currency, IsoDate, Month } from '../domain/types';
import { isLiquid, latestReference } from './balances';
import { toBaseHyp, type Ctx } from './context';
import { fig, sumFig, type Figure } from './figure';
import { activeFunds, fundState, plannedContributions } from './funds';
import { realLines, type RealLines } from './lines';
import { expectedAccount, expectedBetween, type Expected } from './occurrences';
import { trackRubrique } from './tracking';

export interface ForecastFlow {
  date: IsoDate;
  account_id: number | null;
  amount_minor: number;
  currency: Currency;
  label: string;
  kind: 'echeance' | 'credit' | 'budget' | 'retard' | 'realise_suppose';
}

export interface ForecastPoint {
  month: Month;
  date: IsoDate;
  /** Liquidités prévues en fin de mois (devise de consolidation, taux d'hypothèse). */
  liquidites: Figure;
  reserve: Figure;
  marge: Figure;
}

export interface Forecast {
  points: ForecastPoint[];
  hypothesisRateE6: number | null;
  hypothesisLabel: string;
  minimum: Figure;
  minimumMonth: Month | null;
  marge: Figure;
  margeMonth: Month | null;
  excludedAccounts: Account[];
  warnings: string[];
  flows: ForecastFlow[];
}

/** Taux d'hypothèse : paramètre `taux_hypothese_e6` s'il existe, sinon dernier taux connu. */
export function hypothesisRate(ctx: Ctx): { e6: number | null; label: string } {
  const latest = ctx.rates.latest();
  return latest ? { e6: latest.eur_chf_e6, label: `dernier taux connu (${formatDateFr(latest.rate_date)}) : 1 € = ${(latest.eur_chf_e6 / 1e6).toFixed(4).replace('.', ',')} CHF` } : { e6: null, label: 'aucun taux enregistré' };
}

function defaultAccountFor(ctx: Ctx, currency: Currency): number | null {
  return ctx.snap.accounts.find((a) => a.is_default_for_currency && a.currency === currency && a.status === 'actif')?.id ?? null;
}

export function forecast(ctx: Ctx, opts: { horizon?: number; real?: RealLines; hypothesisE6?: number } = {}): Forecast {
  const horizon = opts.horizon ?? ctx.snap.household.forecast_horizon_months;
  const real = opts.real ?? realLines(ctx);
  const hyp = opts.hypothesisE6 ? { e6: opts.hypothesisE6, label: `taux d’hypothèse : 1 € = ${(opts.hypothesisE6 / 1e6).toFixed(4).replace('.', ',')} CHF` } : hypothesisRate(ctx);
  const warnings: string[] = [];
  const startMonth = ctx.currentMonth;
  const endDate = lastDay(addMonths(startMonth, horizon - 1));
  const liquid = ctx.snap.accounts.filter(isLiquid);
  const refs = new Map(liquid.map((a) => [a.id, latestReference(ctx, a.id, ctx.today)]));
  const excluded = liquid.filter((a) => !refs.get(a.id));
  if (excluded.length) warnings.push(`Sans solde constaté, exclus de la prévision : ${excluded.map((a) => a.name).join(', ')}.`);
  const included = liquid.filter((a) => refs.get(a.id));
  for (const a of included) {
    const r = refs.get(a.id)!;
    const age = Math.round((Date.parse(ctx.today) - Date.parse(r.ref_date)) / 86400000);
    if (age > ctx.snap.household.ref_balance_max_age_days) warnings.push(`« ${a.name} » : solde constaté du ${formatDateFr(r.ref_date)} (${age} jours) ; la prévision part de ce solde.`);
  }
  const hasChf = included.some((a) => a.currency !== ctx.base);
  if (hasChf && hyp.e6 === null) warnings.push('Aucun taux EUR/CHF : les comptes en CHF ne peuvent pas être consolidés.');

  // 1) flux attendus
  const flows: ForecastFlow[] = [];
  const earliestRef = included.reduce<IsoDate>((m, a) => (refs.get(a.id)!.ref_date < m ? refs.get(a.id)!.ref_date : m), ctx.today);
  const expected = expectedBetween(ctx, earliestRef, endDate);
  const accountOf = (e: Expected) => expectedAccount(ctx, e.account_id, e.currency);
  for (const e of expected) {
    if (e.status === 'soldee' || e.status === 'incluse') continue;
    const acc = accountOf(e);
    const account = acc ? ctx.account.get(acc) : undefined;
    const ref = acc ? refs.get(acc) : undefined;
    if (ref && e.due_date <= ref.ref_date) continue;
    const signed = Math.sign(e.amount_minor) * e.remaining;
    if (!signed) continue;
    if (e.due_date >= ctx.today) flows.push({ date: e.due_date, account_id: acc, amount_minor: signed, currency: e.currency, label: e.label, kind: e.kind === 'credit' ? 'credit' : 'echeance' });
    else if (account?.tracking === 'synthetique') flows.push({ date: e.due_date, account_id: acc, amount_minor: signed, currency: e.currency, label: `${e.label} (supposée réalisée)`, kind: 'realise_suppose' });
    else flows.push({ date: ctx.today, account_id: acc, amount_minor: signed, currency: e.currency, label: `${e.label} (en retard, reportée à aujourd’hui)`, kind: 'retard' });
  }
  // 2) enveloppes libres des budgets : reste du mois en cours, puis enveloppe de chaque mois futur
  for (let k = 0; k < horizon; k++) {
    const m = addMonths(startMonth, k);
    for (const r of ctx.snap.rubriques) {
      const fam = ctx.family.get(r.family_id)!;
      if (fam.direction === 'technique') continue;
      const hasBudget = ctx.snap.budgetPlans.some((p) => p.rubrique_id === r.id) || ctx.snap.budgetMonths.some((b) => b.rubrique_id === r.id && b.period_month === m);
      if (!hasBudget && r.estimation_method === 'budget') continue;
      const t = trackRubrique(ctx, r.id, m, real, expected);
      const libre = t.reste.components.find((c) => c.key === 'reste.libre')?.value ?? null;
      if (!libre) continue;
      const cur = ctx.base;
      const acc = r.default_account_id ?? defaultAccountFor(ctx, cur);
      const sign = fam.direction === 'depense' ? -1 : 1;
      flows.push({ date: lastDay(m) < ctx.today ? ctx.today : lastDay(m), account_id: acc, amount_minor: sign * libre, currency: cur, label: `Budget « ${r.name} » ${formatMonthFr(m)} (reste de l’enveloppe)`, kind: 'budget' });
    }
  }
  const unassigned = flows.filter((f) => f.account_id === null || !included.some((a) => a.id === f.account_id));
  if (unassigned.length) warnings.push(`${unassigned.length} flux prévu(s) sans compte suivi (pas de compte par défaut dans leur devise) : comptés dans le total consolidé seulement.`);

  // 3) soldes de fin de mois
  const points: ForecastPoint[] = [];
  let minV: number | null = null;
  let minM: Month | null = null;
  let margeV: number | null = null;
  let margeM: Month | null = null;
  let minFig: Figure | null = null;
  let margeFig: Figure | null = null;
  for (let k = 0; k < horizon; k++) {
    const m = addMonths(startMonth, k);
    const date = lastDay(m);
    const comps: Figure[] = included.map((a) => {
      const ref = refs.get(a.id)!;
      let bal = ref.amount_minor;
      for (const mv of ctx.snap.movements) if (mv.account_id === a.id && mv.granularity === 'operation' && mv.op_date! > ref.ref_date && mv.op_date! <= ctx.today) bal += mv.amount_minor;
      let flowSum = 0;
      for (const f of flows) if (f.account_id === a.id && f.date > ref.ref_date && f.date <= date) flowSum += f.currency === a.currency ? f.amount_minor : hyp.e6 ? toBaseHyp(f.amount_minor, f.currency, a.currency, hyp.e6) : 0;
      const v = bal + flowSum;
      const conv = a.currency === ctx.base ? v : hyp.e6 ? toBaseHyp(v, a.currency, ctx.base, hyp.e6) : null;
      return fig(`prev.${m}.${a.id}`, a.name, 'Solde constaté + opérations postérieures + flux prévus jusqu’à la fin du mois', conv, ctx.base, {
        sources: [{ kind: 'account', id: a.id }],
        notes: [`solde constaté du ${formatDateFr(ref.ref_date)}`, ...(a.currency !== ctx.base ? [hyp.label] : [])],
        missingReason: 'taux EUR/CHF manquant',
      });
    });
    const unassignedSum = unassigned.filter((f) => f.date <= date).reduce((s, f) => s + (f.currency === ctx.base ? f.amount_minor : hyp.e6 ? toBaseHyp(f.amount_minor, f.currency, ctx.base, hyp.e6) : 0), 0);
    if (unassigned.length) comps.push(fig(`prev.${m}.sans_compte`, 'Flux prévus sans compte suivi', 'Flux prévus dont le compte n’est pas suivi', unassignedSum, ctx.base));
    const liq = sumFig(`prev.${m}`, `Liquidités prévues fin ${formatMonthFr(m)}`, 'Somme des soldes prévus des comptes courants et d’épargne au dernier jour du mois (taux d’hypothèse)', ctx.base, comps);
    // réservé prévu
    const resComps: Figure[] = activeFunds(ctx).map((f) => {
      const st = fundState(ctx, f, ctx.today);
      const contrib = plannedContributions(ctx, f, ctx.today, date).filter((c) => c.date > ctx.today).reduce((s, c) => s + c.amount, 0);
      const pays = expected.filter((e) => e.fund_id === f.id && e.status !== 'soldee' && e.due_date <= date).reduce((s, e) => s + e.remaining, 0);
      const v = Math.max(0, st.reserved + contrib - pays);
      return fig(`res.${m}.${f.id}`, f.name, 'Réservé aujourd’hui + versements prévus − paiements prévus du fonds', f.currency === ctx.base ? v : hyp.e6 ? toBaseHyp(v, f.currency, ctx.base, hyp.e6) : null, ctx.base, { sources: [{ kind: 'fund', id: f.id }] });
    });
    const res = sumFig(`res.${m}`, `Réservé prévu fin ${formatMonthFr(m)}`, 'Réserve + fonds, compte tenu des versements et paiements prévus', ctx.base, resComps);
    const marge = sumFig(`marge.${m}`, `Marge après réserve et fonds fin ${formatMonthFr(m)}`, 'Liquidités prévues − réservé prévu', ctx.base, [liq, { ...res, label: '− Réservé prévu', value: res.value === null ? null : -res.value, components: [] }]);
    points.push({ month: m, date, liquidites: liq, reserve: res, marge });
    if (liq.value !== null && (minV === null || liq.value < minV)) {
      minV = liq.value;
      minM = m;
      minFig = liq;
    }
    if (marge.value !== null && (margeV === null || marge.value < margeV)) {
      margeV = marge.value;
      margeM = m;
      margeFig = marge;
    }
  }
  const scope = excluded.length ? ` (hors ${excluded.map((a) => a.name).join(', ')})` : '';
  const minimum = minFig
    ? { ...minFig, key: 'minimum', label: 'Minimum des soldes prévus en fin de mois', definition: `Plus bas des soldes consolidés prévus au dernier jour de chaque mois de l’horizon (${horizon} mois)${scope} : fin ${formatMonthFr(minM!)}.` }
    : fig('minimum', 'Minimum des soldes prévus en fin de mois', 'Aucune prévision possible', null, ctx.base, { missingReason: 'aucun compte avec solde constaté' });
  const margeOut = margeFig
    ? { ...margeFig, key: 'marge', label: 'Marge après réserve et fonds', definition: `Plus bas, sur l’horizon, de (liquidités prévues − réservé prévu) en fin de mois${scope} : fin ${formatMonthFr(margeM!)}.` }
    : fig('marge', 'Marge après réserve et fonds', 'Aucune prévision possible', null, ctx.base, { missingReason: 'aucun compte avec solde constaté' });
  return { points, hypothesisRateE6: hyp.e6, hypothesisLabel: hyp.label, minimum, minimumMonth: minM, marge: margeOut, margeMonth: margeM, excludedAccounts: excluded, warnings, flows };
}
