import { describe, expect, it } from 'vitest';
import { RateTable, convertMinor, parseRate } from '../../src/engine/fx';

describe('taux EUR/CHF', () => {
  const t = new RateTable([
    { rate_date: '2026-11-13', eur_chf_e6: 941000, source: 'manuel', updated_at: '' },
    { rate_date: '2026-11-18', eur_chf_e6: 941200, source: 'manuel', updated_at: '' },
  ]);
  it('taux exact, antérieur, postérieur signalé', () => {
    expect(t.at('2026-11-18')).toMatchObject({ kind: 'exact', eur_chf_e6: 941200 });
    expect(t.at('2026-11-15')).toMatchObject({ kind: 'anterieur', rate_date: '2026-11-13' });
    expect(t.at('2026-01-01')).toMatchObject({ kind: 'posterieur', rate_date: '2026-11-13' });
    expect(new RateTable([]).at('2026-01-01')).toBeNull();
  });
  it('conversion au centime (exemple de la documentation)', () => {
    // 935,00 CHF au taux 0,9412 = 993,4126… € → 993,41 €
    expect(convertMinor(93500, 'CHF', 'EUR', 941200)).toBe(99341);
    // 5 120 CHF → 5 439,86 €
    expect(convertMinor(512000, 'CHF', 'EUR', 941200)).toBe(543986);
    expect(convertMinor(100000, 'EUR', 'CHF', 941200)).toBe(94120);
    expect(convertMinor(-93500, 'CHF', 'EUR', 941200)).toBe(-99341);
    expect(convertMinor(1234, 'EUR', 'EUR', 1)).toBe(1234);
  });
  it('saisie du taux', () => {
    expect(parseRate('0,9412')).toBe(941200);
    expect(parseRate('1.05')).toBe(1050000);
    expect(parseRate('abc')).toBeNull();
    expect(parseRate('0')).toBeNull();
  });
});
