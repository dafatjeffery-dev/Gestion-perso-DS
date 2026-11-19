// Plan d'écriture : toutes les instructions d'une action utilisateur + leurs entrées de
// journal, exécutées en une transaction (docs/ARCHITECTURE.md § 2 et § 7).

import type { ApplyResult, Driver, SqlParam, Stmt } from '../storage/driver';

export type Actor = 'utilisateur' | 'systeme' | `import:${number}`;
export type AuditAction = 'create' | 'update' | 'delete' | 'restore' | 'move';

export interface FieldError {
  field: string;
  message: string;
}

export class ValidationError extends Error {
  constructor(public readonly errors: FieldError[]) {
    super(errors.map((e) => e.message).join(' · '));
    this.name = 'ValidationError';
  }
}

export function fail(field: string, message: string): never {
  throw new ValidationError([{ field, message }]);
}

/** Référence à une ligne insérée plus tôt dans le même plan. */
export interface Ref {
  $ref: number;
}

let counter = 0;
export function newGroupId(): string {
  counter = (counter + 1) % 1_000_000;
  const rnd = Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
  return `${Date.now().toString(36)}-${counter.toString(36)}-${rnd}`;
}

const json = (v: unknown): string | null => (v === undefined ? null : JSON.stringify(v));

export class Plan {
  readonly stmts: Stmt[] = [];
  readonly group: string;
  readonly ts: string;

  constructor(
    readonly actor: Actor = 'utilisateur',
    opts: { group?: string; ts?: string } = {},
  ) {
    this.group = opts.group ?? newGroupId();
    this.ts = opts.ts ?? new Date().toISOString();
  }

  get isEmpty(): boolean {
    return this.stmts.length === 0;
  }

  raw(sql: string, params: SqlParam[] = []): number {
    this.stmts.push({ sql, params });
    return this.stmts.length - 1;
  }

  /** INSERT + entrée de journal 'create'. Renvoie une référence utilisable dans les instructions suivantes. */
  insert(table: string, values: Record<string, SqlParam>, summary: string, entity = table): Ref {
    const cols = Object.keys(values);
    const idx = this.raw(
      `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
      cols.map((c) => values[c]!),
    );
    const ref: Ref = { $ref: idx };
    this.audit(entity, ref, 'create', summary, undefined, values);
    return ref;
  }

  /** UPDATE d'une ligne identifiée par `id`, avec valeurs avant/après au journal. */
  update(
    table: string,
    id: number | string | Ref,
    before: Record<string, unknown>,
    changes: Record<string, SqlParam>,
    summary: string,
    opts: { entity?: string; action?: AuditAction; idColumn?: string } = {},
  ): void {
    const cols = Object.keys(changes);
    if (cols.length === 0) return;
    this.raw(`UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE ${opts.idColumn ?? 'id'} = ?`, [
      ...cols.map((c) => changes[c]!),
      id,
    ]);
    const prev: Record<string, unknown> = {};
    for (const c of cols) prev[c] = before[c];
    this.audit(opts.entity ?? table, id, opts.action ?? 'update', summary, prev, changes);
  }

  audit(
    entity: string,
    id: number | string | Ref,
    action: AuditAction,
    summary: string,
    before?: unknown,
    after?: unknown,
  ): void {
    // Les références à des lignes créées dans le même plan sont résolues par SQLite (json_set),
    // pour que le journal contienne les vrais identifiants.
    const withRefs = (v: unknown): { sql: string; params: SqlParam[] } => {
      if (v === undefined) return { sql: '?', params: [null] };
      const refs = v && typeof v === 'object' ? Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== null && typeof x === 'object' && '$ref' in (x as object)) : [];
      if (!refs.length) return { sql: '?', params: [json(v)] };
      const plain = { ...(v as Record<string, unknown>) };
      for (const [k] of refs) plain[k] = null;
      return { sql: `json_set(?${refs.map(() => ', ?, ?').join('')})`, params: [json(plain), ...refs.flatMap(([k, x]) => [`$.${k}`, x as Ref])] };
    };
    const b = withRefs(before);
    const a = withRefs(after);
    this.raw(
      `INSERT INTO audit_log (ts, actor, action_group, entity, entity_id, action, summary, before_json, after_json) VALUES (?, ?, ?, ?, ?, ?, ?, ${b.sql}, ${a.sql})`,
      [this.ts, this.actor, this.group, entity, typeof id === 'object' ? id : String(id), action, summary, ...b.params, ...a.params],
    );
  }

  async run(driver: Driver): Promise<ApplyResult> {
    return driver.apply(this.stmts);
  }

  /** Identifiant réel d'une ligne insérée, après exécution. */
  static id(result: ApplyResult, ref: Ref): number {
    const id = result.inserted_ids[ref.$ref];
    if (!id) throw new Error('référence sans insertion');
    return id;
  }
}
