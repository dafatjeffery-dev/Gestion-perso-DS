// Patrimoine net et projection long terme en trois scénarios (REGLES_DE_CALCUL.md § 11).

import { addMonths, formatDateFr } from '../domain/dates';
import type { Currency, IsoDate, ScenarioParams, Scenario } from '../domain/types';
import { latestReference } from './balances';
import { toBase, toBaseHyp, type Ctx } from './context';
import { fig, sumFig, type Figure } from './figure';
import { situation } from './funds';
import { crdAt, installmentsOf } from './loans';
import { realLines } from './lines';
import { trackRubrique } from './tracking';

export function assetValue(ctx: Ctx, assetId: number, date: IsoDate): { value: number | null; date: IsoDate | null } {
  const v = ctx.snap.assetValuations.filter((x) => x.asset_id === assetId && x.valuation_date <= date).sort((a, b) => (a.valuation_date < b.valuation_date ? 1 : -1))[0];
  return v ? { value: v.value_minor, date: v.valuation_date } : { value: null, date: null };
}

export function investmentsFigure(ctx: Ctx, date: IsoDate = ctx.today): Figure {
  const comps = ctx.snap.accounts
    .filter((a) => a.type === 'investissement')
    .map((a) => {
      const ref = latestReference(ctx, a.id, date);
      if (!ref) return fig(`inv.${a.id}`, a.name, 'Valeur déclarée datée', null, ctx.base, { missingReason: 'aucune valeur déclarée' });
      const conv = toBase(ctx, ref.amount_minor, a.currency, ref.ref_date);
      return fig(`inv.${a.id}`, a.name, 'Dernière valeur déclarée, convertie au taux de sa date', conv.minor, ctx.base, { notes: [`valeur du ${formatDateFr(ref.ref_date)}`], sources: [{ kind: 'balance_reference', id: ref.id }], missingReason: conv.missingReason });
    });
  return sumFig('investissements', 'Investissements', 'Dernières valeurs déclarées des comptes d’investissement', ctx.base, comps);
}

export function realEstateFigure(ctx: Ctx, date: IsoDate = ctx.today): Figure {
  const comps = ctx.snap.assets
    .filter((a) => a.status === 'actif')
    .map((a) => {
      const v = assetValue(ctx, a.id, date);
      if (v.value === null) return fig(`bien.${a.id}`, a.name, 'Valeur déclarée datée × quote-part', null, ctx.base, { missingReason: 'aucune valeur déclarée' });
      const share = Math.round((v.value * a.ownership_pct_e2) / 10000);
      const conv = toBase(ctx, share, a.currency, v.date!);
      return fig(`bien.${a.id}`, a.name, 'Valeur déclarée × quote-part, convertie au taux de sa date', conv.minor, ctx.base, { notes: [`valeur du ${formatDateFr(v.date!)}`, `quote-part ${(a.ownership_pct_e2 / 100).toFixed(0)} %`], sources: [{ kind: 'asset', id: a.id }], missingReason: conv.missingReason });
    });
  return sumFig('biens', 'Biens immobiliers et autres', 'Valeurs déclarées datées des biens, à hauteur de la quote-part du foyer', ctx.base, comps);
}

export function debtFigure(ctx: Ctx, date: IsoDate = ctx.today): Figure {
  const comps = ctx.snap.loans
    .filter((l) => l.status !== 'solde')
    .map((l) => {
      const c = crdAt(ctx, l, date);
      const conv = c.minor === null ? { minor: null, missingReason: c.source } : toBase(ctx, c.minor, l.currency, date);
      return fig(`crd.${l.id}`, l.label, 'Capital restant dû', conv.minor === null ? null : -conv.minor, ctx.base, { notes: [c.source], missingReason: conv.missingReason ?? c.source });
    });
  return sumFig('dettes', '− Capital restant dû', 'Capital restant dû des crédits non soldés (archivés compris)', ctx.base, comps);
}

/** Patrimoine net = liquidités + investissements + biens − capital restant dû. */
export function netWorth(ctx: Ctx, date: IsoDate = ctx.today): Figure {
  return sumFig('patrimoine_net', 'Patrimoine net', 'Liquidités + investissements + biens (valeurs déclarées datées) − capital restant dû', ctx.base, [situation(ctx, date).liquidites, investmentsFigure(ctx, date), realEstateFigure(ctx, date), debtFigure(ctx, date)]);
}

// ------------------------------------------------------------------ projection

export function scenarioParams(s: Scenario): ScenarioParams {
  return JSON.parse(s.params_json) as ScenarioParams;
}

export interface ProjectionYear {
  year: number;
  /** Patrimoine net nominal (euros courants). */
  nominal: number;
  /** En euros constants de l'année de départ. */
  real: number;
}

export interface ProjectionInputs {
  startYear: number;
  endYear: number;
  /** Montants de départ par devise (unités mineures). */
  liquid: Record<Currency, number>;
  invest: Record<Currency, number>;
  realEstate: Record<Currency, number>;
  /** Flux annuels structurels (12 prochains mois) par devise : revenus ordinaires et dépenses prévues hors capital. */
  income: Record<Currency, number>;
  expenses: Record<Currency, number>;
  /** Capital remboursé et capital restant dû par année, par devise. */
  capitalByYear: Map<number, Record<Currency, number>>;
  crdByYear: Map<number, Record<Currency, number>>;
  missing: string[];
}

const zero = (): Record<Currency, number> => ({ EUR: 0, CHF: 0 });

export function projectionInputs(ctx: Ctx): ProjectionInputs {
  const missing: string[] = [];
  const startYear = Number(ctx.today.slice(0, 4));
  const retire = ctx.snap.persons.map((p) => p.retirement_date).filter((d): d is string => !!d).sort();
  const endYear = retire.length ? Number(retire[retire.length - 1]!.slice(0, 4)) : startYear + 25;
  if (!retire.length) missing.push('aucune date de retraite renseignée : horizon de 25 ans');
  const liquid = zero();
  const invest = zero();
  const realEstate = zero();
  for (const a of ctx.snap.accounts) {
    const ref = latestReference(ctx, a.id, ctx.today);
    if (!ref) {
      if (a.status === 'actif') missing.push(`« ${a.name} » sans solde ni valeur déclarée`);
      continue;
    }
    // solde reconstitué pour les comptes liquides
    let v = ref.amount_minor;
    if (a.type !== 'investissement') for (const m of ctx.snap.movements) if (m.account_id === a.id && m.granularity === 'operation' && m.op_date! > ref.ref_date && m.op_date! <= ctx.today) v += m.amount_minor;
    (a.type === 'investissement' ? invest : liquid)[a.currency] += v;
  }
  for (const as of ctx.snap.assets.filter((x) => x.status === 'actif')) {
    const v = assetValue(ctx, as.id, ctx.today);
    if (v.value === null) missing.push(`« ${as.name} » sans valeur déclarée`);
    else realEstate[as.currency] += Math.round((v.value * as.ownership_pct_e2) / 10000);
  }
  const income = zero();
  const expenses = zero();
  const real = realLines(ctx);
  for (let k = 0; k < 12; k++) {
    const m = addMonths(ctx.currentMonth, k);
    for (const r of ctx.snap.rubriques) {
      const f = ctx.family.get(r.family_id)!;
      if (f.direction === 'technique') continue;
      const t = trackRubrique(ctx, r.id, m, real);
      const bucket = f.direction === 'revenu' ? income : expenses;
      // prévu structurel : échéances identifiées (dans leur devise, hors revenus exceptionnels) + enveloppe libre
      for (const e of t.expected) if (e.nature !== 'revenu_exceptionnel') bucket[e.currency] += f.direction === 'revenu' ? e.amount_minor : -e.amount_minor;
      bucket[ctx.base] += t.prevu.components[1]?.value ?? 0;
    }
  }
  const capitalByYear = new Map<number, Record<Currency, number>>();
  const crdByYear = new Map<number, Record<Currency, number>>();
  for (let y = startYear; y <= endYear; y++) {
    const cap = zero();
    const crd = zero();
    for (const l of ctx.snap.loans.filter((x) => x.status !== 'solde')) {
      for (const i of installmentsOf(ctx, l)) if (i.due_date.startsWith(String(y)) && i.due_date > ctx.today) cap[l.currency] += i.principal_minor;
      const c = crdAt(ctx, l, `${y}-12-31`);
      if (c.minor !== null) crd[l.currency] += c.minor;
    }
    capitalByYear.set(y, cap);
    crdByYear.set(y, crd);
  }
  return { startYear, endYear, liquid, invest, realEstate, income, expenses, capitalByYear, crdByYear, missing };
}

/**
 * Projection annuelle d'un scénario (fonction pure) :
 * épargne(y) = revenus × (1+croissance)^t − dépenses × (1+inflation)^t − capital remboursé(y) ;
 * liquidités(y+1) = liquidités(y) + épargne(y) ; placements(y+1) = placements(y) × (1+rendement) ;
 * biens(y+1) = biens(y) × (1+évolution immobilière) ; dettes = capital restant dû des échéanciers ;
 * CHF converti au taux EUR/CHF du scénario. Euros constants = nominal / (1+inflation)^t.
 */
export function project(inp: ProjectionInputs, p: ScenarioParams): ProjectionYear[] {
  const rate = Math.round(p.eur_chf * 1_000_000);
  const eur = (b: Record<Currency, number>) => b.EUR + toBaseHyp(b.CHF, 'CHF', 'EUR', rate);
  const liquid = { ...inp.liquid };
  const invest = { ...inp.invest };
  const estate = { ...inp.realEstate };
  const out: ProjectionYear[] = [];
  for (let y = inp.startYear; y <= inp.endYear; y++) {
    const t = y - inp.startYear;
    if (t > 0) {
      for (const c of ['EUR', 'CHF'] as Currency[]) {
        // épargne des 12 mois écoulés depuis le point précédent
        const save = Math.round(inp.income[c] * (1 + p.income_growth) ** (t - 1) - inp.expenses[c] * (1 + p.inflation) ** (t - 1)) - (inp.capitalByYear.get(y - 1)?.[c] ?? 0);
        liquid[c] += save;
        invest[c] = Math.round(invest[c] * (1 + p.return_default));
        estate[c] = Math.round(estate[c] * (1 + p.real_estate));
      }
    }
    const crd = inp.crdByYear.get(y) ?? zero();
    const nominal = eur(liquid) + eur(invest) + eur(estate) - eur(crd);
    out.push({ year: y, nominal, real: Math.round(nominal / (1 + p.inflation) ** t) });
  }
  return out;
}

export interface ScenarioProjection {
  kind: Scenario['kind'];
  params: ScenarioParams;
  years: ProjectionYear[];
}

export function projections(ctx: Ctx): { inputs: ProjectionInputs; scenarios: ScenarioProjection[] } {
  const inputs = projectionInputs(ctx);
  const order: Scenario['kind'][] = ['prudent', 'central', 'favorable'];
  const scenarios = order.map((k) => {
    const s = ctx.snap.scenarios.find((x) => x.kind === k)!;
    const params = scenarioParams(s);
    return { kind: k, params, years: project(inputs, params) };
  });
  return { inputs, scenarios };
}

/** Arrondi d'affichage : au millier d'euros (pas de fausse précision). */
export const roundThousands = (minor: number) => Math.round(minor / 100_000) * 100_000;
