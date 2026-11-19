// Adaptateur sql.js : SQLite en WebAssembly. Utilisé par l'aperçu navigateur (persistance
// IndexedDB) et par les tests (mémoire). Mêmes migrations et mêmes règles que l'adaptateur Rust.

import type { Database, SqlJsStatic, SqlValue } from 'sql.js';
import type { ApplyResult, BackupManifest, Driver, Row, SqlParam, StorageInfo, Stmt } from './driver';
import { sha256Hex, type MigrationFile } from './migrations';

export interface Persistence {
  load(): Promise<Uint8Array | null>;
  save(bytes: Uint8Array): Promise<void>;
  label: string;
}

const nowUtc = () => new Date().toISOString();

function bind(params: SqlParam[], inserted: number[]): SqlValue[] {
  return params.map((p) => {
    if (p !== null && typeof p === 'object') {
      const id = inserted[p.$ref];
      if (!id) throw new Error(`$ref ${p.$ref} ne désigne pas une insertion du plan`);
      return id;
    }
    if (typeof p === 'number' && !Number.isInteger(p)) {
      throw new Error(`Nombre non entier refusé : ${p} (montants en unités mineures)`);
    }
    return p;
  });
}

export function checkIntegrity(db: Database): void {
  const ic = db.exec('PRAGMA integrity_check')[0]?.values[0]?.[0];
  if (ic !== 'ok') throw new Error(`Contrôle d'intégrité en échec : ${String(ic)}`);
  const fk = db.exec('PRAGMA foreign_key_check');
  if (fk.length > 0 && fk[0]!.values.length > 0) {
    throw new Error(`Référence invalide dans la table ${String(fk[0]!.values[0]![0])}`);
  }
}

export async function migrate(db: Database, migrations: MigrationFile[]): Promise<number[]> {
  db.run(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)`);
  const applied = new Map<number, { name: string; checksum: string }>();
  for (const row of db.exec('SELECT version, name, checksum FROM schema_migrations')[0]?.values ?? []) {
    applied.set(Number(row[0]), { name: String(row[1]), checksum: String(row[2]) });
  }
  const appMax = Math.max(0, ...migrations.map((m) => m.version));
  for (const [v, a] of applied) {
    const m = migrations.find((x) => x.version === v);
    if (!m) {
      if (v > appMax) throw new Error(`Base au schéma ${v}, plus récent que l'application (${appMax}).`);
      throw new Error(`Migration ${a.name} inconnue de cette version.`);
    }
    if ((await sha256Hex(m.sql)) !== a.checksum) {
      throw new Error(`La migration ${a.name} appliquée à cette base a été modifiée depuis : démarrage refusé.`);
    }
  }
  const done: number[] = [];
  for (const m of migrations) {
    if (applied.has(m.version)) continue;
    const sum = await sha256Hex(m.sql);
    db.run('BEGIN IMMEDIATE');
    try {
      db.exec(m.sql);
      db.run('INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)', [
        m.version,
        m.name,
        sum,
        nowUtc(),
      ]);
      checkIntegrity(db);
      db.run(`PRAGMA user_version = ${m.version}`);
      db.run('COMMIT');
    } catch (e) {
      db.run('ROLLBACK');
      throw new Error(`Migration ${m.name} : ${(e as Error).message}`);
    }
    done.push(m.version);
  }
  return done;
}

export class SqlJsDriver implements Driver {
  private constructor(
    private readonly db: Database,
    private readonly persistence: Persistence | null,
    private readonly kind: 'navigateur' | 'memoire',
  ) {}

  static async create(
    SQL: SqlJsStatic,
    migrations: MigrationFile[],
    persistence: Persistence | null = null,
  ): Promise<SqlJsDriver> {
    const bytes = persistence ? await persistence.load() : null;
    const db = bytes ? new SQL.Database(bytes) : new SQL.Database();
    db.run('PRAGMA foreign_keys = ON');
    await migrate(db, migrations);
    const d = new SqlJsDriver(db, persistence, persistence ? 'navigateur' : 'memoire');
    await d.persist();
    return d;
  }

  /** Accès direct réservé aux tests. */
  get raw(): Database {
    return this.db;
  }

  private async persist(): Promise<void> {
    if (this.persistence) await this.persistence.save(this.db.export());
  }

  async query(sql: string, params: SqlParam[] = []): Promise<Row[]> {
    const trimmed = sql.trim().replace(/;\s*$/, '');
    if (!/^(SELECT|WITH)\b/i.test(trimmed) || trimmed.includes(';')) {
      throw new Error("db_query n'accepte que des lectures");
    }
    const stmt = this.db.prepare(trimmed);
    try {
      stmt.bind(bind(params, []));
      const out: Row[] = [];
      while (stmt.step()) out.push(stmt.getAsObject() as Row);
      return out;
    } finally {
      stmt.free();
    }
  }

  async apply(plan: Stmt[]): Promise<ApplyResult> {
    const inserted: number[] = [];
    const changes: number[] = [];
    this.db.run('BEGIN IMMEDIATE');
    try {
      plan.forEach((s, i) => {
        try {
          this.db.run(s.sql, bind(s.params, inserted));
        } catch (e) {
          throw new Error(`Instruction ${i} : ${(e as Error).message}`);
        }
        const n = this.db.getRowsModified();
        const isInsert = /^\s*INSERT/i.test(s.sql);
        const id = Number(this.db.exec('SELECT last_insert_rowid()')[0]!.values[0]![0]);
        inserted.push(isInsert && n > 0 ? id : 0);
        changes.push(n);
      });
      const fk = this.db.exec('PRAGMA foreign_key_check');
      if (fk.length > 0 && fk[0]!.values.length > 0) {
        throw new Error(`Référence invalide dans la table ${String(fk[0]!.values[0]![0])}`);
      }
      this.db.run('COMMIT');
    } catch (e) {
      this.db.run('ROLLBACK');
      throw e;
    }
    await this.persist();
    return { inserted_ids: inserted, changes };
  }

  async info(): Promise<StorageInfo> {
    return {
      kind: this.kind,
      locationLabel:
        this.kind === 'navigateur'
          ? `Aperçu navigateur — données stockées dans ce navigateur (${this.persistence?.label ?? 'IndexedDB'}), pas dans l'application Mac.`
          : 'Base temporaire en mémoire (tests) — rien n’est enregistré.',
      databasePath: null,
      backupsPath: null,
      readOnly: false,
      lastBackup: null,
    };
  }

  /** En aperçu, une sauvegarde est un fichier téléchargé : géré par l'interface via exportBytes(). */
  async backupNow(): Promise<BackupManifest | null> {
    return null;
  }
  async listBackups(): Promise<BackupManifest[]> {
    return [];
  }

  exportBytes(): Uint8Array {
    return this.db.export();
  }

  private drafts = '{}';
  async readDrafts(): Promise<string> {
    if (this.kind === 'navigateur' && typeof localStorage !== 'undefined') {
      try {
        return localStorage.getItem('ds-finances-drafts') ?? '{}';
      } catch {
        return this.drafts;
      }
    }
    return this.drafts;
  }
  async writeDrafts(content: string): Promise<void> {
    this.drafts = content;
    if (this.kind === 'navigateur' && typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem('ds-finances-drafts', content);
      } catch {
        /* stockage indisponible : brouillon conservé en mémoire seulement */
      }
    }
  }
}
