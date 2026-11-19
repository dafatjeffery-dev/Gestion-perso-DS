import initSqlJs from 'sql.js';
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { checkFullExport, exportFull, importFull } from '../../src/export/full';
import { readableTables, toCsv, toXlsx } from '../../src/export/readable';
import { ecbCsvToRates, fetchEcbRates } from '../../src/services/ecb';
import { analyze, emptyDecisions } from '../../src/import/analyze';
import { readCsv } from '../../src/import/read';
import * as imports from '../../src/services/imports';
import * as mv from '../../src/services/movements';
import * as loans from '../../src/services/loans';
import { SqlJsDriver, type Persistence } from '../../src/storage/sqljsDriver';
import { loadSnapshot } from '../../src/storage/snapshot';
import { foyer } from '../fixtures/foyer';
import { memoryDriver, migrationFiles } from '../helpers';

async function populated() {
  const f = await foyer();
  await mv.createOperation(f.driver, await f.snap(), { account_id: f.acc.courant, op_date: '2026-11-03', amount_minor: -4210, nature: 'depense', rubrique_id: f.rub.courses, label_original: 'CB "MARCHÉ"; centre', comment: 'ligne\navec retour' });
  await mv.createTotal(f.driver, await f.snap(), { rubrique_id: f.rub.restaurants, period_month: '2026-10', amount_minor: -12000, currency: 'EUR', nature: 'depense' });
  await loans.saveLoan(f.driver, await f.snap(), { label: 'Auto', currency: 'EUR', mode: 'theorique', frequency: 'mensuelle', first_due_date: '2026-12-10', principal_minor: 1_200_000, annual_rate_e6: 30_000, periods: 12 });
  const csv = '﻿identifiant_bancaire;compte;date_operation;date_valeur;libelle_bancaire;libelle_simplifie;montant;devise;nature;famille;rubrique;reference_transfert;commentaire;statut_classement\nX1;CPT-1;2026-11-05;;BOULANGERIE;;-3,20;EUR;depense;;DEP.ALIM.COURSES;;;confirmé\n';
  const p = analyze(await f.snap(), readCsv('a.csv', csv), emptyDecisions());
  await imports.commitImport(f.driver, await f.snap(), p, emptyDecisions(), { sha256: 'abc' });
  return f;
}

describe('cas 13 et 14 : export complet, restauration', () => {
  it('export complet JSON réimporté à l’identique dans une base neuve (lots d’import compris)', async () => {
    const f = await populated();
    const exp = JSON.parse(JSON.stringify(await exportFull(f.driver)));
    const target = await memoryDriver();
    expect((await checkFullExport(target, exp)).ok).toBe(true);
    await importFull(target, exp);
    const a = await loadSnapshot(f.driver);
    const b = await loadSnapshot(target);
    expect(b).toEqual(a);
    expect(b.importBatches).toHaveLength(1);
    expect(await target.query('SELECT COUNT(*) AS n FROM audit_log')).toEqual(await f.driver.query('SELECT COUNT(*) AS n FROM audit_log'));
  });

  it('export non conforme refusé', async () => {
    const d = await memoryDriver();
    expect((await checkFullExport(d, { format: 'autre' })).errors[0]).toMatch(/n’est pas un export complet/);
    const exp = await exportFull(d);
    expect((await checkFullExport(d, { ...exp, schema_version: 99 })).errors.join()).toMatch(/plus récente/);
  });

  it('aperçu navigateur : une copie récente contient les dernières modifications validées et se restaure, persistance comprise', async () => {
    const SQL = await initSqlJs();
    let stored: Uint8Array | null = null;
    const persistence: Persistence = { label: 'test', load: async () => stored, save: async (b) => { stored = b; } };
    const d = await SqlJsDriver.create(SQL, migrationFiles(), persistence);
    await d.apply([{ sql: "INSERT INTO account (name, currency, owner, type) VALUES ('Avant', 'EUR', 'A', 'courant')", params: [] }]);
    const copy = d.exportDatabase();
    await d.apply([{ sql: "INSERT INTO account (name, currency, owner, type) VALUES ('Après', 'EUR', 'A', 'courant')", params: [] }]);
    await expect(d.restoreDatabase(new Uint8Array([1, 2, 3]))).rejects.toThrow(/Restauration refusée/);
    expect(await d.query('SELECT name FROM account ORDER BY id')).toEqual([{ name: 'Avant' }, { name: 'Après' }]);
    await d.restoreDatabase(copy);
    expect(await d.query('SELECT name FROM account')).toEqual([{ name: 'Avant' }]);
    const reopened = await SqlJsDriver.create(SQL, migrationFiles(), persistence);
    expect(await reopened.query('SELECT name FROM account')).toEqual([{ name: 'Avant' }]);
  });
});

describe('exports lisibles', () => {
  it('CSV : opérations, totaux, budgets, crédits ; échappement correct ; XLSX à 4 feuilles', async () => {
    const f = await populated();
    const tables = readableTables(await f.snap(), '2026-11-19');
    expect(tables.map((t) => t.name)).toEqual(['Operations', 'Totaux', 'Budgets', 'Credits']);
    const ops = toCsv(tables[0]!);
    expect(ops.startsWith('﻿Date;Date de valeur;Compte')).toBe(true);
    expect(ops).toContain('"CB ""MARCHÉ""; centre"');
    expect(ops).toContain('-42,10');
    expect(toCsv(tables[1]!)).toContain('2026-10;Alimentation;Restaurants;DEP.ALIM.RESTAURANTS;-120,00;EUR;depense');
    expect(tables[3]!.rows).toHaveLength(12);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await toXlsx(tables)).buffer as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Operations', 'Totaux', 'Budgets', 'Credits']);
  });
});

describe('taux BCE (récupération facultative)', () => {
  it('lecture de la réponse CSV de la BCE et enregistrement source « bce »', async () => {
    const f = await foyer();
    const body = 'KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE\nEXR.D.CHF.EUR.SP00.A,D,CHF,EUR,SP00,A,2026-11-17,0.9405\nEXR.D.CHF.EUR.SP00.A,D,CHF,EUR,SP00,A,2026-11-18,0.94123\n';
    expect(ecbCsvToRates(body)).toBe('date;taux\n2026-11-17;0,9405\n2026-11-18;0,94123');
    const fake = (async () => new Response(body, { status: 200 })) as unknown as typeof fetch;
    expect(await fetchEcbRates(f.driver, await f.snap(), '2026-11-01', '2026-11-19', fake)).toBe(2);
    expect((await f.snap()).fxRates.filter((r) => r.source === 'bce').map((r) => r.eur_chf_e6)).toEqual([940500, 941230]);
  });
});
