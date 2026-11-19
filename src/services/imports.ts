// Intégration atomique d'un import validé, et annulation d'un lot avec ses dépendances.

import { formatDateFr } from '../domain/dates';
import type { Snapshot } from '../domain/types';
import type { Decisions, Preview } from '../import/analyze';
import type { Driver, SqlParam } from '../storage/driver';
import { COVERAGE_LABEL, movementDependencies } from './movements';
import { Plan, fail, type Ref } from './plan';

export async function commitImport(driver: Driver, snap: Snapshot, preview: Preview, decisions: Decisions, meta: { sha256: string }): Promise<number> {
  if (preview.blocking.length) fail('import', `${preview.blocking.length} erreur(s) bloquante(s) : aucune écriture`);
  const toImport = preview.rows.filter((r) => r.willImport && r.candidate);
  if (!toImport.length) fail('import', 'Aucune ligne à importer');
  const nextId = Math.max(0, ...snap.importBatches.map((b) => b.id)) + 1;
  const p = new Plan(`import:${nextId}`);
  const batch = p.insert(
    'import_batch',
    {
      imported_at: p.ts,
      file_name: preview.fileName,
      file_sha256: meta.sha256,
      file_kind: preview.kind,
      format_version: preview.formatVersion,
      account_ids_json: JSON.stringify(preview.accounts),
      period_from: preview.period?.from ?? null,
      period_to: preview.period?.to ?? null,
      rows_total: preview.counts.total,
      rows_imported: preview.counts.toImport - preview.counts.flagged,
      rows_excluded: preview.counts.excluded,
      rows_flagged: preview.counts.flagged,
      status: 'integre',
    },
    `Import de « ${preview.fileName} » : ${preview.counts.toImport} opération(s)`,
  );
  for (const e of preview.coverageNeeded) {
    const mode = decisions.coverage[e.key]!;
    p.insert('coverage_decision', { rubrique_id: e.rubrique_id, period_month: e.month, mode, decided_at: p.ts }, `Couverture ${e.month} (import) : ${COVERAGE_LABEL[mode]}`);
  }
  const transferOf = new Map<number, { ref: Ref; role: 'sortie' | 'entree' }>();
  for (const t of preview.transfers) {
    const ref = p.insert('transfer', { reference: t.ref }, `Transfert importé « ${t.ref} »`);
    for (const rowNo of t.rows) {
      const c = preview.rows.find((r) => r.rowNo === rowNo)!.candidate!;
      transferOf.set(rowNo, { ref, role: c.amount_minor < 0 ? 'sortie' : 'entree' });
    }
  }
  for (const row of preview.rows) {
    const c = row.candidate;
    const raw = JSON.stringify(row.raw, (_k, v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v));
    if (row.willImport && c) {
      const t = transferOf.get(row.rowNo);
      const vals: Record<string, SqlParam> = {
        granularity: 'operation',
        account_id: c.account_id,
        op_date: c.op_date,
        value_date: c.value_date,
        period_month: c.op_date.slice(0, 7),
        amount_minor: c.amount_minor,
        currency: c.currency,
        nature: c.nature,
        rubrique_id: c.rubrique_id,
        label_original: c.label_original,
        label_simple: c.label_simple,
        bank_id: c.bank_id,
        comment: c.comment,
        classification: c.classification,
        transfer_id: t ? t.ref : null,
        transfer_role: t ? t.role : null,
        import_batch_id: batch,
        import_row: row.rowNo,
        created_at: p.ts,
        updated_at: p.ts,
      };
      const m = p.insert('movement', vals, `Importée (ligne ${row.rowNo})`);
      const flagged = row.issues.some((i) => i.level === 'avertissement');
      p.raw('INSERT INTO import_row (batch_id, row_no, outcome, reason, movement_id, raw_json) VALUES (?, ?, ?, ?, ?, ?)', [batch, row.rowNo, flagged ? 'signalee' : 'importee', flagged ? row.issues.map((i) => i.reason).join(' ; ') : null, m, raw]);
    } else {
      p.raw('INSERT INTO import_row (batch_id, row_no, outcome, reason, movement_id, raw_json) VALUES (?, ?, ?, ?, ?, ?)', [batch, row.rowNo, 'exclue', row.dupReason ?? row.issues.map((i) => i.reason).join(' ; ') ?? 'exclue', null, raw]);
    }
  }
  const r = await p.run(driver);
  return Plan.id(r, batch);
}

export interface CancelAnalysis {
  batchId: number;
  movements: number[];
  /** Opérations modifiées depuis l'import (d'après le journal). */
  modified: number[];
  consequences: string[];
}

export async function analyzeCancel(driver: Driver, snap: Snapshot, batchId: number): Promise<CancelAnalysis> {
  const b = snap.importBatches.find((x) => x.id === batchId);
  if (!b) fail('batch', 'Lot introuvable');
  if (b.status === 'annule') fail('batch', 'Ce lot est déjà annulé');
  const ids = snap.movements.filter((m) => m.import_batch_id === batchId).map((m) => m.id);
  const modified: number[] = [];
  for (const id of ids) {
    const rows = await driver.query("SELECT COUNT(*) AS n FROM audit_log WHERE entity = 'movement' AND entity_id = ? AND action IN ('update', 'move') AND ts > ?", [String(id), b.imported_at]);
    if (Number(rows[0]!.n) > 0) modified.push(id);
  }
  const deps = movementDependencies(snap, ids);
  const consequences: string[] = [`${ids.length} opération(s) du lot n° ${batchId} (« ${b.file_name} », ${formatDateFr(b.imported_at.slice(0, 10))}).`];
  if (modified.length) consequences.push(`${modified.length} opération(s) ont été modifiées depuis l’import (reclassement, commentaire…) : vous pouvez les conserver ou les supprimer aussi.`);
  consequences.push(...deps.consequences);
  return { batchId, movements: ids, modified, consequences };
}

/** Annule un lot : met ses opérations à la corbeille ; les dépendances sont traitées explicitement. */
export async function cancelBatch(driver: Driver, snap: Snapshot, a: CancelAnalysis, opts: { keepModified: boolean }): Promise<{ deleted: number; kept: number }> {
  const b = snap.importBatches.find((x) => x.id === a.batchId)!;
  const toDelete = a.movements.filter((id) => !(opts.keepModified && a.modified.includes(id)));
  const deps = movementDependencies(snap, toDelete);
  const p = new Plan();
  for (const r of deps.reconciliations) {
    p.raw('DELETE FROM reconciliation WHERE id = ?', [r.id]);
    p.audit('reconciliation', r.id, 'delete', `Rapprochement annulé (annulation du lot n° ${b.id})`, r);
  }
  for (const c of deps.fundConsumptions) {
    p.raw('DELETE FROM fund_consumption WHERE id = ?', [c.id]);
    p.audit('fund_consumption', c.id, 'delete', `Paiement de projet retiré (annulation du lot n° ${b.id})`, c);
  }
  for (const m of [...deps.movements, ...deps.transferPartners]) {
    p.update('movement', m.id, m as unknown as Record<string, unknown>, { deleted_at: p.ts }, `Annulation du lot n° ${b.id}`, { action: 'delete' });
  }
  p.update('import_batch', b.id, b as unknown as Record<string, unknown>, { status: 'annule', cancelled_at: p.ts }, `Lot n° ${b.id} annulé${opts.keepModified && a.modified.length ? ` (${a.modified.length} opération(s) modifiée(s) conservée(s))` : ''}`);
  await p.run(driver);
  return { deleted: deps.movements.length + deps.transferPartners.length, kept: a.movements.length - toDelete.length };
}
