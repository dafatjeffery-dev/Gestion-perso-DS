import type { Currency } from './types';

/** Montant en unités mineures (centimes) avec sa devise. */
export interface Money {
  minor: number;
  currency: Currency;
}

export const money = (minor: number, currency: Currency): Money => ({ minor, currency });

/**
 * Division entière arrondie au plus proche, demi vers l'extérieur (0,5 → 1 ; −0,5 → −1).
 * Convention unique de l'application (docs/ARCHITECTURE.md § 3).
 */
export function divRound(num: bigint, den: bigint): bigint {
  if (den === 0n) throw new Error('division par zéro');
  if (den < 0n) {
    num = -num;
    den = -den;
  }
  const neg = num < 0n;
  const a = neg ? -num : num;
  const q = (2n * a + den) / (2n * den);
  return neg ? -q : q;
}

/** Arrondi d'un réel au centime selon la même convention (pour les calculs décimaux). */
export function roundHalfAway(x: number): number {
  const r = Math.floor(Math.abs(x) + 0.5);
  return x < 0 ? -r : r;
}

export function assertSafeMinor(n: number): number {
  if (!Number.isSafeInteger(n)) throw new Error(`montant non entier ou hors limites : ${n}`);
  return n;
}

export function sumMinor(values: readonly number[]): number {
  let s = 0;
  for (const v of values) s += v;
  return assertSafeMinor(s);
}

const SYMBOL: Record<Currency, string> = { EUR: '€', CHF: 'CHF' };
const NNBSP = ' ';

/** « −1 234,56 € » / « 1 234,56 CHF ». Le signe moins est le vrai signe typographique. */
export function formatMoney(minor: number, currency: Currency, opts: { decimals?: boolean; signed?: boolean } = {}): string {
  const decimals = opts.decimals ?? true;
  const neg = minor < 0;
  const abs = Math.abs(minor);
  const units = Math.floor(abs / 100);
  const cents = abs % 100;
  let intPart = units.toString().replace(/\B(?=(\d{3})+(?!\d))/g, NNBSP);
  let s: string;
  if (decimals) s = `${intPart},${cents.toString().padStart(2, '0')}`;
  else {
    intPart = Math.round(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, NNBSP);
    s = intPart;
  }
  const sign = neg ? '−' : opts.signed && minor > 0 ? '+' : '';
  return `${sign}${s}${NNBSP}${SYMBOL[currency]}`;
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; reason: string; expected: string };

const SPACES = /[\u0020\u00a0\u202f\u2009]/g;
const HAS_SPACE = /[\u0020\u00a0\u202f\u2009]/;

/**
 * Lecture stricte d'un montant saisi ou importé (docs/FORMAT_IMPORT.md).
 * Acceptés : -1234.56 ; -1234,56 ; -1 234,56 (espaces normales, insécables ou fines) ; 1'234.56.
 * Refusés : plus de 2 décimales, séparateur décimal ambigu (1.234 / 1,234), mélange . et ,.
 */
export function parseAmount(raw: unknown): ParseResult<number> {
  const expected = 'un montant comme -1234,56 ou 1 234,56 (2 décimales au plus)';
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return { ok: false, reason: 'nombre invalide', expected };
    const m = Math.round(raw * 100);
    if (Math.abs(raw * 100 - m) > 1e-6) return { ok: false, reason: 'plus de 2 décimales', expected };
    return { ok: true, value: m };
  }
  if (typeof raw !== 'string') return { ok: false, reason: 'montant absent', expected };
  let s = raw.trim().replace(/[−–]/g, '-');
  if (s === '') return { ok: false, reason: 'montant absent', expected };
  let sign = 1;
  if (s.startsWith('+')) s = s.slice(1);
  else if (s.startsWith('-')) {
    sign = -1;
    s = s.slice(1);
  }
  s = s.trim();
  const hasSpaceGroups = /^\d{1,3}([    ]\d{3})+([.,]\d{1,2})?$/.test(s);
  const hasQuoteGroups = /^\d{1,3}('\d{3})+(\.\d{1,2})?$/.test(s);
  if (hasSpaceGroups) s = s.replace(SPACES, '');
  else if (hasQuoteGroups) s = s.replace(/'/g, '');
  else if (HAS_SPACE.test(s) || s.includes("'")) {
    return { ok: false, reason: `séparateur de milliers mal placé dans « ${raw} »`, expected };
  }
  if (s.includes('.') && s.includes(',')) {
    return { ok: false, reason: `« ${raw} » mélange point et virgule : séparateur décimal ambigu`, expected };
  }
  const m = /^(\d+)(?:[.,](\d+))?$/.exec(s);
  if (!m) return { ok: false, reason: `« ${raw} » n'est pas un nombre`, expected };
  const dec = m[2] ?? '';
  if (dec.length > 2) {
    return { ok: false, reason: `« ${raw} » a ${dec.length} chiffres après le séparateur : ambigu ou trop précis`, expected };
  }
  const minor = Number(m[1]) * 100 + Number(dec.padEnd(2, '0') || '0');
  if (!Number.isSafeInteger(minor)) return { ok: false, reason: 'montant trop grand', expected };
  return { ok: true, value: sign * minor };
}
