// Tests du stockage sur base temporaire sql.js : mêmes migrations que l'application Mac.
import initSqlJs from 'sql.js';
import { describe, expect, it } from 'vitest';
import { SqlJsDriver, type Persistence } from '../../src/storage/sqljsDriver';
import { loadSnapshot } from '../../src/storage/snapshot';
import { sha256Hex } from '../../src/storage/migrations';
import { memoryDriver, migrationFiles, rubriqueId } from '../helpers';

describe('stockage sql.js', () => {
  it('applique les migrations et charge un snapshot cohérent', async () => {
    const d = await memoryDriver();
    const s = await loadSnapshot(d);
    expect(s.household.base_currency).toBe('EUR');
    expect(s.persons.map((p) => p.role)).toEqual(['A', 'B']);
    expect(s.natures).toHaveLength(11);
    expect(s.rubriques.find((r) => r.ref === 'SYS.FRAIS.ECART_CHANGE')?.is_system).toBe(1);
    expect(s.scenarios).toHaveLength(3);
  });

  it('somme de contrôle identique à celle du Rust (SHA-256, fins de ligne normalisées)', async () => {
    expect(await sha256Hex('a\r\nb')).toBe(await sha256Hex('a\nb'));
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('plan atomique : une erreur annule tout', async () => {
    const d = await memoryDriver();
    await expect(
      d.apply([
        { sql: "INSERT INTO account (name, currency, owner, type) VALUES ('A','EUR','commun','courant')", params: [] },
        { sql: "INSERT INTO account (name, currency, owner, type) VALUES ('B','USD','commun','courant')", params: [] },
      ]),
    ).rejects.toThrow(/Instruction 1/);
    expect(await d.query('SELECT * FROM account')).toHaveLength(0);
  });

  it('$ref relie les lignes créées dans le même plan', async () => {
    const d = await memoryDriver();
    const r = await d.apply([
      { sql: "INSERT INTO account (name, currency, owner, type) VALUES ('A','CHF','A','courant')", params: [] },
      { sql: "INSERT INTO balance_reference (account_id, ref_date, amount_minor) VALUES (?, '2026-10-31', 1)", params: [{ $ref: 0 }] },
    ]);
    const [b] = await d.query('SELECT account_id FROM balance_reference');
    expect(b!.account_id).toBe(r.inserted_ids[0]);
  });

  it('contraintes : devise du compte, nature/rubrique, total sans compte, date valide', async () => {
    const d = await memoryDriver();
    const r = await d.apply([{ sql: "INSERT INTO account (name, currency, owner, type) VALUES ('C','CHF','A','courant')", params: [] }]);
    const acc = r.inserted_ids[0]!;
    const courses = await rubriqueId(d, 'DEP.ALIM.COURSES');
    const op = (cur: string, nature: string, date = '2026-11-02') => ({
      sql: `INSERT INTO movement (granularity, account_id, op_date, period_month, amount_minor, currency, nature, rubrique_id, created_at, updated_at)
            VALUES ('operation', ?, ?, substr(?, 1, 7), -1250, ?, ?, ?, 'x', 'x')`,
      params: [acc, date, date, cur, nature, courses],
    });
    await expect(d.apply([op('EUR', 'depense')])).rejects.toThrow(/devise/);
    await expect(d.apply([op('CHF', 'revenu_ordinaire')])).rejects.toThrow(/nature incompatible/);
    await expect(d.apply([op('CHF', 'depense', '2026-02-30')])).rejects.toThrow();
    await d.apply([op('CHF', 'depense')]);
    await expect(
      d.apply([{
        sql: `INSERT INTO movement (granularity, account_id, period_month, amount_minor, currency, nature, rubrique_id, created_at, updated_at)
              VALUES ('total', ?, '2026-11', -5000, 'CHF', 'depense', ?, 'x', 'x')`,
        params: [acc, courses],
      }]),
    ).rejects.toThrow(/CHECK/);
  });

  it('montants non entiers refusés', async () => {
    const d = await memoryDriver();
    await expect(d.apply([{ sql: 'INSERT INTO setting (key, value_json) VALUES (?, ?)', params: ['x', 1.5] }])).rejects.toThrow(/non entier/);
  });

  it('query refuse les écritures', async () => {
    const d = await memoryDriver();
    await expect(d.query('DELETE FROM account')).rejects.toThrow(/lectures/);
    await expect(d.query('SELECT 1; DELETE FROM account')).rejects.toThrow(/lectures/);
  });

  it('versions de récurrence qui se chevauchent refusées', async () => {
    const d = await memoryDriver();
    const courses = await rubriqueId(d, 'DEP.LOISIRS.ABONNEMENTS');
    const r = await d.apply([{ sql: "INSERT INTO recurrence (label, nature, rubrique_id, created_at) VALUES ('Box', 'depense', ?, 'x')", params: [courses] }]);
    const id = r.inserted_ids[0]!;
    const v = (from: string, to: string | null) => ({
      sql: "INSERT INTO recurrence_version (recurrence_id, valid_from, valid_to, amount_minor, currency, frequency, day_of_month, change_kind, created_at) VALUES (?, ?, ?, -3999, 'EUR', 'mensuelle', 5, 'creation', 'x')",
      params: [id, from, to],
    });
    await d.apply([v('2026-01-01', '2026-06-30')]);
    await expect(d.apply([v('2026-06-01', null)])).rejects.toThrow(/chevauchent/);
    await d.apply([v('2026-07-01', null)]);
  });

  it('persistance (aperçu navigateur) : conservée à la réouverture, migration ultérieure sans perte', async () => {
    const SQL = await initSqlJs();
    let stored: Uint8Array | null = null;
    const persistence: Persistence = { label: 'test', load: async () => stored, save: async (b) => { stored = b; } };
    const d1 = await SqlJsDriver.create(SQL, migrationFiles(), persistence);
    await d1.apply([{ sql: "INSERT INTO account (name, currency, owner, type) VALUES ('Livret','EUR','B','epargne')", params: [] }]);
    const d2 = await SqlJsDriver.create(SQL, migrationFiles(), persistence);
    expect(await d2.query('SELECT name FROM account')).toEqual([{ name: 'Livret' }]);
    const more = [...migrationFiles(), { version: 3, name: '0003_test', sql: 'ALTER TABLE account ADD COLUMN memo TEXT;' }];
    const d3 = await SqlJsDriver.create(SQL, more, persistence);
    expect(await d3.query('SELECT name, memo FROM account')).toEqual([{ name: 'Livret', memo: null }]);
    expect((await d3.query('SELECT MAX(version) AS v FROM schema_migrations'))[0]!.v).toBe(3);
  });

  it('migration modifiée détectée, migration en échec sans effet', async () => {
    const SQL = await initSqlJs();
    let stored: Uint8Array | null = null;
    const persistence: Persistence = { label: 'test', load: async () => stored, save: async (b) => { stored = b; } };
    await SqlJsDriver.create(SQL, migrationFiles(), persistence);
    const altered = migrationFiles().map((m) => (m.version === 2 ? { ...m, sql: m.sql + '\n-- modif' } : m));
    await expect(SqlJsDriver.create(SQL, altered, persistence)).rejects.toThrow(/modifiée/);
    const broken = [...migrationFiles(), { version: 3, name: '0003_casse', sql: 'ALTER TABLE account ADD COLUMN x TEXT; SELECT * FROM nulle_part;' }];
    await expect(SqlJsDriver.create(SQL, broken, persistence)).rejects.toThrow(/0003_casse/);
    const d = await SqlJsDriver.create(SQL, migrationFiles(), persistence);
    expect(await d.query("SELECT COUNT(*) AS n FROM pragma_table_info('account') WHERE name = 'x'")).toEqual([{ n: 0 }]);
  });
});
