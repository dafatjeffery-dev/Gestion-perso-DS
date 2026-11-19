import { describe, expect, it } from 'vitest';
import { divRound, formatMoney, parseAmount } from '../../src/domain/money';
import { parseDate, lastDay, addMonths, dateInMonth, todayParis } from '../../src/domain/dates';

describe('arrondi demi vers l’extérieur', () => {
  it.each([
    [5n, 10n, 1n], [-5n, 10n, -1n], [4n, 10n, 0n], [15n, 10n, 2n], [-15n, 10n, -2n], [14n, 10n, 1n], [0n, 7n, 0n],
  ])('%s / %s = %s', (a, b, q) => expect(divRound(a, b)).toBe(q));
});

describe('lecture stricte des montants', () => {
  const ok = (s: unknown, v: number) => expect(parseAmount(s)).toEqual({ ok: true, value: v });
  const ko = (s: unknown) => expect(parseAmount(s).ok).toBe(false);
  it('formats acceptés', () => {
    ok('-12,50', -1250);
    ok('1 234,56', 123456);
    ok('1 234,56', 123456);
    ok('-1 234 567,8', -123456780);
    ok("1'234.56", 123456);
    ok('1234.5', 123450);
    ok('+42', 4200);
    ok('−42,10', -4210);
    ok(-12.5, -1250);
    ok('0,00', 0);
  });
  it('formats ambigus ou invalides refusés', () => {
    ko('1.234');
    ko('1,234');
    ko('1.234,56');
    ko('1,234.56');
    ko('12 34,00');
    ko('abc');
    ko('');
    ko(null);
    ko(12.345);
    ko('12,5 €');
  });
});

describe('dates', () => {
  it('lecture', () => {
    expect(parseDate('2026-02-28')).toEqual({ ok: true, value: '2026-02-28' });
    expect(parseDate('05/03/2026')).toEqual({ ok: true, value: '2026-03-05' });
    expect(parseDate('5.3.2026')).toEqual({ ok: true, value: '2026-03-05' });
    expect(parseDate('2026-02-30').ok).toBe(false);
    expect(parseDate('05/03/26').ok).toBe(false);
    expect(parseDate('13/13/2026').ok).toBe(false);
    expect(parseDate(46000)).toEqual({ ok: true, value: '2025-12-09' });
  });
  it('mois', () => {
    expect(lastDay('2028-02')).toBe('2028-02-29');
    expect(addMonths('2026-11', 3)).toBe('2027-02');
    expect(addMonths('2026-01', -1)).toBe('2025-12');
    expect(dateInMonth('2026-02', 31)).toBe('2026-02-28');
  });
  it('aujourd’hui en Europe/Paris', () => {
    expect(todayParis(new Date('2026-12-31T23:30:00Z'))).toBe('2027-01-01');
    expect(todayParis(new Date('2026-07-01T21:59:00Z'))).toBe('2026-07-01');
  });
  it('format', () => {
    expect(formatMoney(-123456, 'EUR')).toBe('−1 234,56 €');
    expect(formatMoney(512000, 'CHF')).toBe('5 120,00 CHF');
  });
});
