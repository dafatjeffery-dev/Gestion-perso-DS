import { describe, expect, it } from 'vitest';
import * as ref from '../../src/services/referentials';
import { ValidationError } from '../../src/services/plan';
import { setup } from '../helpers';

describe('comptes', () => {
  it('création avec solde initial, en une transaction, journalisée', async () => {
    const { driver, snap } = await setup();
    const id = await ref.createAccount(driver, await snap(), {
      name: 'Courant CHF', currency: 'CHF', owner: 'A', type: 'courant',
      initialBalance: { ref_date: '2026-10-31', amount_minor: 512000 },
    });
    const s = await snap();
    expect(s.accounts[0]).toMatchObject({ id, name: 'Courant CHF', currency: 'CHF', status: 'actif' });
    expect(s.balanceRefs).toEqual([expect.objectContaining({ account_id: id, amount_minor: 512000, ref_date: '2026-10-31' })]);
    const log = await ref.auditTrail(driver, 'account', id);
    expect(log[0]).toMatchObject({ action: 'create', actor: 'utilisateur' });
    const group = log[0]!.action_group;
    const groupRows = await driver.query('SELECT entity FROM audit_log WHERE action_group = ?', [group as string]);
    expect(groupRows.map((r) => r.entity).sort()).toEqual(['account', 'balance_reference']);
  });

  it('messages de validation précis, aucune écriture', async () => {
    const { driver, snap } = await setup();
    await ref.createAccount(driver, await snap(), { name: 'Joint', currency: 'EUR', owner: 'commun', type: 'courant' });
    const e = await ref
      .createAccount(driver, await snap(), { name: ' joint ', currency: 'USD' as 'EUR', owner: 'commun', type: 'courant' })
      .catch((x) => x);
    expect(e).toBeInstanceOf(ValidationError);
    expect((e as ValidationError).errors.map((x) => x.field).sort()).toEqual(['currency', 'name']);
    expect((await snap()).accounts).toHaveLength(1);
  });

  it('archiver ne supprime ni historique ni solde ; réactivation possible', async () => {
    const { driver, snap } = await setup();
    const id = await ref.createAccount(driver, await snap(), {
      name: 'Ancien livret', currency: 'EUR', owner: 'B', type: 'epargne', is_default_for_currency: true,
      initialBalance: { ref_date: '2026-09-30', amount_minor: 10000 },
    });
    await ref.archiveAccount(driver, await snap(), id);
    let s = await snap();
    expect(s.accounts[0]).toMatchObject({ status: 'archive', is_default_for_currency: 0 });
    expect(s.accounts[0]!.archived_at).not.toBeNull();
    expect(s.balanceRefs).toHaveLength(1);
    await ref.reactivateAccount(driver, s, id);
    s = await snap();
    expect(s.accounts[0]).toMatchObject({ status: 'actif', archived_at: null });
  });

  it('un seul compte par défaut par devise', async () => {
    const { driver, snap } = await setup();
    const a = await ref.createAccount(driver, await snap(), { name: 'A', currency: 'EUR', owner: 'A', type: 'courant', is_default_for_currency: true });
    const b = await ref.createAccount(driver, await snap(), { name: 'B', currency: 'EUR', owner: 'B', type: 'courant', is_default_for_currency: true });
    const s = await snap();
    expect(s.accounts.find((x) => x.id === a)!.is_default_for_currency).toBe(0);
    expect(s.accounts.find((x) => x.id === b)!.is_default_for_currency).toBe(1);
  });

  it('devise figée dès qu’il existe un solde', async () => {
    const { driver, snap } = await setup();
    const id = await ref.createAccount(driver, await snap(), { name: 'X', currency: 'EUR', owner: 'A', type: 'courant', initialBalance: { ref_date: '2026-01-01', amount_minor: 0 } });
    await expect(ref.updateAccount(driver, await snap(), id, { currency: 'CHF' })).rejects.toThrow(/devise ne peut plus changer/);
  });

  it('solde de référence : même date = correction tracée, pas de doublon', async () => {
    const { driver, snap } = await setup();
    const id = await ref.createAccount(driver, await snap(), { name: 'X', currency: 'EUR', owner: 'A', type: 'courant' });
    await ref.setBalanceReference(driver, await snap(), { account_id: id, ref_date: '2026-11-15', amount_minor: 100 });
    await ref.setBalanceReference(driver, await snap(), { account_id: id, ref_date: '2026-11-15', amount_minor: 250 });
    const s = await snap();
    expect(s.balanceRefs).toHaveLength(1);
    expect(s.balanceRefs[0]!.amount_minor).toBe(250);
    const log = await ref.auditTrail(driver, 'balance_reference', s.balanceRefs[0]!.id);
    expect(log[0]).toMatchObject({ action: 'update', before_json: JSON.stringify({ amount_minor: 100, source: 'saisie', note: '' }) });
  });
});

describe('familles et rubriques', () => {
  it('création avec référence stable lisible et unique', async () => {
    const { driver, snap } = await setup();
    const fam = (await snap()).families.find((f) => f.name === 'Alimentation')!;
    const id = await ref.createRubrique(driver, await snap(), { family_id: fam.id, name: 'Café & goûters' });
    const id2 = await ref.createRubrique(driver, await snap(), { family_id: fam.id, name: 'Cafe goûters!' });
    const s = await snap();
    expect(s.rubriques.find((r) => r.id === id)!.ref).toBe('DEP.ALIMENTATION.CAFE_GOUTERS');
    expect(s.rubriques.find((r) => r.id === id2)!.ref).toBe('DEP.ALIMENTATION.CAFE_GOUTERS_2');
    await expect(ref.createRubrique(driver, s, { family_id: fam.id, name: 'café & GOÛTERS' })).rejects.toThrow(/existe déjà/);
  });

  it('« disponible » et « affichée » sont deux propriétés indépendantes', async () => {
    const { driver, snap } = await setup();
    const r = (await snap()).rubriques.find((x) => x.ref === 'DEP.LOISIRS.ABONNEMENTS')!;
    await ref.updateRubrique(driver, await snap(), r.id, { available_for_entry: false });
    let x = (await snap()).rubriques.find((y) => y.id === r.id)!;
    expect([x.available_for_entry, x.visible]).toEqual([0, 1]);
    await ref.updateRubrique(driver, await snap(), r.id, { visible: false, available_for_entry: true });
    x = (await snap()).rubriques.find((y) => y.id === r.id)!;
    expect([x.available_for_entry, x.visible]).toEqual([1, 0]);
  });

  it('rubriques système protégées', async () => {
    const { driver, snap } = await setup();
    const r = (await snap()).rubriques.find((x) => x.ref === 'SYS.CREDIT.INTERETS')!;
    await expect(ref.updateRubrique(driver, await snap(), r.id, { name: 'Autre' })).rejects.toThrow(/système/);
  });
});

describe('taux de change', () => {
  it('modifier un ancien taux : signalé, montants d’origine intacts, journalisé', async () => {
    const { driver, snap } = await setup();
    await ref.setFxRate(driver, await snap(), { rate_date: '2026-11-01', eur_chf: '0,9400' });
    await ref.setFxRate(driver, await snap(), { rate_date: '2026-11-10', eur_chf: '0,9450' });
    const acc = await ref.createAccount(driver, await snap(), { name: 'CHF', currency: 'CHF', owner: 'A', type: 'courant' });
    const rub = (await snap()).rubriques.find((r) => r.ref === 'DEP.ALIM.COURSES')!.id;
    for (const d of ['2026-11-03', '2026-11-12']) {
      await driver.apply([{ sql: "INSERT INTO movement (granularity, account_id, op_date, period_month, amount_minor, currency, nature, rubrique_id, created_at, updated_at) VALUES ('operation', ?, ?, substr(?,1,7), -10000, 'CHF', 'depense', ?, 'x', 'x')", params: [acc, d, d, rub] }]);
    }
    const notice = await ref.setFxRate(driver, await snap(), { rate_date: '2026-11-01', eur_chf: '0,9300' });
    expect(notice.affectedMovements).toBe(1);
    expect(notice.message).toMatch(/01\/11\/2026 au 10\/11\/2026 \(exclu\)/);
    const s = await snap();
    expect(s.movements.map((m) => m.amount_minor)).toEqual([-10000, -10000]);
    expect(s.fxRates.find((r) => r.rate_date === '2026-11-01')!.eur_chf_e6).toBe(930000);
    const log = await ref.auditTrail(driver, 'fx_rate', '2026-11-01');
    expect(log[0]).toMatchObject({ action: 'update' });
  });

  it('taux invalide ou implausible refusé', async () => {
    const { driver, snap } = await setup();
    await expect(ref.setFxRate(driver, await snap(), { rate_date: '2026-11-01', eur_chf: '9,41' })).rejects.toThrow(/plausible/);
    await expect(ref.setFxRate(driver, await snap(), { rate_date: '2026-11-01', eur_chf: 'x' })).rejects.toThrow(/invalide/);
  });

  it('import CSV : contrôle complet avant écriture', async () => {
    const { driver, snap } = await setup();
    await ref.setFxRate(driver, await snap(), { rate_date: '2026-11-02', eur_chf: '0,94' });
    const bad = ref.readRateCsv(await snap(), 'date;taux\n2026-11-01;0,9412\n31/02/2026;0,94\n2026-11-03;abc\n');
    expect(bad.errors.map((e) => e.line)).toEqual([3, 4]);
    await expect(ref.applyRateCsv(driver, await snap(), bad)).rejects.toThrow();
    expect((await snap()).fxRates).toHaveLength(1);
    const good = ref.readRateCsv(await snap(), '﻿date;taux\r\n2026-11-01;0,9412\r\n02/11/2026;0,9400\r\n2026-11-03;0.9433\r\n');
    expect(good.rows.map((r) => r.status)).toEqual(['nouveau', 'identique', 'nouveau']);
    expect(await ref.applyRateCsv(driver, await snap(), good)).toBe(2);
    expect((await snap()).fxRates.map((r) => r.source)).toEqual(['csv', 'manuel', 'csv']);
  });
});

describe('foyer et personnes', () => {
  it('modification journalisée', async () => {
    const { driver, snap } = await setup();
    await ref.updateHousehold(driver, await snap(), { name: 'Foyer Exemple', forecast_horizon_months: 18 });
    const p = (await snap()).persons[0]!;
    await ref.updatePerson(driver, await snap(), p.id, { display_name: 'Alex', retirement_date: '2055-06-30' });
    const s = await snap();
    expect(s.household).toMatchObject({ name: 'Foyer Exemple', forecast_horizon_months: 18 });
    expect(s.persons[0]).toMatchObject({ display_name: 'Alex', retirement_date: '2055-06-30' });
    await expect(ref.updateHousehold(driver, s, { forecast_horizon_months: 0 })).rejects.toThrow(/Horizon/);
  });
});
