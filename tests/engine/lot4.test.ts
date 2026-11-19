import { describe, expect, it } from 'vitest';
import { buildCtx } from '../../src/engine/context';
import { amortize, constantInstallment, crdAt, installmentsOf, simplifiedSchedule } from '../../src/engine/loans';
import { expectedBetween } from '../../src/engine/occurrences';
import { familyTree, flows, periodLines, expenseDonut } from '../../src/engine/analysis';
import { monthTracking, trackRubrique } from '../../src/engine/tracking';
import { checkFigureSums } from '../../src/engine/figure';
import { situation, fundState } from '../../src/engine/funds';
import * as loans from '../../src/services/loans';
import * as funds from '../../src/services/funds';
import * as eng from '../../src/services/engagements';
import * as mv from '../../src/services/movements';
import { foyer } from '../fixtures/foyer';
import type { Loan } from '../../src/domain/types';

const TODAY = '2026-11-19';

describe('cas 10 : amortissement théorique — référence indépendante', () => {
  // Valeurs de référence calculées séparément avec Python `decimal` (précision 50, arrondi
  // ROUND_HALF_UP au centime), formule de l'échéance constante M = P·i / (1 − (1+i)^−n),
  // i = taux annuel / nombre d'échéances par an ; intérêts = arrondi(CRD × i) ;
  // capital = M − intérêts ; dernière échéance : capital = CRD restant.
  it('A — 200 000 € à 1,85 %, 240 mensualités, assurance 0,30 % du capital initial', () => {
    const rows = amortize(1, { principal_minor: 20_000_000, annual_rate_e6: 18_500, periods: 240, frequency: 'mensuelle', first_due_date: '2026-01-05', insurance_mode: 'pct_capital_initial', insurance_value: 3_000 });
    expect(constantInstallment(20_000_000, 18_500, 240, 12)).toBe(99_762);
    expect(rows[0]).toMatchObject({ seq: 1, due_date: '2026-01-05', principal_minor: 68_929, interest_minor: 30_833, insurance_minor: 5_000, total_minor: 104_762, crd_after_minor: 19_931_071 });
    expect(rows[1]).toMatchObject({ principal_minor: 69_035, interest_minor: 30_727, crd_after_minor: 19_862_036 });
    expect(rows[239]).toMatchObject({ seq: 240, due_date: '2045-12-05', principal_minor: 99_609, interest_minor: 154, total_minor: 104_763, crd_after_minor: 0 });
    expect(rows.reduce((s, r) => s + r.interest_minor, 0)).toBe(3_942_881);
    expect(rows.reduce((s, r) => s + r.principal_minor, 0)).toBe(20_000_000);
    for (const r of rows) expect(r.total_minor).toBe(r.principal_minor + r.interest_minor + r.insurance_minor + r.fees_minor);
  });
  it('B — 100 000 CHF à 1,2 %, 40 trimestrialités', () => {
    const rows = amortize(1, { principal_minor: 10_000_000, annual_rate_e6: 12_000, periods: 40, frequency: 'trimestrielle', first_due_date: '2026-03-31' });
    expect(rows[0]).toMatchObject({ principal_minor: 235_674, interest_minor: 30_000, total_minor: 265_674, due_date: '2026-03-31' });
    expect(rows[1]).toMatchObject({ principal_minor: 236_381, interest_minor: 29_293, due_date: '2026-06-30', crd_after_minor: 9_527_945 });
    expect(rows[39]).toMatchObject({ principal_minor: 264_893, interest_minor: 795, total_minor: 265_688, crd_after_minor: 0 });
    expect(rows.reduce((s, r) => s + r.interest_minor, 0)).toBe(626_974);
  });
  it('C — 12 000 € à 4,9 %, 5 annuités', () => {
    const rows = amortize(1, { principal_minor: 1_200_000, annual_rate_e6: 49_000, periods: 5, frequency: 'annuelle', first_due_date: '2027-01-15' });
    expect(rows.map((r) => r.total_minor)).toEqual([276_404, 276_404, 276_404, 276_404, 276_403]);
    expect(rows[4]).toMatchObject({ principal_minor: 263_492, interest_minor: 12_911, crd_after_minor: 0 });
    expect(rows.reduce((s, r) => s + r.interest_minor, 0)).toBe(182_019);
  });
  it('taux nul et frais initiaux', () => {
    const rows = amortize(1, { principal_minor: 1_000_000, annual_rate_e6: 0, periods: 3, frequency: 'mensuelle', first_due_date: '2027-01-31', fees_initial_minor: 50_000 });
    expect(rows.map((r) => [r.seq, r.due_date, r.principal_minor, r.total_minor])).toEqual([[0, '2026-12-31', 0, 50_000], [1, '2027-01-31', 333_333, 333_333], [2, '2027-02-28', 333_333, 333_333], [3, '2027-03-31', 333_334, 333_334]]);
  });
});

async function creditSetup() {
  const f = await foyer();
  const rec = await eng.createRecurrence(f.driver, await f.snap(), { label: 'Prêt immo (ancienne saisie)', nature: 'cout_credit', rubrique_id: (await f.snap()).rubriques.find((r) => r.ref === 'SYS.CREDIT.NON_VENTILEE')!.id, amount_minor: -104_762, currency: 'EUR', frequency: 'mensuelle', day_of_month: 5, start_date: '2026-01-05' });
  const id = await loans.saveLoan(f.driver, await f.snap(), { label: 'Prêt immo', currency: 'EUR', mode: 'theorique', frequency: 'mensuelle', first_due_date: '2026-01-05', principal_minor: 20_000_000, annual_rate_e6: 18_500, periods: 240, insurance_mode: 'pct_capital_initial', insurance_value: 3_000, payment_account_id: f.acc.courant, recurrence_id: rec });
  return { f, id, rec };
}

describe('cas 4 : coûts du crédit, capital et prévisions', () => {
  it('la récurrence associée est remplacée par les échéances du crédit : jamais deux fois', async () => {
    const { f } = await creditSetup();
    const ctx = buildCtx(await f.snap(), TODAY);
    const dec = expectedBetween(ctx, '2026-12-01', '2026-12-31');
    expect(dec).toHaveLength(1);
    expect(dec[0]).toMatchObject({ kind: 'credit', amount_minor: -104_762, account_id: f.acc.courant });
  });

  it('paiement rapproché : ventilé capital / intérêts / assurance ; concordance suivi, familles, rubriques, anneau, flux', async () => {
    const { f, id } = await creditSetup();
    const nonVentilee = (await f.snap()).rubriques.find((r) => r.ref === 'SYS.CREDIT.NON_VENTILEE')!.id;
    const pay = await mv.createOperation(f.driver, await f.snap(), { account_id: f.acc.courant, op_date: '2026-11-05', amount_minor: -104_762, nature: 'cout_credit', rubrique_id: nonVentilee, label_original: 'ECHEANCE PRET' });
    const seq = installmentsOf(buildCtx(await f.snap(), TODAY), (await f.snap()).loans[0]!).find((i) => i.due_date === '2026-11-05')!.seq;
    await eng.reconcile(f.driver, await f.snap(), { movement_id: pay, target_key: `cr:${id}:${seq}` }, TODAY);
    const ctx = buildCtx(await f.snap(), TODAY);
    const inst = installmentsOf(ctx, ctx.snap.loans[0]!).find((i) => i.seq === seq)!;
    const lines = periodLines(ctx, { from: '2026-11', to: '2026-11' }, { kind: 'foyer' });
    const fl = flows(ctx, lines);
    const cost = inst.interest_minor + inst.insurance_minor;
    expect(fl.byCategory.capital!.value).toBe(-inst.principal_minor);
    expect(fl.byCategory.consommation!.value).toBe(-cost);
    expect(fl.figure.value).toBe(-104_762); // le paiement compte une seule fois en trésorerie
    const credits = familyTree(ctx, lines).find((n) => n.name === 'Crédits')!;
    expect(credits.figure.value).toBe(-cost);
    expect(credits.rubriques.map((r) => r.name).sort()).toEqual(['Assurance emprunteur', 'Intérêts']);
    const mt = monthTracking(ctx, '2026-11');
    const fam = mt.families.find((x) => x.name === 'Crédits')!;
    expect(fam.reel.value).toBe(cost);
    expect(fam.prevu.value).toBe(cost);
    expect(fam.reste.value).toBe(0);
    expect(expenseDonut(ctx, lines).slices.find((s) => s.name === 'Crédits')!.value).toBe(cost);
    for (const k of ['prevu', 'reel', 'reste'] as const) expect(checkFigureSums(fam[k])).toEqual([]);
    // le capital n'est pas une consommation : absent du suivi des dépenses
    expect(mt.families.some((x) => x.rubriques.some((r) => ctx.rubrique.get(r.rubrique_id)!.ref === 'SYS.TECH.CAPITAL'))).toBe(false);
    // le mois suivant : prévu = intérêts + assurance de l'échéance suivante
    const next = installmentsOf(ctx, ctx.snap.loans[0]!).find((i) => i.seq === seq + 1)!;
    expect(trackRubrique(ctx, ctx.rubriqueByRef.get('SYS.CREDIT.INTERETS')!.id, '2026-12').prevu.value).toBe(next.interest_minor);
  });

  it('capital restant dû', async () => {
    const { f } = await creditSetup();
    const ctx = buildCtx(await f.snap(), TODAY);
    const loan = ctx.snap.loans[0]!;
    expect(crdAt(ctx, loan, '2025-12-31').minor).toBe(20_000_000);
    expect(crdAt(ctx, loan, '2026-01-05').minor).toBe(19_931_071);
    expect(crdAt(ctx, loan, '2045-12-31').minor).toBe(0);
  });
});

describe('cas 3 et 9 : associations à l’enregistrement, archivage et réactivation', () => {
  it('une fiche non enregistrée n’écrit aucune association ; une fiche invalide non plus', async () => {
    const f = await foyer();
    const rec = await eng.createRecurrence(f.driver, await f.snap(), { label: 'Mensualité', nature: 'cout_credit', rubrique_id: (await f.snap()).rubriques.find((r) => r.ref === 'SYS.CREDIT.NON_VENTILEE')!.id, amount_minor: -50_000, currency: 'EUR', frequency: 'mensuelle', day_of_month: 5, start_date: '2026-01-05' });
    await expect(loans.saveLoan(f.driver, await f.snap(), { label: 'Auto', currency: 'EUR', mode: 'theorique', frequency: 'mensuelle', first_due_date: '2026-01-05', principal_minor: 0, annual_rate_e6: 30_000, periods: 48, recurrence_id: rec, payment_account_id: f.acc.courant })).rejects.toThrow(/Capital/);
    const s = await f.snap();
    expect(s.loans).toHaveLength(0);
    expect(s.installments).toHaveLength(0);
    expect(expectedBetween(buildCtx(s, TODAY), '2026-12-01', '2026-12-31')).toHaveLength(1);
  });

  it('réactiver un crédit archivé ne duplique aucune opération ni rapprochement', async () => {
    const { f, id } = await creditSetup();
    const nonVentilee = (await f.snap()).rubriques.find((r) => r.ref === 'SYS.CREDIT.NON_VENTILEE')!.id;
    const pay = await mv.createOperation(f.driver, await f.snap(), { account_id: f.acc.courant, op_date: '2026-11-05', amount_minor: -104_762, nature: 'cout_credit', rubrique_id: nonVentilee });
    await eng.reconcile(f.driver, await f.snap(), { movement_id: pay, target_key: `cr:${id}:11` }, TODAY);
    const before = await f.snap();
    await loans.archiveLoan(f.driver, before, id);
    let ctx = buildCtx(await f.snap(), TODAY);
    expect(expectedBetween(ctx, '2026-12-01', '2026-12-31').filter((e) => e.kind === 'credit')).toHaveLength(0);
    await loans.reactivateLoan(f.driver, await f.snap(), id);
    const after = await f.snap();
    expect(after.movements).toHaveLength(before.movements.length);
    expect(after.reconciliations).toHaveLength(before.reconciliations.length);
    expect(after.installments).toHaveLength(before.installments.length);
    ctx = buildCtx(after, TODAY);
    expect(expectedBetween(ctx, '2026-11-01', '2026-11-30').find((e) => e.kind === 'credit')!.status).toBe('soldee');
  });

  it('une échéance déjà rapprochée ne peut pas changer de montant par une nouvelle fiche', async () => {
    const { f, id } = await creditSetup();
    const nv = (await f.snap()).rubriques.find((r) => r.ref === 'SYS.CREDIT.NON_VENTILEE')!.id;
    const pay = await mv.createOperation(f.driver, await f.snap(), { account_id: f.acc.courant, op_date: '2026-11-05', amount_minor: -104_762, nature: 'cout_credit', rubrique_id: nv });
    await eng.reconcile(f.driver, await f.snap(), { movement_id: pay, target_key: `cr:${id}:11` }, TODAY);
    await expect(loans.saveLoan(f.driver, await f.snap(), { label: 'Prêt immo', currency: 'EUR', mode: 'theorique', frequency: 'mensuelle', first_due_date: '2026-01-05', principal_minor: 20_000_000, annual_rate_e6: 19_000, periods: 240, payment_account_id: f.acc.courant }, id)).rejects.toThrow(/déjà un paiement rapproché/);
  });
});

describe('modes bancaire et simplifié', () => {
  it('échéancier bancaire collé : valeurs conservées telles quelles', async () => {
    const f = await foyer();
    const parsed = loans.parseBankSchedule('date;capital;intérêts;assurance;frais;crd\n05/12/2026;612,40;101,02;12,00;;49 387,60\n05/01/2027;613,11;100,31;12,00;0;48 774,49\n');
    expect(parsed.errors).toEqual([]);
    const id = await loans.saveLoan(f.driver, await f.snap(), { label: 'Prêt CHF', currency: 'EUR', mode: 'bancaire', frequency: 'mensuelle', first_due_date: '2026-12-05', bankSchedule: parsed.rows });
    const s = await f.snap();
    expect(s.installments.filter((i) => i.loan_id === id).map((i) => [i.principal_minor, i.interest_minor, i.insurance_minor, i.total_minor, i.crd_after_minor, i.origin])).toEqual([
      [61_240, 10_102, 1_200, 72_542, 4_938_760, 'banque'],
      [61_311, 10_031, 1_200, 72_542, 4_877_449, 'banque'],
    ]);
    const bad = loans.parseBankSchedule('05/12/2026;612.40;1,234;0;0;100\n');
    expect(bad.errors[0]).toMatch(/Ligne 1, colonne intérêts/);
  });

  it('simplifié : avec taux, ventilation estimée ; sans taux, non ventilée et CRD fixe', () => {
    const base = { id: 1, label: 'x', lender: '', currency: 'EUR', mode: 'simplifie', principal_minor: null, periods: null, frequency: 'mensuelle', first_due_date: '2020-01-10', insurance_mode: 'aucune', insurance_value: null, fees_per_installment_minor: 0, fees_initial_minor: 0, simple_installment_minor: 50_000, simple_crd_minor: 1_000_000, simple_crd_date: '2026-11-01', payment_account_id: null, recurrence_id: null, status: 'actif', archived_at: null, created_at: '', deleted_at: null } as unknown as Loan;
    const withRate = simplifiedSchedule({ ...base, annual_rate_e6: 24_000 });
    expect(withRate[0]).toMatchObject({ due_date: '2026-11-10', interest_minor: 2_000, principal_minor: 48_000, crd_after_minor: 952_000, origin: 'estime' });
    expect(withRate[withRate.length - 1]!.crd_after_minor).toBe(0);
    const noRate = simplifiedSchedule({ ...base, annual_rate_e6: null });
    expect(noRate).toHaveLength(20);
    expect(noRate[0]).toMatchObject({ unventilated: 50_000, principal_minor: 0, crd_after_minor: 1_000_000 });
  });
});

describe('réserve, fonds et projets', () => {
  it('liquidités, réservé, non affecté ; un paiement de projet consomme la réservation sans double compte', async () => {
    const f = await foyer();
    const reserve = await funds.saveFund(f.driver, await f.snap(), { kind: 'reserve', name: 'Réserve de sécurité', target_minor: 1_800_000 });
    const auto = await funds.saveFund(f.driver, await f.snap(), { kind: 'projet', name: 'Véhicule', target_minor: 2_200_000, target_date: '2027-05-31' });
    await funds.allocate(f.driver, await f.snap(), { fund_id: reserve, date: '2026-11-01', amount_minor: 1_500_000 }, TODAY);
    await funds.allocate(f.driver, await f.snap(), { fund_id: auto, date: '2026-11-01', amount_minor: 900_000 }, TODAY);
    let ctx = buildCtx(await f.snap(), TODAY);
    let s = situation(ctx);
    const liq = s.liquidites.value!;
    expect(s.reserve.value).toBe(2_400_000);
    expect(s.nonAffecte.value).toBe(liq - 2_400_000);
    expect(checkFigureSums(s.nonAffecte)).toEqual([]);
    expect(s.reserveFund).toMatchObject({ reserved: 1_500_000, progress_e4: 8333 });
    // paiement d'acompte du véhicule : 3 000 €
    const pay = await mv.createOperation(f.driver, await f.snap(), { account_id: f.acc.courant, op_date: '2026-11-10', amount_minor: -300_000, nature: 'depense', rubrique_id: f.rub.courses });
    await funds.consume(f.driver, await f.snap(), { fund_id: auto, movement_id: pay }, TODAY);
    ctx = buildCtx(await f.snap(), TODAY);
    s = situation(ctx);
    expect(s.liquidites.value).toBe(liq - 300_000);
    expect(s.reserve.value).toBe(2_100_000);
    expect(s.nonAffecte.value).toBe(liq - 2_400_000);
    expect(fundState(ctx, ctx.snap.funds.find((x) => x.id === auto)!).consumed).toBe(300_000);
    // impossible de consommer plus que réservé, ou deux fois
    await expect(funds.consume(f.driver, await f.snap(), { fund_id: auto, movement_id: pay }, TODAY)).rejects.toThrow(/déjà rattachée/);
    await expect(funds.allocate(f.driver, await f.snap(), { fund_id: auto, date: '2026-11-20', amount_minor: -700_000 }, TODAY)).rejects.toThrow(/libérer plus/);
    await expect(funds.saveFund(f.driver, await f.snap(), { kind: 'reserve', name: 'Deuxième' })).rejects.toThrow(/existe déjà/);
  });
});
