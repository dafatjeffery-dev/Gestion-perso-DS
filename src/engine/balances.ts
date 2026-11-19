// Soldes de comptes reconstitués depuis le dernier solde de référence.
// Convention : un solde de référence daté J est le solde en FIN de journée J ;
// les opérations datées J ou avant y sont déjà incluses.

import { daysBetween, formatDateFr } from '../domain/dates';
import type { Account, BalanceReference, IsoDate } from '../domain/types';
import { toBase, type Ctx } from './context';
import { fig, sumFig, type Figure } from './figure';

export interface AccountBalance {
  account: Account;
  /** Solde dans la devise du compte ; null si aucun solde de référence à cette date. */
  minor: number | null;
  missingReason?: string;
  reference: BalanceReference | null;
  /** Ancienneté du solde de référence en jours, à la date demandée. */
  referenceAgeDays: number | null;
  stale: boolean;
  operationsSinceRef: number;
  operationsSinceRefMinor: number;
}

export function latestReference(ctx: Ctx, accountId: number, date: IsoDate): BalanceReference | null {
  let best: BalanceReference | null = null;
  for (const b of ctx.snap.balanceRefs) {
    if (b.account_id === accountId && b.ref_date <= date && (!best || b.ref_date > best.ref_date)) best = b;
  }
  return best;
}

export function accountBalance(ctx: Ctx, accountId: number, date: IsoDate = ctx.today): AccountBalance {
  const account = ctx.account.get(accountId);
  if (!account) throw new Error(`compte ${accountId} inconnu`);
  const ref = latestReference(ctx, accountId, date);
  if (!ref) {
    return {
      account,
      minor: null,
      missingReason: `aucun solde de référence au ${formatDateFr(date)} ou avant`,
      reference: null,
      referenceAgeDays: null,
      stale: false,
      operationsSinceRef: 0,
      operationsSinceRefMinor: 0,
    };
  }
  let n = 0;
  let sum = 0;
  for (const m of ctx.snap.movements) {
    if (m.granularity !== 'operation' || m.account_id !== accountId) continue;
    if (m.op_date! > ref.ref_date && m.op_date! <= date) {
      n++;
      sum += m.amount_minor;
    }
  }
  const age = daysBetween(ref.ref_date, date);
  return {
    account,
    minor: ref.amount_minor + sum,
    reference: ref,
    referenceAgeDays: age,
    stale: age > ctx.snap.household.ref_balance_max_age_days,
    operationsSinceRef: n,
    operationsSinceRefMinor: sum,
  };
}

export const isLiquid = (a: Account) => a.type === 'courant' || a.type === 'epargne';

/** Figure du solde d'un compte, convertie en devise de consolidation au taux de la date de référence. */
export function accountBalanceFigure(ctx: Ctx, accountId: number, date: IsoDate = ctx.today): Figure {
  const b = accountBalance(ctx, accountId, date);
  const a = b.account;
  const label = a.name;
  if (b.minor === null || !b.reference) {
    return fig(`solde.${a.id}`, label, 'Solde reconstitué du compte', null, ctx.base, { missingReason: b.missingReason, sources: [{ kind: 'account', id: a.id }] });
  }
  const conv = toBase(ctx, b.minor, a.currency, b.reference.ref_date);
  const notes: string[] = [`solde de référence du ${formatDateFr(b.reference.ref_date)}`];
  if (b.operationsSinceRef) notes.push(`+ ${b.operationsSinceRef} opération(s) postérieure(s)`);
  if (b.stale) notes.push(`solde de référence ancien de ${b.referenceAgeDays} jours`);
  if (conv.rate) notes.push(`converti au taux du ${formatDateFr(conv.rate.rate_date)}${conv.rate.kind === 'posterieur' ? ' (aucun taux antérieur : taux postérieur utilisé)' : ''}`);
  return fig(`solde.${a.id}`, label, 'Solde de référence + opérations postérieures, converti au taux de la date du solde de référence', conv.minor, ctx.base, {
    missingReason: conv.missingReason,
    sources: [{ kind: 'balance_reference', id: b.reference.id }, { kind: 'account', id: a.id }],
    notes,
  });
}

/**
 * Liquidités totales = comptes courants et d'épargne, actifs ET archivés.
 * Archiver un compte ne modifie jamais ce total.
 */
export function liquidities(ctx: Ctx, date: IsoDate = ctx.today): Figure {
  const comps = ctx.snap.accounts.filter(isLiquid).map((a) => accountBalanceFigure(ctx, a.id, date));
  return sumFig(
    'liquidites_totales',
    'Liquidités totales',
    'Somme des soldes des comptes courants et d’épargne (actifs et archivés), chacun converti au taux de la date de son solde de référence.',
    ctx.base,
    comps,
  );
}
