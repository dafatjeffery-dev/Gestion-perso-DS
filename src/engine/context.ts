// Index du snapshot partagés par tous les calculs. Construit une fois par rendu.

import { monthOf } from '../domain/dates';
import type {
  Account,
  Currency,
  Family,
  IsoDate,
  Month,
  Rubrique,
  Snapshot,
} from '../domain/types';
import { RateTable, convertMinor, type RateLookup } from './fx';

export type MonthState = 'futur' | 'en_cours' | 'ecoule' | 'cloture';

export interface Ctx {
  snap: Snapshot;
  today: IsoDate;
  currentMonth: Month;
  base: Currency;
  rates: RateTable;
  account: Map<number, Account>;
  rubrique: Map<number, Rubrique>;
  family: Map<number, Family>;
  rubriqueByRef: Map<string, Rubrique>;
  closedMonths: Set<Month>;
}

export function buildCtx(snap: Snapshot, today: IsoDate): Ctx {
  return {
    snap,
    today,
    currentMonth: monthOf(today),
    base: snap.household.base_currency,
    rates: new RateTable(snap.fxRates),
    account: new Map(snap.accounts.map((a) => [a.id, a])),
    rubrique: new Map(snap.rubriques.map((r) => [r.id, r])),
    family: new Map(snap.families.map((f) => [f.id, f])),
    rubriqueByRef: new Map(snap.rubriques.map((r) => [r.ref, r])),
    closedMonths: new Set(snap.monthStatus.map((m) => m.period_month)),
  };
}

export function monthState(ctx: Ctx, m: Month): MonthState {
  if (m > ctx.currentMonth) return 'futur';
  if (m === ctx.currentMonth) return 'en_cours';
  return ctx.closedMonths.has(m) ? 'cloture' : 'ecoule';
}

export function familyOf(ctx: Ctx, rubriqueId: number): Family {
  const r = ctx.rubrique.get(rubriqueId);
  if (!r) throw new Error(`rubrique ${rubriqueId} inconnue`);
  return ctx.family.get(r.family_id)!;
}

export function sysRubrique(ctx: Ctx, ref: string): Rubrique {
  const r = ctx.rubriqueByRef.get(ref);
  if (!r) throw new Error(`rubrique système ${ref} absente`);
  return r;
}

export interface Converted {
  minor: number | null;
  rate: RateLookup | null;
  missingReason?: string;
}

/** Conversion vers la devise de consolidation au taux d'une date (règle du réel / des soldes). */
export function toBase(ctx: Ctx, minor: number, currency: Currency, date: IsoDate, target: Currency = ctx.base): Converted {
  if (currency === target) return { minor, rate: null };
  const rate = ctx.rates.at(date);
  if (!rate) return { minor: null, rate: null, missingReason: 'aucun taux EUR/CHF enregistré' };
  return { minor: convertMinor(minor, currency, target, rate.eur_chf_e6), rate };
}

/** Conversion au taux d'hypothèse (prévisions). */
export function toBaseHyp(minor: number, currency: Currency, target: Currency, hypE6: number): number {
  return currency === target ? minor : convertMinor(minor, currency, target, hypE6);
}
