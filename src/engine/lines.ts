// Lignes d'analyse du réel : mouvements retenus après la règle de couverture
// synthétique/détaillé, + lignes dérivées (écart de change des transferts).

import { formatMonthFr, lastDay } from '../domain/dates';
import type { CoverageMode, Currency, IsoDate, Month, Movement, NatureCode } from '../domain/types';
import { sysRubrique, toBase, type Ctx } from './context';
import type { RateLookup } from './fx';

export type FlowCategory =
  | 'revenu_structurel'
  | 'revenu_exceptionnel'
  | 'consommation'
  | 'a_classer'
  | 'capital'
  | 'emprunt'
  | 'epargne'
  | 'transfert';

export const NATURE_CATEGORY: Record<NatureCode, FlowCategory> = {
  revenu_ordinaire: 'revenu_structurel',
  revenu_exceptionnel: 'revenu_exceptionnel',
  depense: 'consommation',
  remboursement_depense: 'consommation',
  cout_credit: 'consommation',
  frais_transfert: 'consommation',
  a_classer: 'a_classer',
  capital_credit: 'capital',
  emprunt_recu: 'emprunt',
  epargne: 'epargne',
  transfert: 'transfert',
};

export interface Line {
  key: string;
  origin: 'operation' | 'total' | 'derive';
  movement_id: number | null;
  transfer_id: number | null;
  date: IsoDate | null;
  month: Month;
  account_id: number | null;
  rubrique_id: number;
  nature: NatureCode;
  category: FlowCategory;
  amount_minor: number;
  currency: Currency;
  /** Montant en devise de consolidation ; null si taux manquant. */
  base_minor: number | null;
  rate: RateLookup | null;
  label: string;
  /** Rôle vis-à-vis de la règle de couverture. */
  coverage: 'seul' | CoverageMode;
}

export interface ExcludedLine {
  movement: Movement;
  reason: string;
}

export interface Conflict {
  rubrique_id: number;
  month: Month;
  operations: number;
  totals: number;
}

export interface RealLines {
  lines: Line[];
  excluded: ExcludedLine[];
  conflicts: Conflict[];
}

/** Date de conversion d'un total mensuel : dernier jour du mois, ou aujourd'hui pour le mois en cours. */
export function totalRateDate(ctx: Ctx, m: Month): IsoDate {
  const ld = lastDay(m);
  return ld > ctx.today ? ctx.today : ld;
}

function lineOf(ctx: Ctx, m: Movement, coverage: Line['coverage']): Line {
  const date = m.granularity === 'operation' ? m.op_date! : null;
  const conv = toBase(ctx, m.amount_minor, m.currency, date ?? totalRateDate(ctx, m.period_month));
  return {
    key: `mvt:${m.id}`,
    origin: m.granularity,
    movement_id: m.id,
    transfer_id: m.transfer_id,
    date,
    month: m.period_month,
    account_id: m.account_id,
    rubrique_id: m.rubrique_id,
    nature: m.nature,
    category: NATURE_CATEGORY[m.nature],
    amount_minor: m.amount_minor,
    currency: m.currency,
    base_minor: conv.minor,
    rate: conv.rate,
    label: m.label_simple || m.label_original || (m.granularity === 'total' ? `Total ${formatMonthFr(m.period_month)}` : 'Opération'),
    coverage,
  };
}

/**
 * Applique la règle de couverture : pour une rubrique et un mois où coexistent opérations et
 * total, la décision enregistrée s'applique ; sans décision, rien n'est additionné et un conflit
 * est signalé (docs/ARCHITECTURE.md § 5.1).
 */
export function realLines(ctx: Ctx): RealLines {
  const groups = new Map<string, { ops: Movement[]; totals: Movement[] }>();
  for (const m of ctx.snap.movements) {
    const k = `${m.rubrique_id}|${m.period_month}`;
    let g = groups.get(k);
    if (!g) groups.set(k, (g = { ops: [], totals: [] }));
    (m.granularity === 'operation' ? g.ops : g.totals).push(m);
  }
  const decisions = new Map(ctx.snap.coverage.map((d) => [`${d.rubrique_id}|${d.period_month}`, d.mode]));
  const out: RealLines = { lines: [], excluded: [], conflicts: [] };
  for (const [k, g] of groups) {
    if (g.ops.length === 0 || g.totals.length === 0) {
      for (const m of [...g.ops, ...g.totals]) out.lines.push(lineOf(ctx, m, 'seul'));
      continue;
    }
    const mode = decisions.get(k);
    const [rid, month] = k.split('|') as [string, Month];
    if (!mode) {
      out.conflicts.push({ rubrique_id: Number(rid), month, operations: g.ops.length, totals: g.totals.length });
      for (const m of [...g.ops, ...g.totals]) out.excluded.push({ movement: m, reason: 'conflit total / détail non résolu' });
      continue;
    }
    if (mode === 'total_remplace') {
      for (const m of g.totals) out.lines.push(lineOf(ctx, m, mode));
      for (const m of g.ops) out.excluded.push({ movement: m, reason: 'remplacée par le total du mois (reste dans le solde du compte)' });
    } else if (mode === 'detail_remplace') {
      for (const m of g.ops) out.lines.push(lineOf(ctx, m, mode));
      for (const m of g.totals) out.excluded.push({ movement: m, reason: 'total remplacé par le détail des opérations' });
    } else {
      for (const m of [...g.ops, ...g.totals]) out.lines.push(lineOf(ctx, m, mode));
    }
  }
  out.lines.push(...fxDiffLines(ctx));
  out.lines.sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : (a.date ?? '') < (b.date ?? '') ? -1 : 1));
  return out;
}

/**
 * Écart de change d'un transfert = somme en devise de consolidation de ses deux jambes.
 * C'est une ligne dérivée (non stockée), rattachée au transfert, rubrique « Écart de change ».
 */
export function fxDiffLines(ctx: Ctx): Line[] {
  const rub = sysRubrique(ctx, 'SYS.FRAIS.ECART_CHANGE');
  const byTransfer = new Map<number, { out?: Movement; in?: Movement }>();
  for (const m of ctx.snap.movements) {
    if (!m.transfer_id || m.transfer_role === 'frais') continue;
    const t = byTransfer.get(m.transfer_id) ?? {};
    if (m.transfer_role === 'sortie') t.out = m;
    else t.in = m;
    byTransfer.set(m.transfer_id, t);
  }
  const out: Line[] = [];
  for (const [tid, t] of byTransfer) {
    if (!t.out || !t.in) continue;
    const a = toBase(ctx, t.out.amount_minor, t.out.currency, t.out.op_date!);
    const b = toBase(ctx, t.in.amount_minor, t.in.currency, t.in.op_date!);
    const diff = a.minor === null || b.minor === null ? null : a.minor + b.minor;
    if (diff === 0) continue;
    const date = t.in.op_date! > t.out.op_date! ? t.in.op_date! : t.out.op_date!;
    out.push({
      key: `fx:${tid}`,
      origin: 'derive',
      movement_id: null,
      transfer_id: tid,
      date,
      month: date.slice(0, 7),
      account_id: null,
      rubrique_id: rub.id,
      nature: 'frais_transfert',
      category: 'consommation',
      amount_minor: diff ?? 0,
      currency: ctx.base,
      base_minor: diff,
      rate: b.rate ?? a.rate,
      label: t.out.currency === t.in.currency ? 'Écart entre les deux montants du transfert' : `Écart de change ${t.out.currency} → ${t.in.currency}`,
      coverage: 'seul',
    });
  }
  return out;
}
