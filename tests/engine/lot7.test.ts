import { describe, expect, it } from 'vitest';
import { buildCtx } from '../../src/engine/context';
import { checkFigureSums } from '../../src/engine/figure';
import { netWorth, project, projectionInputs, projections, type ProjectionInputs } from '../../src/engine/wealth';
import * as ref from '../../src/services/referentials';
import * as wealth from '../../src/services/wealth';
import * as loans from '../../src/services/loans';
import * as eng from '../../src/services/engagements';
import { foyer } from '../fixtures/foyer';

const TODAY = '2026-11-19';

describe('patrimoine net', () => {
  it('liquidités + investissements + biens (quote-part) − capital restant dû, chaque composant daté', async () => {
    const f = await foyer();
    await ref.createAccount(f.driver, await f.snap(), { name: 'PEA', currency: 'EUR', owner: 'A', type: 'investissement', initialBalance: { ref_date: '2026-09-30', amount_minor: 4_000_000 } });
    const home = await wealth.saveAsset(f.driver, await f.snap(), { kind: 'immobilier', name: 'Résidence principale', currency: 'EUR' });
    const flat = await wealth.saveAsset(f.driver, await f.snap(), { kind: 'immobilier', name: 'Appartement CH', currency: 'CHF', ownership_pct_e2: 5000 });
    await wealth.setAssetValue(f.driver, await f.snap(), { asset_id: home, date: '2026-06-30', value_minor: 42_000_000 });
    await wealth.setAssetValue(f.driver, await f.snap(), { asset_id: flat, date: '2026-10-31', value_minor: 50_000_000 });
    await loans.saveLoan(f.driver, await f.snap(), { label: 'Prêt', currency: 'EUR', mode: 'theorique', frequency: 'mensuelle', first_due_date: '2026-01-05', principal_minor: 20_000_000, annual_rate_e6: 18_500, periods: 240 });
    const ctx = buildCtx(await f.snap(), TODAY);
    const nw = netWorth(ctx);
    expect(checkFigureSums(nw)).toEqual([]);
    const [liq, inv, biens, dettes] = nw.components;
    expect(liq!.value).toBe(300_000 + 543_986 + 2_295_000);
    expect(inv!.value).toBe(4_000_000);
    // 50 % de 500 000 CHF au taux du 31/10 (0,9412) = 265 618,36 €
    expect(biens!.components.map((c) => c.value)).toEqual([42_000_000, 26_561_836]);
    expect(biens!.components[1]!.notes).toContain('quote-part 50 %');
    expect(dettes!.value).toBeLessThan(0);
    expect(nw.value).toBe(liq!.value! + 4_000_000 + 42_000_000 + 26_561_836 + dettes!.value!);
  });
});

describe('projection long terme', () => {
  const base: ProjectionInputs = {
    startYear: 2026, endYear: 2028,
    liquid: { EUR: 1_000_000, CHF: 0 }, invest: { EUR: 10_000_000, CHF: 0 }, realEstate: { EUR: 0, CHF: 10_000_000 },
    income: { EUR: 6_000_000, CHF: 0 }, expenses: { EUR: 5_000_000, CHF: 0 },
    capitalByYear: new Map([[2026, { EUR: 100_000, CHF: 0 }], [2027, { EUR: 200_000, CHF: 0 }]]),
    crdByYear: new Map([[2026, { EUR: 1_000_000, CHF: 0 }], [2027, { EUR: 800_000, CHF: 0 }], [2028, { EUR: 600_000, CHF: 0 }]]),
    missing: [],
  };
  it('calcul année par année (valeurs vérifiées à la main)', () => {
    const y = project(base, { inflation: 0.02, return_default: 0.05, real_estate: 0.01, eur_chf: 1, income_growth: 0.01 });
    // 2026 : 10 000 + 100 000 + 100 000 CHF (= 100 000 €) − 10 000 = 200 000 €
    expect(y[0]).toEqual({ year: 2026, nominal: 20_000_000, real: 20_000_000 });
    // 2027 : liquidités 10 000 + (60 000 − 50 000) − 1 000 = 19 000 ; placements 105 000 ; biens 101 000 ; dette 8 000
    expect(y[1]!.nominal).toBe(1_900_000 + 10_500_000 + 10_100_000 - 800_000);
    expect(y[1]!.real).toBe(Math.round(21_700_000 / 1.02));
    // 2028 : liquidités 19 000 + (60 600 − 51 000) − 2 000 = 26 600 ; placements 110 250 ; biens 102 010 ; dette 6 000
    expect(y[2]!.nominal).toBe(2_660_000 + 11_025_000 + 10_201_000 - 600_000);
  });
  it('le taux EUR/CHF du scénario s’applique aux montants en CHF', () => {
    const a = project(base, { inflation: 0, return_default: 0, real_estate: 0, eur_chf: 1, income_growth: 0 });
    const b = project(base, { inflation: 0, return_default: 0, real_estate: 0, eur_chf: 0.8, income_growth: 0 });
    expect(b[0]!.nominal - a[0]!.nominal).toBe(12_500_000 - 10_000_000);
  });
  it('trois scénarios jusqu’à la retraite, fourchette ordonnée', async () => {
    const f = await foyer();
    const s = await f.snap();
    await ref.updatePerson(f.driver, s, s.persons[0]!.id, { retirement_date: '2050-06-30' });
    await eng.createRecurrence(f.driver, await f.snap(), { label: 'Salaire', nature: 'revenu_ordinaire', rubrique_id: f.rub.salaireA, amount_minor: 400_000, currency: 'EUR', frequency: 'mensuelle', day_of_month: 25, start_date: '2026-01-25' });
    await eng.createRecurrence(f.driver, await f.snap(), { label: 'Salaire CH', nature: 'revenu_ordinaire', rubrique_id: f.rub.salaireB, amount_minor: 500_000, currency: 'CHF', frequency: 'mensuelle', day_of_month: 25, start_date: '2026-01-25' });
    await eng.setBudgetPlan(f.driver, await f.snap(), { rubrique_id: f.rub.courses, from_month: '2026-01', monthly_minor: 150_000 });
    const ctx = buildCtx(await f.snap(), TODAY);
    const inp = projectionInputs(ctx);
    expect(inp.endYear).toBe(2050);
    expect(inp.income).toEqual({ EUR: 4_800_000, CHF: 6_000_000 });
    expect(inp.expenses.EUR).toBe(1_800_000);
    const { scenarios } = projections(ctx);
    expect(scenarios.map((x) => x.kind)).toEqual(['prudent', 'central', 'favorable']);
    const last = scenarios.map((x) => x.years[x.years.length - 1]!.nominal);
    expect(last[0]!).toBeLessThan(last[1]!);
    expect(last[1]!).toBeLessThan(last[2]!);
  });
  it('paramètres de scénario contrôlés', async () => {
    const f = await foyer();
    await expect(wealth.setScenario(f.driver, await f.snap(), 'central', { inflation: 0.5, return_default: 0.03, real_estate: 0.01, eur_chf: 0.94, income_growth: 0.01 })).rejects.toThrow(/Inflation/);
  });
});
