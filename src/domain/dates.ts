import type { IsoDate, Month } from './types';
import type { ParseResult } from './money';

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isValidIsoDate(s: string): boolean {
  const m = ISO.exec(s);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  return mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(y, mo);
}

export function daysInMonth(year: number, month1: number): number {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

export const monthOf = (d: IsoDate): Month => d.slice(0, 7);
export const firstDay = (m: Month): IsoDate => `${m}-01`;
export function lastDay(m: Month): IsoDate {
  const [y, mo] = m.split('-').map(Number) as [number, number];
  return `${m}-${String(daysInMonth(y, mo)).padStart(2, '0')}`;
}

export function addMonths(m: Month, n: number): Month {
  const [y, mo] = m.split('-').map(Number) as [number, number];
  const idx = y * 12 + (mo - 1) + n;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`;
}

export function monthsBetween(a: Month, b: Month): number {
  const [ya, ma] = a.split('-').map(Number) as [number, number];
  const [yb, mb] = b.split('-').map(Number) as [number, number];
  return yb * 12 + mb - (ya * 12 + ma);
}

/** Date au jour `day` du mois, ramenée au dernier jour si le mois est plus court. */
export function dateInMonth(m: Month, day: number): IsoDate {
  const [y, mo] = m.split('-').map(Number) as [number, number];
  return `${m}-${String(Math.min(day, daysInMonth(y, mo))).padStart(2, '0')}`;
}

export function addDays(d: IsoDate, n: number): IsoDate {
  const [y, mo, dd] = d.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, mo - 1, dd + n));
  return t.toISOString().slice(0, 10);
}

export function daysBetween(a: IsoDate, b: IsoDate): number {
  const ta = Date.parse(`${a}T00:00:00Z`);
  const tb = Date.parse(`${b}T00:00:00Z`);
  return Math.round((tb - ta) / 86400000);
}

/** « Aujourd'hui » évalué en Europe/Paris (convention de l'application). */
export function todayParis(now: Date = new Date()): IsoDate {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Paris',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  return parts;
}

export function formatDateFr(d: IsoDate): string {
  const [y, m, dd] = d.split('-');
  return `${dd}/${m}/${y}`;
}

const MONTHS_FR = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
export function formatMonthFr(m: Month): string {
  const [y, mo] = m.split('-').map(Number) as [number, number];
  return `${MONTHS_FR[mo - 1]} ${y}`;
}

/** Excel stocke les dates en nombre de jours depuis le 30/12/1899. */
export function excelSerialToIso(serial: number): IsoDate {
  const ms = Math.round((serial - 25569) * 86400000);
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Lecture stricte d'une date : AAAA-MM-JJ ou JJ/MM/AAAA (ou JJ.MM.AAAA).
 * L'année à 2 chiffres et le format américain sont refusés.
 */
export function parseDate(raw: unknown): ParseResult<IsoDate> {
  const expected = 'une date AAAA-MM-JJ ou JJ/MM/AAAA';
  if (raw instanceof Date) {
    if (Number.isNaN(raw.getTime())) return { ok: false, reason: 'date invalide', expected };
    return { ok: true, value: raw.toISOString().slice(0, 10) };
  }
  if (typeof raw === 'number') return { ok: true, value: excelSerialToIso(raw) };
  if (typeof raw !== 'string' || raw.trim() === '') return { ok: false, reason: 'date absente', expected };
  const s = raw.trim();
  let iso: string | null = null;
  if (ISO.test(s)) iso = s;
  const fr = /^(\d{1,2})[/.](\d{1,2})[/.](\d{2,4})$/.exec(s);
  if (fr) {
    if (fr[3]!.length !== 4) return { ok: false, reason: `« ${s} » : année à 2 chiffres ambiguë`, expected };
    iso = `${fr[3]}-${fr[2]!.padStart(2, '0')}-${fr[1]!.padStart(2, '0')}`;
  }
  if (!iso) return { ok: false, reason: `« ${s} » n'est pas une date reconnue`, expected };
  if (!isValidIsoDate(iso)) return { ok: false, reason: `« ${s} » n'existe pas dans le calendrier`, expected };
  return { ok: true, value: iso };
}
