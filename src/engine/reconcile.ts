// Propositions de rapprochement : l'utilisateur confirme toujours explicitement.

import { addDays, daysBetween } from '../domain/dates';
import type { Movement } from '../domain/types';
import type { Ctx } from './context';
import { expectedBetween, type Expected } from './occurrences';

export interface Suggestion {
  expected: Expected;
  /** 0 (faible) à 100 (très probable). */
  score: number;
  reasons: string[];
}

export function suggestTargets(ctx: Ctx, m: Movement, max = 5): Suggestion[] {
  const date = m.op_date ?? `${m.period_month}-15`;
  const creditFamily = ctx.rubriqueByRef.get('SYS.CREDIT.NON_VENTILEE')?.family_id;
  const isCreditPayment = ctx.rubrique.get(m.rubrique_id)?.family_id === creditFamily;
  const candidates = expectedBetween(ctx, addDays(date, -45), addDays(date, 45)).filter(
    (e) =>
      (e.kind === 'credit' ? isCreditPayment : e.rubrique_id === m.rubrique_id) &&
      e.currency === m.currency &&
      Math.sign(e.amount_minor) === Math.sign(m.amount_minor) &&
      e.status !== 'soldee',
  );
  const out: Suggestion[] = [];
  for (const e of candidates) {
    const reasons: string[] = [];
    const diffPct = Math.abs(Math.abs(m.amount_minor) - e.remaining) / Math.max(1, e.remaining);
    const days = Math.abs(daysBetween(e.due_date, date));
    let score = 40;
    if (diffPct === 0) (score += 35), reasons.push('montant identique');
    else if (diffPct <= 0.1) (score += 20), reasons.push('montant proche (±10 %)');
    if (days <= 3) (score += 20), reasons.push('date proche');
    else if (days <= 10) (score += 10), reasons.push(`${days} jours d’écart`);
    if (e.account_id && e.account_id === m.account_id) (score += 5), reasons.push('compte prévu');
    out.push({ expected: e, score: Math.min(100, score), reasons });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, max);
}
