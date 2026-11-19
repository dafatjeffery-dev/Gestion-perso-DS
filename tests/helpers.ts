import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import initSqlJs from 'sql.js';
import { fromRecord } from '../src/storage/migrations';
import { SqlJsDriver } from '../src/storage/sqljsDriver';
import { loadSnapshot } from '../src/storage/snapshot';

const dir = join(__dirname, '..', 'migrations');
export const migrationFiles = () =>
  fromRecord(Object.fromEntries(readdirSync(dir).filter((f) => f.endsWith('.sql')).map((f) => [f, readFileSync(join(dir, f), 'utf8')])));

let SQL: Awaited<ReturnType<typeof initSqlJs>> | null = null;
export async function memoryDriver(): Promise<SqlJsDriver> {
  SQL ??= await initSqlJs();
  return SqlJsDriver.create(SQL, migrationFiles());
}

export async function setup() {
  const driver = await memoryDriver();
  return { driver, snap: () => loadSnapshot(driver) };
}

export const rubriqueId = async (driver: SqlJsDriver, ref: string) =>
  Number((await driver.query('SELECT id FROM rubrique WHERE ref = ?', [ref]))[0]!.id);
