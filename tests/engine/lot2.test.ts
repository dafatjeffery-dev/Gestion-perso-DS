// Moteur de calcul : tests indépendants de l'interface, sur données fictives.
import { describe, expect, it } from 'vitest';
import { buildCtx } from '../../src/engine/context';
import { accountBalance, liquidities } from '../../src/engine/balances';
import { realLines } from '../../src/engine/lines';
import { familyTree, flows, periodLines, expenseDonut, scopeInfo } from '../../src/engine/analysis';
import { annualView, expectedBetween, occurrenceKey } from '../../src/engine/occurrences';
import { monthTracking, trackRubrique } from '../../src/engine/tracking';
import { checkFigureSums } from '../../src/engine/figure';
import * as mv from '../../src/services/movements';
import * as eng from '../../src/services/engagements';
import * as ref from '../../src/services/referentials';
import { createTransfer } from '../../src/services/transfers';
import { foyer } from '../fixtures/foyer';

const TODAY = '2026-11-19';

describe('soldes', () => {
  it('solde de référence + opérations postérieures ; celles du jour de référence sont déjà incluses', async () => {
    const f = await foyer();
    const op = (d: string, a: number) => mv.createOperation(f.driver, f.snap as never, { account_id: f.acc.courant, op_date: d, amount_minor: a, nature: 'depense', rubrique_id: f.rub.courses });
    for (const [d, a] of [['2026-10-31', -1000], ['2026-11-02', -2500], ['2026-11-25', -700]] as const) await mv.createOperation(f.driver, await f.snap(), { account_id: f.acc.courant, op_date: d, amount_minor: a, nature: 'depense', rubrique_id: f.rub.courses });
    void op;
    const ctx = buildCtx(await f.snap(), TODAY);
    const b = accountBalance(ctx, f.acc.courant);
    expect(b.minor).toBe(300000 - 2500);
    expect(b.operationsSinceRef).toBe(1);
    expect(accountBalance(ctx, f.acc.courant, '2026-12-01').minor).toBe(300000 - 2500 - 700);
    const none = accountBalance(ctx, f.acc.courant, '2026-10-01');
    expect(none.minor).toBeNull();
    expect(none.missingReason).toMatch(/aucun solde de référence/);
  });

  it('liquidités : CHF converti au taux de la date du solde ; archiver ne change rien', async () => {
    const f = await foyer();
    let ctx = buildCtx(await f.snap(), TODAY);
    const l1 = liquidities(ctx);
    // 3 000 € + 5 120 CHF / 0,9412 (= 5 439,86 €) + 22 950 €
    expect(l1.value).toBe(300000 + 543986 + 2295000);
    expect(checkFigureSums(l1)).toEqual([]);
    await ref.archiveAccount(f.driver, await f.snap(), f.acc.livret);
    ctx = buildCtx(await f.snap(), TODAY);
    expect(liquidities(ctx).value).toBe(l1.value);
  });

  it('l’absence de donnée reste une absence, jamais un zéro', async () => {
    const f = await foyer();
    await ref.createAccount(f.driver, await f.snap(), { name: 'Sans solde', currency: 'EUR', owner: 'A', type: 'epargne' });
    const l = liquidities(buildCtx(await f.snap(), TODAY));
    expect(l.value).toBeNull();
    expect(l.missingReason).toMatch(/Sans solde/);
  });
});

describe('cas 2 et couverture synthétique / détaillé', () => {
  it('jamais d’addition silencieuse : une décision explicite est exigée', async () => {
    const f = await foyer();
    await mv.createOperation(f.driver, await f.snap(), { account_id: f.acc.courant, op_date: '2026-11-03', amount_minor: -4000, nature: 'depense', rubrique_id: f.rub.courses });
    const t = { rubrique_id: f.rub.courses, period_month: '2026-11', amount_minor: -30000, currency: 'EUR' as const, nature: 'depense' as const };
    await expect(mv.createTotal(f.driver, await f.snap(), t)).rejects.toBeInstanceOf(mv.CoverageRequired);
    expect((await f.snap()).movements.filter((m) => m.granularity === 'total')).toHaveLength(0);
    const real = (mode: 'total_remplace' | 'detail_remplace' | 'complement') => async () => {
      const s = await f.snap();
      const d = s.coverage[0];
      if (d) await f.driver.apply([{ sql: 'UPDATE coverage_decision SET mode = ? WHERE id = ?', params: [mode, d.id] }]);
      const ctx = buildCtx(await f.snap(), TODAY);
      return trackRubrique(ctx, f.rub.courses, '2026-11').reel.value;
    };
    await mv.createTotal(f.driver, await f.snap(), t, { coverage: 'total_remplace' });
    expect(await real('total_remplace')()).toBe(30000);
    expect(await real('detail_remplace')()).toBe(4000);
    expect(await real('complement')()).toBe(34000);
    // le total ne touche jamais le solde du compte
    expect(accountBalance(buildCtx(await f.snap(), TODAY), f.acc.courant).minor).toBe(300000 - 4000);
  });

  it('conflit sans décision (base modifiée à l’extérieur) : aucun montant, conflit signalé', async () => {
    const f = await foyer();
    await mv.createOperation(f.driver, await f.snap(), { account_id: f.acc.courant, op_date: '2026-11-03', amount_minor: -4000, nature: 'depense', rubrique_id: f.rub.courses });
    await mv.createTotal(f.driver, await f.snap(), { rubrique_id: f.rub.courses, period_month: '2026-11', amount_minor: -30000, currency: 'EUR', nature: 'depense' }, { coverage: 'complement' });
    await f.driver.apply([{ sql: 'DELETE FROM coverage_decision', params: [] }]);
    const ctx = buildCtx(await f.snap(), TODAY);
    const r = trackRubrique(ctx, f.rub.courses, '2026-11');
    expect(r.reel.value).toBeNull();
    expect(r.reel.missingReason).toMatch(/conflit/);
    expect(realLines(ctx).conflicts).toHaveLength(1);
  });

  it('déplacer un total ne le duplique pas ; conflit de destination expliqué, résolu et réversible', async () => {
    const f = await foyer();
    const t = (m: string, a: number) => mv.createTotal(f.driver, null as never, { rubrique_id: f.rub.restaurants, period_month: m, amount_minor: a, currency: 'EUR', nature: 'depense' });
    void t;
    const oct = await mv.createTotal(f.driver, await f.snap(), { rubrique_id: f.rub.restaurants, period_month: '2026-10', amount_minor: -12000, currency: 'EUR', nature: 'depense' });
    let out = await mv.moveOrDuplicateTotal(f.driver, await f.snap(), oct, '2026-09', 'deplacer');
    expect(out.kind).toBe('fait');
    let s = await f.snap();
    expect(s.movements.filter((m) => m.granularity === 'total').map((m) => [m.period_month, m.amount_minor])).toEqual([['2026-09', -12000]]);
    // destination occupée
    await mv.createTotal(f.driver, await f.snap(), { rubrique_id: f.rub.restaurants, period_month: '2026-08', amount_minor: -5000, currency: 'EUR', nature: 'depense' });
    out = await mv.moveOrDuplicateTotal(f.driver, await f.snap(), oct, '2026-08', 'deplacer');
    expect(out.kind).toBe('conflit');
    if (out.kind === 'conflit') expect(out.message).toMatch(/contient déjà un total « Restaurants »/);
    s = await f.snap();
    expect(s.movements.filter((m) => m.granularity === 'total')).toHaveLength(2);
    out = await mv.moveOrDuplicateTotal(f.driver, await f.snap(), oct, '2026-08', 'deplacer', { resolution: 'fusionner' });
    expect(out.kind).toBe('fait');
    s = await f.snap();
    expect(s.movements.filter((m) => m.granularity === 'total').map((m) => [m.period_month, m.amount_minor])).toEqual([['2026-08', -17000]]);
    // réversible
    await mv.undoGroup(f.driver, (out as { group: string }).group);
    s = await f.snap();
    expect(s.movements.filter((m) => m.granularity === 'total').map((m) => [m.period_month, m.amount_minor]).sort()).toEqual([['2026-08', -5000], ['2026-09', -12000]]);
  });

  it('dupliquer uniquement sur demande, remplacer met l’ancien total à la corbeille', async () => {
    const f = await foyer();
    const a = await mv.createTotal(f.driver, await f.snap(), { rubrique_id: f.rub.restaurants, period_month: '2026-10', amount_minor: -12000, currency: 'EUR', nature: 'depense' });
    await mv.createTotal(f.driver, await f.snap(), { rubrique_id: f.rub.restaurants, period_month: '2026-11', amount_minor: -1000, currency: 'EUR', nature: 'depense' });
    await mv.moveOrDuplicateTotal(f.driver, await f.snap(), a, '2026-11', 'dupliquer', { resolution: 'remplacer' });
    const s = await f.snap();
    expect(s.movements.filter((m) => m.granularity === 'total').map((m) => [m.period_month, m.amount_minor]).sort()).toEqual([['2026-10', -12000], ['2026-11', -12000]]);
    expect(await f.driver.query('SELECT COUNT(*) AS n FROM movement WHERE deleted_at IS NOT NULL')).toEqual([{ n: 1 }]);
  });

  it('modifier corrige le même enregistrement', async () => {
    const f = await foyer();
    const a = await mv.createTotal(f.driver, await f.snap(), { rubrique_id: f.rub.restaurants, period_month: '2026-10', amount_minor: -12000, currency: 'EUR', nature: 'depense' });
    await mv.updateTotal(f.driver, await f.snap(), a, { amount_minor: -13000 });
    const s = await f.snap();
    expect(s.movements.map((m) => [m.id, m.amount_minor])).toEqual([[a, -13000]]);
  });
});

describe('cas 1 : récurrences et rubriques masquées', () => {
  it('désactiver ou masquer une rubrique ne retire ni l’engagement ni ses montants', async () => {
    const f = await foyer();
    await eng.createRecurrence(f.driver, await f.snap(), { label: 'Streaming', nature: 'depense', rubrique_id: f.rub.abonnements, amount_minor: -1399, currency: 'EUR', frequency: 'mensuelle', day_of_month: 5, start_date: '2026-01-05' });
    await mv.createOperation(f.driver, await f.snap(), { account_id: f.acc.courant, op_date: '2026-11-05', amount_minor: -1399, nature: 'depense', rubrique_id: f.rub.abonnements });
    const before = buildCtx(await f.snap(), TODAY);
    const t1 = trackRubrique(before, f.rub.abonnements, '2026-12');
    await ref.updateRubrique(f.driver, await f.snap(), f.rub.abonnements, { available_for_entry: false, visible: false });
    const after = buildCtx(await f.snap(), TODAY);
    const t2 = trackRubrique(after, f.rub.abonnements, '2026-12');
    expect(t2.prevu.value).toBe(1399);
    expect(t2.prevu.value).toBe(t1.prevu.value);
    expect(trackRubrique(after, f.rub.abonnements, '2026-11').reel.value).toBe(1399);
    expect(expectedBetween(after, '2026-12-01', '2027-02-28')).toHaveLength(3);
    // mais une nouvelle saisie dans la rubrique est refusée avec une explication
    await expect(mv.createOperation(f.driver, await f.snap(), { account_id: f.acc.courant, op_date: '2026-11-06', amount_minor: -100, nature: 'depense', rubrique_id: f.rub.abonnements })).rejects.toThrow(/n’est plus proposée/);
  });

  it('fréquences, jour 31, versions : corriger, faire évoluer, arrêter', async () => {
    const f = await foyer();
    const s0 = await f.snap();
    const id = await eng.createRecurrence(f.driver, s0, { label: 'Loyer', nature: 'depense', rubrique_id: f.rub.energie, amount_minor: -10000, currency: 'EUR', frequency: 'mensuelle', day_of_month: 31, start_date: '2026-01-31' });
    let ctx = buildCtx(await f.snap(), TODAY);
    expect(expectedBetween(ctx, '2026-02-01', '2026-04-30').map((e) => e.due_date)).toEqual(['2026-02-28', '2026-03-31', '2026-04-30']);
    await eng.evolveRecurrence(f.driver, await f.snap(), id, '2026-07-01', { amount_minor: -11000 });
    ctx = buildCtx(await f.snap(), TODAY);
    const amounts = expectedBetween(ctx, '2026-05-01', '2026-08-31').map((e) => e.amount_minor);
    expect(amounts).toEqual([-10000, -10000, -11000, -11000]);
    await expect(eng.evolveRecurrence(f.driver, await f.snap(), id, '2026-07-01', { amount_minor: -1 })).rejects.toThrow(/Corriger/);
    const v1 = (await f.snap()).recurrenceVersions.find((v) => v.recurrence_id === id && v.change_kind === 'creation')!;
    await eng.correctVersion(f.driver, await f.snap(), v1.id, { amount_minor: -9500 });
    ctx = buildCtx(await f.snap(), TODAY);
    expect(expectedBetween(ctx, '2026-05-01', '2026-08-31').map((e) => e.amount_minor)).toEqual([-9500, -9500, -11000, -11000]);
    expect((await f.snap()).recurrenceVersions.filter((v) => v.recurrence_id === id)).toHaveLength(2);
    await eng.stopRecurrence(f.driver, await f.snap(), id, '2026-12-31');
    ctx = buildCtx(await f.snap(), TODAY);
    expect(expectedBetween(ctx, '2026-11-01', '2027-03-31').map((e) => e.due_date)).toEqual(['2026-11-30', '2026-12-31']);
  });

  it('trimestrielle, annuelle, personnalisée, ajustements ponctuels', async () => {
    const f = await foyer();
    const q = await eng.createRecurrence(f.driver, await f.snap(), { label: 'Eau', nature: 'depense', rubrique_id: f.rub.energie, amount_minor: -9000, currency: 'EUR', frequency: 'trimestrielle', day_of_month: 15, start_date: '2026-02-15' });
    await eng.createRecurrence(f.driver, await f.snap(), { label: 'Taxe', nature: 'depense', rubrique_id: f.rub.taxes, amount_minor: -120000, currency: 'EUR', frequency: 'annuelle', day_of_month: 15, start_date: '2025-10-15' });
    await eng.createRecurrence(f.driver, await f.snap(), { label: 'Cantine', nature: 'depense', rubrique_id: f.rub.courses, amount_minor: -5000, currency: 'EUR', frequency: 'personnalisee', months_mask: 0b111100011111 /* sauf juin, juillet, août */, day_of_month: 1, start_date: '2026-01-01' });
    await eng.overrideOccurrence(f.driver, await f.snap(), q, '2026-05-15', { action: 'date', new_date: '2026-06-02' });
    await eng.overrideOccurrence(f.driver, await f.snap(), q, '2026-08-15', { action: 'montant', amount_minor: -9900 });
    const ctx = buildCtx(await f.snap(), TODAY);
    const all = expectedBetween(ctx, '2026-01-01', '2026-12-31');
    expect(all.filter((e) => e.label === 'Eau').map((e) => [e.due_date, e.amount_minor])).toEqual([['2026-02-15', -9000], ['2026-06-02', -9000], ['2026-08-15', -9900], ['2026-11-15', -9000]]);
    expect(all.filter((e) => e.label === 'Taxe').map((e) => e.due_date)).toEqual(['2026-10-15']);
    expect(all.filter((e) => e.label === 'Cantine').map((e) => e.due_date.slice(5, 7))).toEqual(['01', '02', '03', '04', '05', '09', '10', '11', '12']);
  });
});

describe('cas 7 : annuel, lissage, calendrier sans double compte', () => {
  it('la taxe annuelle : 1 200 € en octobre, repère lissé 100 €, jamais additionnés', async () => {
    const f = await foyer();
    const id = await eng.createRecurrence(f.driver, await f.snap(), { label: 'Taxe foncière', nature: 'depense', rubrique_id: f.rub.taxes, amount_minor: -120000, currency: 'EUR', frequency: 'annuelle', day_of_month: 15, start_date: '2026-10-15' });
    await eng.setBudgetPlan(f.driver, await f.snap(), { rubrique_id: f.rub.taxes, from_month: '2027-01', monthly_minor: 0 });
    const ctx = buildCtx(await f.snap(), TODAY);
    const a = annualView(ctx, id, '2027-01');
    expect(a.annual_minor).toBe(-120000);
    expect(a.smoothed_minor).toBe(-10000);
    expect(a.calendar).toEqual([{ month: '2027-10', amount_minor: -120000, date: '2027-10-15' }]);
    const prevus = ['2027-01', '2027-02', '2027-09', '2027-10', '2027-11'].map((m) => trackRubrique(ctx, f.rub.taxes, m).prevu.value);
    expect(prevus).toEqual([0, 0, 0, 120000, 0]);
  });
});

describe('cas 6 : budgets, échéances et rapprochement individuel', () => {
  async function scenario() {
    const f = await foyer();
    await eng.setBudgetPlan(f.driver, await f.snap(), { rubrique_id: f.rub.assurance, from_month: '2026-01', monthly_minor: 50000 });
    const ech = await eng.createScheduled(f.driver, await f.snap(), { label: 'Assurance habitation', due_date: '2026-11-25', amount_minor: -20000, currency: 'EUR', nature: 'depense', rubrique_id: f.rub.assurance, planned_account_id: f.acc.courant });
    return { f, ech };
  }

  it('exemple documenté : B = 500, une échéance de 200', async () => {
    const { f } = await scenario();
    let t = trackRubrique(buildCtx(await f.snap(), TODAY), f.rub.assurance, '2026-11');
    expect([t.prevu.value, t.reel.value, t.reste.value, t.ecart.value]).toEqual([50000, 0, 50000, 0]);
    expect(checkFigureSums(t.prevu)).toEqual([]);
    expect(checkFigureSums(t.reste)).toEqual([]);
    // un autre paiement de la même rubrique ne solde PAS l'échéance
    await mv.createOperation(f.driver, await f.snap(), { account_id: f.acc.courant, op_date: '2026-11-10', amount_minor: -20000, nature: 'depense', rubrique_id: f.rub.assurance, label_original: 'AUTRE FACTURE' });
    t = trackRubrique(buildCtx(await f.snap(), TODAY), f.rub.assurance, '2026-11');
    expect(t.expected[0]!.status).toBe('ouverte');
    expect([t.reel.value, t.reste.value]).toEqual([20000, 10000 + 20000]);
  });

  it('paiement avec écart accepté, puis paiement partiel', async () => {
    const { f, ech } = await scenario();
    const pay = await mv.createOperation(f.driver, await f.snap(), { account_id: f.acc.courant, op_date: '2026-11-12', amount_minor: -23000, nature: 'depense', rubrique_id: f.rub.assurance });
    await mv.createOperation(f.driver, await f.snap(), { account_id: f.acc.courant, op_date: '2026-11-13', amount_minor: -5000, nature: 'depense', rubrique_id: f.rub.assurance });
    await eng.reconcile(f.driver, await f.snap(), { movement_id: pay, target_key: `ech:${ech}`, closes_target: true }, TODAY);
    let t = trackRubrique(buildCtx(await f.snap(), TODAY), f.rub.assurance, '2026-11');
    expect(t.expected[0]).toMatchObject({ status: 'soldee', gap: 3000 });
    expect([t.reel.value, t.reste.value, t.ecart.value]).toEqual([28000, 25000, 3000]);
    // l'échéance ne peut pas être soldée deux fois
    await expect(eng.reconcile(f.driver, await f.snap(), { movement_id: pay, target_key: `ech:${ech}` }, TODAY)).rejects.toThrow();
    // paiement partiel sur une autre échéance
    const ech2 = await eng.createScheduled(f.driver, await f.snap(), { label: 'Option', due_date: '2026-11-28', amount_minor: -10000, currency: 'EUR', nature: 'depense', rubrique_id: f.rub.assurance });
    const part = await mv.createOperation(f.driver, await f.snap(), { account_id: f.acc.courant, op_date: '2026-11-14', amount_minor: -4000, nature: 'depense', rubrique_id: f.rub.assurance });
    await eng.reconcile(f.driver, await f.snap(), { movement_id: part, target_key: `ech:${ech2}` }, TODAY);
    t = trackRubrique(buildCtx(await f.snap(), TODAY), f.rub.assurance, '2026-11');
    const e2 = t.expected.find((e) => e.scheduled_item_id === ech2)!;
    expect(e2).toMatchObject({ status: 'partielle', remaining: 6000 });
    // B=500, E=300, L=200 ; réel 230+50+40 = 320 dont rapproché 230+40 ; R_nr = 50 ; U = 60
    expect([t.prevu.value, t.reel.value, t.reste.value]).toEqual([50000, 32000, 15000 + 6000]);
  });

  it('rapprochement refusé entre rubriques différentes', async () => {
    const { f, ech } = await scenario();
    const op = await mv.createOperation(f.driver, await f.snap(), { account_id: f.acc.courant, op_date: '2026-11-12', amount_minor: -20000, nature: 'depense', rubrique_id: f.rub.courses });
    await expect(eng.reconcile(f.driver, await f.snap(), { movement_id: op, target_key: `ech:${ech}` }, TODAY)).rejects.toThrow(/reclassez/);
  });

  it('budget inférieur aux échéances : signalé, prévu = échéances', async () => {
    const { f } = await scenario();
    await eng.setMonthBudget(f.driver, await f.snap(), { rubrique_id: f.rub.assurance, month: '2026-11', actualise_minor: 15000 });
    const t = trackRubrique(buildCtx(await f.snap(), TODAY), f.rub.assurance, '2026-11');
    expect(t.budgetBelowExpected).toBe(true);
    expect(t.budget).toMatchObject({ initial: 50000, actualise: 15000, referenceLabel: 'budget actualisé' });
    expect(t.prevu.value).toBe(20000);
    expect(t.prevu.notes[0]).toMatch(/inférieur aux échéances/);
  });

  it('mois incomplet : écoulé non clôturé = provisoire, échéance en retard reportée dans le reste du mois en cours', async () => {
    const f = await foyer();
    await eng.setBudgetPlan(f.driver, await f.snap(), { rubrique_id: f.rub.assurance, from_month: '2026-01', monthly_minor: 30000 });
    // le Livret A a un solde constaté au 15/10 : une échéance du 20/10 non payée est en retard
    await eng.createScheduled(f.driver, await f.snap(), { label: 'Facture d’octobre', due_date: '2026-10-20', amount_minor: -8000, currency: 'EUR', nature: 'depense', rubrique_id: f.rub.assurance, planned_account_id: f.acc.livret });
    // celle du 10/10 est antérieure à ce solde : réputée incluse, pas reportée
    await eng.createScheduled(f.driver, await f.snap(), { label: 'Facture ancienne', due_date: '2026-10-10', amount_minor: -5000, currency: 'EUR', nature: 'depense', rubrique_id: f.rub.assurance, planned_account_id: f.acc.livret });
    let ctx = buildCtx(await f.snap(), TODAY);
    const oct = trackRubrique(ctx, f.rub.assurance, '2026-10');
    expect(oct.state).toBe('ecoule');
    expect(oct.reste.value).toBe(0);
    expect(oct.ecart.notes).toContain('provisoire : mois non clôturé');
    const nov = trackRubrique(ctx, f.rub.assurance, '2026-11');
    expect(nov.late).toHaveLength(1);
    expect(nov.prevu.value).toBe(30000);
    expect(nov.reste.value).toBe(30000 + 8000);
    await eng.closeMonth(f.driver, await f.snap(), '2026-10', TODAY);
    ctx = buildCtx(await f.snap(), TODAY);
    expect(trackRubrique(ctx, f.rub.assurance, '2026-10').state).toBe('cloture');
    await expect(eng.closeMonth(f.driver, await f.snap(), '2026-11', TODAY)).rejects.toThrow(/pas terminé/);
  });

  it('méthode prorata et moyenne affichées', async () => {
    const f = await foyer();
    await ref.updateRubrique(f.driver, await f.snap(), f.rub.courses, { estimation_method: 'prorata' });
    await mv.createOperation(f.driver, await f.snap(), { account_id: f.acc.courant, op_date: '2026-11-10', amount_minor: -19000, nature: 'depense', rubrique_id: f.rub.courses });
    const t = trackRubrique(buildCtx(await f.snap(), TODAY), f.rub.courses, '2026-11');
    // 190 € en 19 jours sur 30 → 300 € estimés → reste 110 €
    expect(t.reste.value).toBe(11000);
    expect(t.estimation).toMatch(/19 jour\(s\) écoulé\(s\) sur 30/);
  });
});

describe('cas 5 et 11 : sous-totaux exacts, transfert EUR/CHF avec frais', () => {
  it('transfert neutre dans les revenus/dépenses ; frais et écart de change visibles à tous les niveaux', async () => {
    const f = await foyer();
    await ref.setFxRate(f.driver, await f.snap(), { rate_date: '2026-11-18', eur_chf: '0,9412' });
    await createTransfer(f.driver, await f.snap(), { from_account_id: f.acc.courant, to_account_id: f.acc.chf, date: '2026-11-18', out_minor: 100000, in_minor: 93500, fee: { amount_minor: 750 } });
    const ctx = buildCtx(await f.snap(), TODAY);
    const lines = periodLines(ctx, { from: '2026-11', to: '2026-11' }, { kind: 'foyer' });
    const fl = flows(ctx, lines);
    expect(fl.transfersCount).toBe(1);
    expect(fl.byCategory.revenu_structurel!.value).toBe(0);
    // consommation = frais 7,50 € + écart de change (993,41 − 1 000) = −14,09 €
    expect(fl.byCategory.consommation!.value).toBe(-750 - 659);
    expect(fl.figure.value).toBe(-1409);
    expect(checkFigureSums(fl.figure)).toEqual([]);
    // famille → rubrique → ligne
    const tree = familyTree(ctx, lines, (l) => l.category === 'consommation');
    const frais = tree.find((n) => n.name === 'Frais bancaires')!;
    expect(frais.figure.value).toBe(-1409);
    expect(frais.rubriques.map((r) => [r.name, r.figure.value])).toEqual([['Frais de transfert', -750], ['Écart de change', -659]]);
    expect(frais.rubriques[1]!.figure.components[0]!.sources).toEqual([{ kind: 'transfer', id: expect.any(Number) }]);
    // le même chiffre dans le suivi mensuel
    const mt = monthTracking(ctx, '2026-11');
    const fam = mt.families.find((x) => x.name === 'Frais bancaires')!;
    expect(fam.reel.value).toBe(1409);
    // l'anneau : même montant
    const d = expenseDonut(ctx, lines);
    expect(d.slices.find((s) => s.name === 'Frais bancaires')!.value).toBe(1409);
    // soldes : chaque compte reçoit sa jambe
    expect(accountBalance(ctx, f.acc.chf).minor).toBe(512000 + 93500);
    expect(accountBalance(ctx, f.acc.courant).minor).toBe(300000 - 100000 - 750);
  });

  it('tout sous-total de famille = somme exacte de son détail (conversion ligne par ligne)', async () => {
    const f = await foyer();
    for (const [d, a] of [['2026-11-02', -333], ['2026-11-03', -333], ['2026-11-04', -334], ['2026-11-05', -1]] as const)
      await mv.createOperation(f.driver, await f.snap(), { account_id: f.acc.chf, op_date: d, amount_minor: a, nature: 'depense', rubrique_id: f.rub.courses });
    await mv.createOperation(f.driver, await f.snap(), { account_id: f.acc.courant, op_date: '2026-11-06', amount_minor: -2599, nature: 'depense', rubrique_id: f.rub.restaurants });
    const ctx = buildCtx(await f.snap(), TODAY);
    const lines = periodLines(ctx, { from: '2026-11', to: '2026-11' }, { kind: 'foyer' });
    const tree = familyTree(ctx, lines);
    for (const n of tree) expect(checkFigureSums(n.figure)).toEqual([]);
    const mt = monthTracking(ctx, '2026-11');
    for (const fam of mt.families) for (const k of ['prevu', 'reel', 'reste'] as const) expect(checkFigureSums(fam[k])).toEqual([]);
    const alim = mt.families.find((x) => x.name === 'Alimentation')!;
    expect(alim.reel.value).toBe(alim.rubriques.reduce((s, r) => s + (r.reel.value ?? 0), 0));
  });
});

describe('cas 8 : périmètres comparables', () => {
  it('un compte isolé exclut totaux et écarts calculés, et n’est pas comparé au budget familial', async () => {
    const f = await foyer();
    await mv.createOperation(f.driver, await f.snap(), { account_id: f.acc.courant, op_date: '2026-11-03', amount_minor: -4000, nature: 'depense', rubrique_id: f.rub.courses });
    await mv.createTotal(f.driver, await f.snap(), { rubrique_id: f.rub.restaurants, period_month: '2026-11', amount_minor: -9000, currency: 'EUR', nature: 'depense' });
    const ctx = buildCtx(await f.snap(), TODAY);
    const info = scopeInfo(ctx, { kind: 'compte', account_id: f.acc.courant });
    expect(info.budgetComparable).toBe(false);
    expect(info.exclusions.join(' ')).toMatch(/totaux synthétiques/);
    const ls = periodLines(ctx, { from: '2026-11', to: '2026-11' }, { kind: 'compte', account_id: f.acc.courant });
    expect(ls.map((l) => l.amount_minor)).toEqual([-4000]);
    const all = periodLines(ctx, { from: '2026-11', to: '2026-11' }, { kind: 'foyer' });
    expect(all.map((l) => l.amount_minor).sort()).toEqual([-4000, -9000].sort());
  });
});

describe('suppression avec dépendances', () => {
  it('présente les conséquences avant d’agir, puis libère l’échéance', async () => {
    const f = await foyer();
    const ech = await eng.createScheduled(f.driver, await f.snap(), { label: 'Facture', due_date: '2026-11-25', amount_minor: -20000, currency: 'EUR', nature: 'depense', rubrique_id: f.rub.assurance });
    const op = await mv.createOperation(f.driver, await f.snap(), { account_id: f.acc.courant, op_date: '2026-11-12', amount_minor: -20000, nature: 'depense', rubrique_id: f.rub.assurance });
    await eng.reconcile(f.driver, await f.snap(), { movement_id: op, target_key: `ech:${ech}` }, TODAY);
    const ask = await mv.deleteMovements(f.driver, await f.snap(), [op], { confirmed: false });
    expect('kind' in ask && ask.kind).toBe('confirmation');
    if ('deps' in ask) expect(ask.deps.consequences[0]).toMatch(/redeviendront « non soldées »/);
    expect((await f.snap()).movements).toHaveLength(1);
    await mv.deleteMovements(f.driver, await f.snap(), [op], { confirmed: true });
    const ctx = buildCtx(await f.snap(), TODAY);
    expect(expectedBetween(ctx, '2026-11-01', '2026-11-30')[0]!.status).toBe('ouverte');
    await mv.restoreMovement(f.driver, op);
    expect((await f.snap()).movements).toHaveLength(1);
  });

  it('un transfert est supprimé entièrement', async () => {
    const f = await foyer();
    await createTransfer(f.driver, await f.snap(), { from_account_id: f.acc.courant, to_account_id: f.acc.livret, date: '2026-11-05', out_minor: 50000 });
    const leg = (await f.snap()).movements[0]!.id;
    const r = await mv.deleteMovements(f.driver, await f.snap(), [leg], { confirmed: true });
    expect('deleted' in r && r.deleted).toBe(2);
    expect((await f.snap()).movements).toHaveLength(0);
  });
});

describe('journal', () => {
  it('chaque écriture est tracée avec valeurs avant / après et identifiants réels', async () => {
    const f = await foyer();
    const op = await mv.createOperation(f.driver, await f.snap(), { account_id: f.acc.courant, op_date: '2026-11-03', amount_minor: -4000, nature: 'depense', rubrique_id: f.rub.courses });
    await mv.updateOperation(f.driver, await f.snap(), op, { rubrique_id: f.rub.restaurants, comment: 'reclassé' });
    const log = await f.driver.query("SELECT action, before_json, after_json FROM audit_log WHERE entity = 'movement' AND entity_id = ? ORDER BY id", [String(op)]);
    expect(log.map((l) => l.action)).toEqual(['create', 'update']);
    expect(JSON.parse(String(log[1]!.before_json))).toMatchObject({ rubrique_id: f.rub.courses, comment: '' });
    expect(JSON.parse(String(log[1]!.after_json))).toMatchObject({ rubrique_id: f.rub.restaurants, comment: 'reclassé' });
    const created = await f.driver.query("SELECT after_json FROM audit_log WHERE entity = 'balance_reference' ORDER BY id LIMIT 1");
    expect(JSON.parse(String(created[0]!.after_json)).account_id).toBe(f.acc.courant);
  });
});
