// Réserve de sécurité, fonds affectés et projets ; indicateurs de situation.
// Un paiement de projet consomme la réservation : il réduit à la fois les liquidités et le
// réservé, donc le « non affecté » ne bouge pas (aucun double comptage).

import { formatDateFr, lastDay } from '../domain/dates';
import type { Fund, IsoDate } from '../domain/types';
import { liquidities } from './balances';
import { toBase, type Ctx } from './context';
import { fig, sumFig, type Figure } from './figure';
import { dueDate } from './loans';

export interface FundState {
  fund: Fund;
  allocated: number;
  consumed: number;
  /** Montant réservé = affectations − consommations, dans la devise du fonds. */
  reserved: number;
  /** Progression vers l'objectif (dix-millièmes), null sans objectif. */
  progress_e4: number | null;
}

function movementDate(ctx: Ctx, movementId: number): IsoDate | null {
  const m = ctx.snap.movements.find((x) => x.id === movementId);
  if (!m) return null;
  return m.op_date ?? lastDay(m.period_month);
}

export function fundState(ctx: Ctx, fund: Fund, date: IsoDate = ctx.today): FundState {
  const allocated = ctx.snap.fundAllocations.filter((a) => a.fund_id === fund.id && a.alloc_date <= date).reduce((s, a) => s + a.amount_minor, 0);
  const consumed = ctx.snap.fundConsumptions
    .filter((c) => c.fund_id === fund.id)
    .filter((c) => {
      const d = movementDate(ctx, c.movement_id);
      return d !== null && d <= date;
    })
    .reduce((s, c) => s + c.amount_minor, 0);
  const reserved = allocated - consumed;
  return { fund, allocated, consumed, reserved, progress_e4: fund.target_minor ? Math.round((reserved * 10000) / fund.target_minor) : null };
}

function fundFigure(ctx: Ctx, s: FundState, date: IsoDate): Figure {
  const conv = toBase(ctx, s.reserved, s.fund.currency, date);
  return fig(`fonds.${s.fund.id}`, s.fund.kind === 'reserve' ? 'Réserve de sécurité (affecté)' : s.fund.name, 'Affectations − paiements consommés', conv.minor, ctx.base, {
    sources: [{ kind: 'fund', id: s.fund.id }],
    notes: [`affecté ${s.allocated / 100}, consommé ${s.consumed / 100} (${s.fund.currency})`],
    missingReason: conv.missingReason,
  });
}

export function activeFunds(ctx: Ctx): Fund[] {
  return ctx.snap.funds.filter((f) => f.status !== 'archive');
}

export function reservedFigure(ctx: Ctx, date: IsoDate = ctx.today): Figure {
  const comps = activeFunds(ctx).map((f) => fundFigure(ctx, fundState(ctx, f, date), date));
  return sumFig('reserve', 'Réservé', 'Montant affecté à la réserve de sécurité + montants réservés des fonds et projets, nets des paiements déjà faits.', ctx.base, comps);
}

export interface Situation {
  date: IsoDate;
  liquidites: Figure;
  reserve: Figure;
  nonAffecte: Figure;
  reserveFund: FundState | null;
}

export function situation(ctx: Ctx, date: IsoDate = ctx.today): Situation {
  const liq = liquidities(ctx, date);
  const res = reservedFigure(ctx, date);
  const neg = { ...res, key: 'reserve.neg', label: '− Réservé', value: res.value === null ? null : -res.value, components: res.components.map((c) => ({ ...c, value: c.value === null ? null : -c.value })) };
  const nonAffecte = sumFig('non_affecte', 'Non affecté', 'Liquidités totales − réservé (réserve de sécurité + fonds affectés).', ctx.base, [liq, neg], {
    notes: [`au ${formatDateFr(date)}`],
  });
  const rf = ctx.snap.funds.find((f) => f.kind === 'reserve');
  return { date, liquidites: liq, reserve: res, nonAffecte, reserveFund: rf ? fundState(ctx, rf, date) : null };
}

/** Versements prévus vers un fonds entre deux dates (affectations futures). */
export function plannedContributions(ctx: Ctx, fund: Fund, from: IsoDate, to: IsoDate): { date: IsoDate; amount: number }[] {
  const out: { date: IsoDate; amount: number }[] = [];
  for (const p of ctx.snap.fundPlans.filter((x) => x.fund_id === fund.id)) {
    for (let k = 0; k < 1200; k++) {
      const d = dueDate(p.start_date, p.frequency, k);
      if (d > to || (p.end_date && d > p.end_date)) break;
      if (d >= from) out.push({ date: d, amount: p.amount_minor });
    }
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : 1));
}
