import { describe, expect, it } from 'vitest';
import { buildCtx } from '../../src/engine/context';
import { forecast } from '../../src/engine/forecast';
import { checks } from '../../src/engine/checks';
import { checkFigureSums } from '../../src/engine/figure';
import * as eng from '../../src/services/engagements';
import * as mv from '../../src/services/movements';
import * as loans from '../../src/services/loans';
import * as funds from '../../src/services/funds';
import { foyer } from '../fixtures/foyer';

const TODAY = '2026-11-19';

describe('prévision de trésorerie', () => {
  it('soldes de fin de mois : solde constaté + réel + échéances + enveloppes de budget, une seule fois chacun', async () => {
    const f = await foyer();
    await eng.createRecurrence(f.driver, await f.snap(), { label: 'Salaire', nature: 'revenu_ordinaire', rubrique_id: f.rub.salaireA, amount_minor: 320_000, currency: 'EUR', frequency: 'mensuelle', day_of_month: 25, start_date: '2026-01-25', planned_account_id: f.acc.courant });
    await eng.createRecurrence(f.driver, await f.snap(), { label: 'Streaming', nature: 'depense', rubrique_id: f.rub.abonnements, amount_minor: -1_399, currency: 'EUR', frequency: 'mensuelle', day_of_month: 5, start_date: '2026-01-05', planned_account_id: f.acc.courant });
    await eng.setBudgetPlan(f.driver, await f.snap(), { rubrique_id: f.rub.courses, from_month: '2026-01', monthly_minor: 40_000 });
    await mv.createOperation(f.driver, await f.snap(), { account_id: f.acc.courant, op_date: '2026-11-08', amount_minor: -15_000, nature: 'depense', rubrique_id: f.rub.courses });
    const ctx = buildCtx(await f.snap(), TODAY);
    const fc = forecast(ctx, { horizon: 3 });
    const nov = fc.points[0]!;
    const courant = nov.liquidites.components.find((c) => c.label === 'Courant commun')!;
    // 3 000 − 150 (réel) − 13,99 (en retard, reporté) + 3 200 (salaire) − 250 (reste du budget courses)
    expect(courant.value).toBe(300_000 - 15_000 - 1_399 + 320_000 - 25_000);
    const dec = fc.points[1]!.liquidites.components.find((c) => c.label === 'Courant commun')!;
    expect(dec.value! - courant.value!).toBe(-1_399 + 320_000 - 40_000);
    for (const p of fc.points) expect(checkFigureSums(p.liquidites)).toEqual([]);
    expect(fc.flows.filter((x) => x.kind === 'retard').map((x) => x.label)).toEqual(['Streaming (en retard, reportée à aujourd’hui)']);
    // CHF converti au taux d'hypothèse, affiché
    expect(fc.hypothesisLabel).toMatch(/0,9412/);
    const chf = nov.liquidites.components.find((c) => c.label === 'Courant CHF')!;
    expect(chf.value).toBe(543_986);
    // compte synthétique : solde du 15/10 inchangé faute de flux
    expect(nov.liquidites.components.find((c) => c.label === 'Livret A')!.value).toBe(2_295_000);
    expect(fc.minimumMonth).toBe('2026-11');
    expect(fc.minimum.value).toBe(nov.liquidites.value);
  });

  it('crédit : l’échéance sort une fois de la trésorerie (capital + coûts), jamais aussi en budget', async () => {
    const f = await foyer();
    await loans.saveLoan(f.driver, await f.snap(), { label: 'Auto', currency: 'EUR', mode: 'theorique', frequency: 'mensuelle', first_due_date: '2026-12-10', principal_minor: 1_200_000, annual_rate_e6: 30_000, periods: 24, payment_account_id: f.acc.courant });
    const ctx = buildCtx(await f.snap(), TODAY);
    const fc = forecast(ctx, { horizon: 3 });
    const credit = fc.flows.filter((x) => x.kind === 'credit');
    expect(credit.map((x) => [x.date, x.amount_minor])).toEqual([['2026-12-10', -51_577], ['2027-01-10', -51_577]]);
    expect(fc.flows.filter((x) => x.kind === 'budget')).toHaveLength(0);
    const c = (k: number) => fc.points[k]!.liquidites.components.find((x) => x.label === 'Courant commun')!.value!;
    expect(c(1) - c(0)).toBe(-51_577);
  });

  it('projets : marge après réserve et fonds ; le paiement prévu consomme la réservation', async () => {
    const f = await foyer();
    const p = await funds.saveFund(f.driver, await f.snap(), { kind: 'projet', name: 'Véhicule', target_minor: 2_000_000 });
    await funds.allocate(f.driver, await f.snap(), { fund_id: p, date: '2026-11-01', amount_minor: 1_000_000 }, TODAY);
    await funds.setFundPlan(f.driver, await f.snap(), { fund_id: p, amount_minor: 50_000, frequency: 'mensuelle', start_date: '2026-12-01' });
    await eng.createScheduled(f.driver, await f.snap(), { label: 'Achat véhicule', due_date: '2027-01-15', amount_minor: -1_100_000, currency: 'EUR', nature: 'depense', rubrique_id: f.rub.courses, planned_account_id: f.acc.courant, fund_id: p });
    const ctx = buildCtx(await f.snap(), TODAY);
    const fc = forecast(ctx, { horizon: 3 });
    expect(fc.points.map((x) => x.reserve.value)).toEqual([1_000_000, 1_050_000, 0]);
    const liq = fc.points.map((x) => x.liquidites.value!);
    expect(liq[2]! - liq[1]!).toBe(-1_100_000);
    expect(fc.points.map((x) => x.marge.value)).toEqual([liq[0]! - 1_000_000, liq[1]! - 1_050_000, liq[2]!]);
    expect(fc.marge.value).toBe(Math.min(...fc.points.map((x) => x.marge.value!)));
    expect(fc.marge.label).toBe('Marge après réserve et fonds');
    expect(fc.minimum.label).toBe('Minimum des soldes prévus en fin de mois');
  });

  it('compte sans solde constaté : exclu, annoncé, jamais compté pour zéro', async () => {
    const f = await foyer();
    const { createAccount } = await import('../../src/services/referentials');
    await createAccount(f.driver, await f.snap(), { name: 'Nouveau livret', currency: 'EUR', owner: 'A', type: 'epargne' });
    const ctx = buildCtx(await f.snap(), TODAY);
    const fc = forecast(ctx, { horizon: 2 });
    expect(fc.excludedAccounts.map((a) => a.name)).toEqual(['Nouveau livret']);
    expect(fc.warnings[0]).toMatch(/Nouveau livret/);
    expect(fc.minimum.definition).toMatch(/hors Nouveau livret/);
    const items = checks(ctx);
    expect(items.some((i) => i.text.includes('« Nouveau livret » n’a aucun solde constaté'))).toBe(true);
  });
});
