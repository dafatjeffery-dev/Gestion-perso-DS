// Conversions EUR/CHF. Règles : docs/ARCHITECTURE.md § 3 et docs/REGLES_DE_CALCUL.md.

import { divRound } from '../domain/money';
import type { Currency, FxRate, IsoDate } from '../domain/types';

export interface RateLookup {
  /** CHF pour 1 EUR × 10⁶. */
  eur_chf_e6: number;
  /** Date du taux réellement utilisé. */
  rate_date: IsoDate;
  /** 'exact' : taux du jour ; 'anterieur' : dernier taux connu avant ; 'posterieur' : aucun taux antérieur (signalé). */
  kind: 'exact' | 'anterieur' | 'posterieur' | 'hypothese';
}

export class RateTable {
  private readonly sorted: FxRate[];
  constructor(rates: readonly FxRate[]) {
    this.sorted = [...rates].sort((a, b) => (a.rate_date < b.rate_date ? -1 : 1));
  }

  get size(): number {
    return this.sorted.length;
  }

  /** Taux applicable à une date ; null si la table est vide. */
  at(date: IsoDate): RateLookup | null {
    const r = this.sorted;
    if (r.length === 0) return null;
    let lo = 0;
    let hi = r.length - 1;
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (r[mid]!.rate_date <= date) {
        best = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (best === -1) {
      const first = r[0]!;
      return { eur_chf_e6: first.eur_chf_e6, rate_date: first.rate_date, kind: 'posterieur' };
    }
    const row = r[best]!;
    return { eur_chf_e6: row.eur_chf_e6, rate_date: row.rate_date, kind: row.rate_date === date ? 'exact' : 'anterieur' };
  }

  latest(): FxRate | null {
    return this.sorted[this.sorted.length - 1] ?? null;
  }
}

/** Conversion au centime, arrondi demi vers l'extérieur. Montant d'origine jamais modifié. */
export function convertMinor(minor: number, from: Currency, to: Currency, eurChfE6: number): number {
  if (from === to) return minor;
  if (eurChfE6 <= 0) throw new Error('taux invalide');
  const a = BigInt(minor);
  const r = BigInt(eurChfE6);
  const out = from === 'EUR' ? divRound(a * r, 1_000_000n) : divRound(a * 1_000_000n, r);
  return Number(out);
}

/** Saisie « 0,9412 » → 941200. */
export function parseRate(raw: string): number | null {
  const s = raw.trim().replace(',', '.');
  if (!/^\d+(\.\d{1,6})?$/.test(s)) return null;
  const [i, d = ''] = s.split('.');
  const v = Number(i) * 1_000_000 + Number(d.padEnd(6, '0'));
  return v > 0 ? v : null;
}

export function formatRate(e6: number): string {
  return (e6 / 1_000_000).toFixed(4).replace('.', ',');
}
