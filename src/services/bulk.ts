// Actions groupées sur les opérations : reclassement, commentaire commun. Aucune modification
// groupée des montants, dates, signes, natures ou devises. Chaque correction est tracée.

import type { Snapshot } from '../domain/types';
import type { Driver } from '../storage/driver';
import { checkNature, COVERAGE_LABEL, CoverageRequired } from './movements';
import { Plan, fail, type FieldError } from './plan';
import type { CoverageMode } from '../domain/types';
import { formatMonthFr } from '../domain/dates';

export interface ReclassifyPreview {
  rubriqueName: string;
  compatible: number[];
  incompatible: { id: number; reason: string }[];
}

export function previewReclassify(snap: Snapshot, ids: number[], rubriqueId: number): ReclassifyPreview {
  const r = snap.rubriques.find((x) => x.id === rubriqueId);
  if (!r) fail('rubrique_id', 'Rubrique introuvable');
  const out: ReclassifyPreview = { rubriqueName: r.name, compatible: [], incompatible: [] };
  for (const id of ids) {
    const m = snap.movements.find((x) => x.id === id);
    if (!m) continue;
    const errs: FieldError[] = [];
    checkNature(snap, rubriqueId, m.nature, errs);
    const label = m.label_simple || m.label_original || `opération n° ${m.id}`;
    if (m.transfer_id) out.incompatible.push({ id, reason: `« ${label} » fait partie d’un transfert : sa rubrique est fixe.` });
    else if (errs.length) out.incompatible.push({ id, reason: `« ${label} » : ${errs[0]!.message}. Modifiez sa nature individuellement si nécessaire.` });
    else if (snap.reconciliations.some((x) => x.movement_id === id)) out.incompatible.push({ id, reason: `« ${label} » est rapprochée d’une échéance de sa rubrique : annulez d’abord le rapprochement.` });
    else if (m.rubrique_id !== rubriqueId) out.compatible.push(id);
  }
  return out;
}

/** Reclasse des opérations ; les nouvelles coexistences total / détail exigent une décision explicite. */
export async function reclassify(driver: Driver, snap: Snapshot, ids: number[], rubriqueId: number, opts: { coverage?: Record<string, CoverageMode> } = {}): Promise<{ changed: number }> {
  const pv = previewReclassify(snap, ids, rubriqueId);
  if (pv.incompatible.some((x) => ids.includes(x.id))) fail('ids', pv.incompatible.map((x) => x.reason).join(' '));
  const p = new Plan();
  const months = new Set<string>();
  for (const id of pv.compatible) {
    const m = snap.movements.find((x) => x.id === id)!;
    months.add(m.period_month);
    p.update('movement', id, m as unknown as Record<string, unknown>, { rubrique_id: rubriqueId, classification: 'confirme', updated_at: p.ts }, `Reclassement groupé vers « ${pv.rubriqueName} »`);
  }
  for (const month of months) {
    const totals = snap.movements.filter((m) => m.granularity === 'total' && m.rubrique_id === rubriqueId && m.period_month === month).length;
    const decided = snap.coverage.some((d) => d.rubrique_id === rubriqueId && d.period_month === month);
    if (totals && !decided) {
      const mode = opts.coverage?.[month];
      if (!mode) throw new CoverageRequired(rubriqueId, month, pv.compatible.length, totals, pv.rubriqueName);
      p.insert('coverage_decision', { rubrique_id: rubriqueId, period_month: month, mode, decided_at: p.ts }, `Couverture ${formatMonthFr(month)} : ${COVERAGE_LABEL[mode]}`);
    }
  }
  if (!p.isEmpty) await p.run(driver);
  return { changed: pv.compatible.length };
}

export async function setComment(driver: Driver, snap: Snapshot, ids: number[], comment: string): Promise<{ changed: number }> {
  const p = new Plan();
  let n = 0;
  for (const id of ids) {
    const m = snap.movements.find((x) => x.id === id);
    if (!m || m.comment === comment) continue;
    p.update('movement', id, m as unknown as Record<string, unknown>, { comment, updated_at: p.ts }, 'Commentaire commun');
    n++;
  }
  if (n) await p.run(driver);
  return { changed: n };
}
