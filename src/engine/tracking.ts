// Suivi mensuel : Prévu / Réel / Reste attendu / Écart par rubrique, puis par famille.
// Règle unique budget + échéances : docs/ARCHITECTURE.md § 5.3 et docs/REGLES_DE_CALCUL.md.

import { addMonths, daysInMonth, firstDay, formatDateFr, lastDay } from '../domain/dates';
import type { Currency, Direction, Month } from '../domain/types';
import { familyOf, monthState, toBase, type Ctx, type MonthState } from './context';
import { fig, sumFig, type Figure } from './figure';
import { expectedBetween, type Expected } from './occurrences';
import { realLines, type Line, type RealLines } from './lines';

export interface BudgetRef {
  initial: number;
  actualise: number | null;
  /** Valeur de référence : actualisé s'il existe, sinon initial. */
  reference: number;
  referenceLabel: string;
  currency: Currency;
  source: 'mois' | 'plan';
}

export function budgetFor(ctx: Ctx, rubriqueId: number, m: Month): BudgetRef | null {
  const bm = ctx.snap.budgetMonths.find((b) => b.rubrique_id === rubriqueId && b.period_month === m);
  if (bm) {
    return {
      initial: bm.initial_minor,
      actualise: bm.actualise_minor,
      reference: bm.actualise_minor ?? bm.initial_minor,
      referenceLabel: bm.actualise_minor !== null ? 'budget actualisé' : 'budget initial',
      currency: bm.currency,
      source: 'mois',
    };
  }
  const plan = ctx.snap.budgetPlans.find((p) => p.rubrique_id === rubriqueId && p.valid_from_month <= m && (p.valid_to_month === null || p.valid_to_month >= m));
  if (!plan) return null;
  return { initial: plan.monthly_minor, actualise: null, reference: plan.monthly_minor, referenceLabel: 'budget initial (plan)', currency: plan.currency, source: 'plan' };
}

export interface RubriqueTracking {
  rubrique_id: number;
  family_id: number;
  direction: Direction;
  month: Month;
  state: MonthState;
  budget: BudgetRef | null;
  /** Échéances du mois (identifiées). */
  expected: Expected[];
  /** Échéances de mois antérieurs non soldées, reportées dans le reste attendu du mois en cours. */
  late: Expected[];
  prevu: Figure;
  reel: Figure;
  reste: Figure;
  ecart: Figure;
  /** Le budget est inférieur aux échéances identifiées. */
  budgetBelowExpected: boolean;
  estimation: string;
  /** Aucune donnée pertinente (ni budget, ni échéance, ni réel) : masquable. */
  unused: boolean;
}

const sign = (direction: Direction) => (direction === 'depense' ? -1 : 1);

/** Montant orienté : positif = dépense pour une rubrique de dépense, recette pour une rubrique de revenu. */
function oriented(direction: Direction, minor: number): number {
  return sign(direction) * minor;
}

function convExpected(ctx: Ctx, e: Expected, amountAbs: number, cur: Currency): number | null {
  return toBase(ctx, amountAbs, e.currency, e.due_date <= ctx.today ? e.due_date : ctx.today, cur).minor;
}

function avgCompleteMonths(ctx: Ctx, rubriqueId: number, direction: Direction, m: Month, n: number, real: RealLines, cur: Currency): { avg: number; months: number } | null {
  const months: number[] = [];
  for (let k = 1; k <= 36 && months.length < n; k++) {
    const mm = addMonths(m, -k);
    if (!ctx.closedMonths.has(mm)) continue;
    const v = rnr(ctx, real.lines.filter((l) => l.rubrique_id === rubriqueId && l.month === mm), direction, cur);
    if (v.rnr !== null) months.push(v.rnr);
  }
  if (months.length === 0) return null;
  return { avg: Math.round(months.reduce((a, b) => a + b, 0) / months.length), months: months.length };
}

/** Réel, part rapprochée et part non rapprochée d'un ensemble de lignes. */
function rnr(ctx: Ctx, lines: Line[], direction: Direction, cur: Currency): { r: number | null; rapproche: number; rnr: number | null } {
  let r = 0;
  let rap = 0;
  for (const l of lines) {
    const conv = l.currency === cur ? l.amount_minor : l.base_minor === null ? null : cur === ctx.base ? l.base_minor : toBase(ctx, l.amount_minor, l.currency, l.date ?? ctx.today, cur).minor;
    if (conv === null) return { r: null, rapproche: 0, rnr: null };
    r += oriented(direction, conv);
    if (l.movement_id) {
      const alloc = ctx.snap.reconciliations.filter((x) => x.movement_id === l.movement_id).reduce((s, x) => s + Math.abs(x.allocated_minor), 0);
      if (alloc > 0) {
        const capped = Math.min(alloc, Math.abs(l.amount_minor));
        const c = l.currency === cur ? capped : toBase(ctx, capped, l.currency, l.date ?? ctx.today, cur).minor ?? 0;
        rap += c;
      }
    }
  }
  return { r, rapproche: rap, rnr: r - rap };
}

export function trackRubrique(ctx: Ctx, rubriqueId: number, m: Month, real: RealLines = realLines(ctx), expectedAll?: Expected[]): RubriqueTracking {
  const r = ctx.rubrique.get(rubriqueId)!;
  const fam = familyOf(ctx, rubriqueId);
  const direction = fam.direction;
  const state = monthState(ctx, m);
  const budget = budgetFor(ctx, rubriqueId, m);
  // Le suivi est toujours exprimé en devise de consolidation ; un budget en CHF est converti
  // au taux du dernier jour du mois (ou d'aujourd'hui pour le mois en cours / futur).
  const cur = ctx.base;
  const from = firstDay(m);
  const to = lastDay(m);
  const all = expectedAll ?? expectedBetween(ctx, firstDay(addMonths(m, -12)), to);
  const expected = all.filter((e) => e.rubrique_id === rubriqueId && e.due_date >= from && e.due_date <= to);
  const late = state === 'en_cours' ? all.filter((e) => e.rubrique_id === rubriqueId && e.due_date < from && e.status !== 'soldee') : [];
  const lines = real.lines.filter((l) => l.rubrique_id === rubriqueId && l.month === m);
  const conflict = real.conflicts.some((c) => c.rubrique_id === rubriqueId && c.month === m);

  // E et U
  const eFigs: Figure[] = [];
  const uFigs: Figure[] = [];
  let eMissing = false;
  for (const e of expected) {
    const amt = convExpected(ctx, e, oriented(direction, e.amount_minor), cur);
    if (amt === null) eMissing = true;
    eFigs.push(fig(`ech.${e.key}`, `${e.label} (${formatDateFr(e.due_date)})`, 'Échéance identifiée', amt, cur, { sources: [srcOf(e)], missingReason: 'taux manquant' }));
    if (e.status !== 'soldee') {
      uFigs.push(fig(`reste.${e.key}`, `${e.label} — non soldée`, 'Montant attendu moins montant déjà affecté', convExpected(ctx, e, e.remaining * Math.sign(oriented(direction, e.amount_minor) || 1), cur), cur, { sources: [srcOf(e)] }));
    }
  }
  for (const e of late) {
    uFigs.push(fig(`retard.${e.key}`, `${e.label} — en retard (échéance du ${formatDateFr(e.due_date)})`, 'Échéance d’un mois antérieur non soldée, reportée dans le reste attendu', convExpected(ctx, e, e.remaining * Math.sign(oriented(direction, e.amount_minor) || 1), cur), cur, { sources: [srcOf(e)] }));
  }
  const E = eMissing ? null : eFigs.reduce((s, f) => s + (f.value ?? 0), 0);
  const B = budget === null ? null : toBase(ctx, budget.reference, budget.currency, lastDay(m) < ctx.today ? lastDay(m) : ctx.today, cur).minor;
  const L = B !== null && E !== null ? Math.max(0, B - E) : 0;
  const budgetBelowExpected = B !== null && E !== null && B < E;

  const prevuNotes: string[] = [];
  if (budgetBelowExpected) prevuNotes.push(`Budget ${B} inférieur aux échéances identifiées ${E} : prévu retenu = échéances`);
  const prevu = sumFig('prevu', 'Prévu', 'Échéances identifiées du mois + enveloppe libre (budget − échéances, au moins 0)', cur, [
    sumFig('prevu.echeances', 'Échéances identifiées', 'Occurrences des récurrences, échéances ponctuelles et de crédit du mois', cur, eFigs),
    fig('prevu.enveloppe', 'Enveloppe libre', budget ? `max(0, ${budget.referenceLabel} − échéances identifiées)` : 'Aucun budget : pas d’enveloppe', E === null ? null : L, cur),
  ], { notes: prevuNotes });

  // Réel
  const v = conflict ? { r: null, rapproche: 0, rnr: null } : rnr(ctx, lines, direction, cur);
  const reel = fig('reel', 'Réel', 'Somme des opérations et totaux retenus du mois (règle de couverture appliquée)', v.r, cur, {
    components: lines.map((l) => fig(`reel.${l.key}`, l.label, 'Ligne du réel', l.base_minor === null ? null : oriented(direction, l.currency === cur ? l.amount_minor : l.base_minor), cur, { sources: l.movement_id ? [{ kind: 'movement', id: l.movement_id }] : [] })),
    missingReason: conflict ? 'conflit total / détail à résoudre' : 'taux EUR/CHF manquant',
  });

  // Reste attendu
  let estimation = 'budget';
  let libre: number | null = null;
  const rnrV = v.rnr;
  if (state === 'ecoule' || state === 'cloture') {
    libre = 0;
    estimation = 'mois écoulé : aucun reste attendu';
  } else if (rnrV === null || E === null) {
    libre = null;
  } else if (state === 'en_cours' && r.estimation_method === 'prorata') {
    const [y, mo] = m.split('-').map(Number) as [number, number];
    const dim = daysInMonth(y, mo);
    const elapsed = Number(ctx.today.slice(8, 10));
    const est = Math.round((rnrV * dim) / elapsed);
    libre = Math.max(0, est - rnrV);
    estimation = `prorata : ${elapsed} jour(s) écoulé(s) sur ${dim}`;
  } else if (r.estimation_method === 'moyenne') {
    const a = avgCompleteMonths(ctx, rubriqueId, direction, m, r.estimation_n, real, cur);
    if (a) {
      libre = Math.max(0, a.avg - rnrV);
      estimation = `moyenne des dépenses non rapprochées sur ${a.months} mois complet(s)`;
    } else {
      libre = Math.max(0, L - rnrV);
      estimation = 'moyenne indisponible (aucun mois complet) : budget utilisé';
    }
  } else {
    libre = Math.max(0, L - rnrV);
    estimation = budget ? `budget : max(0, enveloppe libre − réel non rapproché)` : 'aucun budget : seules les échéances sont attendues';
  }
  const resteComps: Figure[] =
    state === 'ecoule' || state === 'cloture'
      ? []
      : [fig('reste.libre', 'Reste de l’enveloppe libre', estimation, libre, cur), ...uFigs];
  const reste = state === 'ecoule' || state === 'cloture'
    ? fig('reste', 'Reste attendu', 'Mois écoulé : aucun reste attendu (les échéances non soldées passent « en retard »)', 0, cur)
    : sumFig('reste', 'Reste attendu', 'max(0, enveloppe libre − réel non rapproché) + échéances non soldées', cur, resteComps);

  // Écart
  let ecart: Figure;
  if (B === null) ecart = fig('ecart', 'Écart', 'Pas de budget pour cette rubrique et ce mois', null, cur, { missingReason: 'aucun budget' });
  else if (v.r === null || reste.value === null) ecart = fig('ecart', 'Écart', 'Réel indisponible', null, cur, { missingReason: reel.missingReason ?? reste.missingReason });
  else if (state === 'ecoule' || state === 'cloture') {
    ecart = fig('ecart', 'Écart', `Réel − ${budget!.referenceLabel}`, v.r - B, cur, { notes: state === 'ecoule' ? ['provisoire : mois non clôturé'] : [] });
  } else {
    ecart = fig('ecart', 'Écart projeté', `Réel + reste attendu − ${budget!.referenceLabel}`, v.r + reste.value - B, cur);
  }

  return {
    rubrique_id: rubriqueId,
    family_id: fam.id,
    direction,
    month: m,
    state,
    budget,
    expected,
    late,
    prevu,
    reel,
    reste,
    ecart,
    budgetBelowExpected,
    estimation,
    unused: !budget && expected.length === 0 && late.length === 0 && lines.length === 0,
  };
}

function srcOf(e: Expected): import('./figure').SourceRef {
  if (e.kind === 'occurrence') return { kind: 'occurrence', recurrence_id: e.recurrence_id!, date: e.nominal_date };
  if (e.kind === 'echeance') return { kind: 'echeance', id: e.scheduled_item_id! };
  return { kind: 'credit', loan_id: e.loan_id!, seq: e.seq! };
}

export interface FamilyTracking {
  family_id: number;
  name: string;
  direction: Direction;
  rubriques: RubriqueTracking[];
  prevu: Figure;
  reel: Figure;
  reste: Figure;
  ecart: Figure;
}

export interface MonthTracking {
  month: Month;
  state: MonthState;
  families: FamilyTracking[];
  conflicts: RealLines['conflicts'];
}

/** Suivi d'un mois, pour toutes les rubriques de revenus et de dépenses. */
export function monthTracking(ctx: Ctx, m: Month, real: RealLines = realLines(ctx)): MonthTracking {
  const expectedAll = expectedBetween(ctx, firstDay(addMonths(m, -12)), lastDay(m));
  const fams: FamilyTracking[] = [];
  for (const f of [...ctx.snap.families].sort((a, b) => a.sort_order - b.sort_order)) {
    if (f.direction === 'technique') continue;
    const rubs = ctx.snap.rubriques.filter((r) => r.family_id === f.id).map((r) => trackRubrique(ctx, r.id, m, real, expectedAll));
    const sum = (k: 'prevu' | 'reel' | 'reste', label: string) =>
      sumFig(`fam.${f.id}.${k}`, label, `Somme des rubriques de « ${f.name} »`, ctx.base, rubs.map((r) => ({ ...r[k], label: ctx.rubrique.get(r.rubrique_id)!.name })));
    const withBudget = rubs.filter((r) => r.ecart.value !== null);
    const ecart = withBudget.length
      ? sumFig(`fam.${f.id}.ecart`, 'Écart', `Somme des écarts des rubriques budgétées de « ${f.name} »`, ctx.base, withBudget.map((r) => ({ ...r.ecart, label: ctx.rubrique.get(r.rubrique_id)!.name })))
      : fig(`fam.${f.id}.ecart`, 'Écart', 'Aucune rubrique budgétée', null, ctx.base, { missingReason: 'aucun budget' });
    fams.push({ family_id: f.id, name: f.name, direction: f.direction, rubriques: rubs, prevu: sum('prevu', 'Prévu'), reel: sum('reel', 'Réel'), reste: sum('reste', 'Reste attendu'), ecart });
  }
  return { month: m, state: monthState(ctx, m), families: fams, conflicts: real.conflicts.filter((c) => c.month === m) };
}
