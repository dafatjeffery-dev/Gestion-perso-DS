// Analyse d'une période : familles → rubriques → lignes, entrées/sorties, répartition.
// Les mêmes lignes alimentent le suivi, les familles, les rubriques et les graphiques.

import { formatMonthFr } from '../domain/dates';
import type { Direction, Month, Owner } from '../domain/types';
import { familyOf, type Ctx } from './context';
import { fig, sumFig, type Figure } from './figure';
import { realLines, type FlowCategory, type Line, type RealLines } from './lines';

export type Scope = { kind: 'foyer' } | { kind: 'compte'; account_id: number } | { kind: 'personne'; owner: Owner };

export interface Period {
  from: Month;
  to: Month;
}

export interface ScopeInfo {
  scope: Scope;
  label: string;
  /** Les budgets sont familiaux : comparables seulement sur le périmètre foyer. */
  budgetComparable: boolean;
  /** Ce qui est exclu du périmètre et pourquoi. */
  exclusions: string[];
}

export function scopeInfo(ctx: Ctx, scope: Scope): ScopeInfo {
  if (scope.kind === 'foyer') return { scope, label: 'Foyer', budgetComparable: true, exclusions: [] };
  const exclusions = [
    'totaux synthétiques (non rattachés à un compte)',
    'écarts de change des transferts (calculés au niveau du foyer)',
    'budgets (familiaux : affichés à part, non comparables)',
  ];
  if (scope.kind === 'compte') {
    const a = ctx.account.get(scope.account_id);
    return { scope, label: `Compte « ${a?.name ?? '?'} »`, budgetComparable: false, exclusions };
  }
  const p = ctx.snap.persons.find((x) => x.role === scope.owner);
  return { scope, label: scope.owner === 'commun' ? 'Comptes communs' : `Comptes de ${p?.display_name ?? scope.owner}`, budgetComparable: false, exclusions };
}

export function inScope(ctx: Ctx, l: Line, scope: Scope): boolean {
  if (scope.kind === 'foyer') return true;
  if (l.account_id === null) return false;
  if (scope.kind === 'compte') return l.account_id === scope.account_id;
  return ctx.account.get(l.account_id)?.owner === scope.owner;
}

export function periodLines(ctx: Ctx, period: Period, scope: Scope, real: RealLines = realLines(ctx)): Line[] {
  return real.lines.filter((l) => l.month >= period.from && l.month <= period.to && inScope(ctx, l, scope));
}

export const periodLabel = (p: Period) => (p.from === p.to ? formatMonthFr(p.from) : `${formatMonthFr(p.from)} – ${formatMonthFr(p.to)}`);

function lineFigure(ctx: Ctx, l: Line): Figure {
  const notes: string[] = [];
  if (l.origin === 'total') notes.push(l.coverage === 'complement' ? 'complément non détaillé' : 'total mensuel (sans compte)');
  if (l.origin === 'derive') notes.push('ligne calculée, rattachée au transfert');
  if (l.rate) notes.push(`taux du ${l.rate.rate_date}`);
  return fig(`ligne.${l.key}`, l.label, 'Montant de la ligne en devise de consolidation', l.base_minor, ctx.base, {
    sources: l.movement_id ? [{ kind: 'movement', id: l.movement_id }] : l.transfer_id ? [{ kind: 'transfer', id: l.transfer_id }] : [],
    notes,
    missingReason: 'taux EUR/CHF manquant',
  });
}

export interface FamilyNode {
  family_id: number;
  name: string;
  direction: Direction;
  figure: Figure;
  rubriques: { rubrique_id: number; name: string; figure: Figure }[];
}

/**
 * Arbre familles → rubriques → lignes (montants signés, devise de consolidation).
 * Chaque sous-total est la somme exacte de son détail.
 */
export function familyTree(ctx: Ctx, lines: Line[], filter: (l: Line) => boolean = () => true): FamilyNode[] {
  const byRub = new Map<number, Line[]>();
  for (const l of lines) {
    if (!filter(l)) continue;
    const a = byRub.get(l.rubrique_id);
    if (a) a.push(l);
    else byRub.set(l.rubrique_id, [l]);
  }
  const fams = new Map<number, FamilyNode>();
  for (const [rid, ls] of byRub) {
    const r = ctx.rubrique.get(rid)!;
    const f = familyOf(ctx, rid);
    const figure = sumFig(`rub.${rid}`, r.name, `Somme des lignes de la rubrique « ${r.name} »`, ctx.base, ls.map((l) => lineFigure(ctx, l)), {
      sources: [],
    });
    let node = fams.get(f.id);
    if (!node) fams.set(f.id, (node = { family_id: f.id, name: f.name, direction: f.direction, figure: null as unknown as Figure, rubriques: [] }));
    node.rubriques.push({ rubrique_id: rid, name: r.name, figure });
  }
  const out = [...fams.values()].map((n) => {
    n.rubriques.sort((a, b) => ctx.rubrique.get(a.rubrique_id)!.sort_order - ctx.rubrique.get(b.rubrique_id)!.sort_order);
    n.figure = sumFig(`fam.${n.family_id}`, n.name, `Somme des rubriques de la famille « ${n.name} »`, ctx.base, n.rubriques.map((r) => r.figure));
    return n;
  });
  return out.sort((a, b) => ctx.family.get(a.family_id)!.sort_order - ctx.family.get(b.family_id)!.sort_order);
}

const CATEGORY_LABEL: Record<Exclude<FlowCategory, 'transfert'>, string> = {
  revenu_structurel: 'Revenus structurels',
  revenu_exceptionnel: 'Revenus exceptionnels',
  consommation: 'Dépenses de consommation',
  a_classer: 'À classer',
  capital: 'Capital remboursé',
  emprunt: 'Emprunts reçus',
  epargne: 'Épargne placée',
};
const CATEGORY_DEF: Record<Exclude<FlowCategory, 'transfert'>, string> = {
  revenu_structurel: 'Revenus de nature « revenu ordinaire »',
  revenu_exceptionnel: 'Revenus de nature « revenu exceptionnel »',
  consommation: 'Dépenses courantes, coûts de crédit et frais, nettes des remboursements',
  a_classer: 'Opérations non encore classées',
  capital: 'Part capital des échéances de crédit : sortie de trésorerie, pas une consommation',
  emprunt: 'Fonds empruntés reçus : entrée de trésorerie, pas un revenu',
  epargne: 'Sommes placées hors des comptes suivis',
};

export interface Flows {
  figure: Figure;
  byCategory: Partial<Record<FlowCategory, Figure>>;
  transfersCount: number;
}

/**
 * Entrées et sorties : les transferts internes sont neutres et ne figurent pas dans les
 * catégories ; leurs frais et écarts de change sont dans les dépenses de consommation.
 */
export function flows(ctx: Ctx, lines: Line[]): Flows {
  const byCategory: Partial<Record<FlowCategory, Figure>> = {};
  const transfers = new Set<number>();
  for (const cat of Object.keys(CATEGORY_LABEL) as (keyof typeof CATEGORY_LABEL)[]) {
    const ls = lines.filter((l) => l.category === cat);
    byCategory[cat] = sumFig(`flux.${cat}`, CATEGORY_LABEL[cat], CATEGORY_DEF[cat], ctx.base, ls.map((l) => lineFigure(ctx, l)));
  }
  for (const l of lines) if (l.category === 'transfert' && l.transfer_id) transfers.add(l.transfer_id);
  const figure = sumFig(
    'flux.solde',
    'Solde de trésorerie de la période',
    'Somme des entrées et sorties, hors transferts internes (neutres)',
    ctx.base,
    Object.values(byCategory) as Figure[],
  );
  return { figure, byCategory, transfersCount: transfers.size };
}

export interface DonutSlice {
  family_id: number;
  name: string;
  /** Dépense nette en valeur positive. */
  value: number;
  /** Part en dix-millièmes du dénominateur. */
  share_e4: number;
}

export interface Donut {
  slices: DonutSlice[];
  denominator: Figure;
  /** Familles dont le net est un gain (remboursements > dépenses), présentées à part. */
  netPositive: { family_id: number; name: string; value: number }[];
  missing: boolean;
}

export function expenseDonut(ctx: Ctx, lines: Line[]): Donut {
  const tree = familyTree(ctx, lines, (l) => l.category === 'consommation' || (l.category === 'a_classer' && (l.base_minor ?? 0) < 0));
  const slices: DonutSlice[] = [];
  const netPositive: Donut['netPositive'] = [];
  let missing = false;
  for (const n of tree) {
    if (n.figure.value === null) {
      missing = true;
      continue;
    }
    const v = -n.figure.value;
    if (v > 0) slices.push({ family_id: n.family_id, name: n.name, value: v, share_e4: 0 });
    else if (v < 0) netPositive.push({ family_id: n.family_id, name: n.name, value: -v });
  }
  const total = slices.reduce((s, x) => s + x.value, 0);
  for (const s of slices) s.share_e4 = total ? Math.round((s.value * 10000) / total) : 0;
  slices.sort((a, b) => b.value - a.value);
  const denominator = fig('anneau.denominateur', 'Dépenses nettes des familles en dépense', 'Somme des familles dont la dépense nette est positive ; les familles nettes positives sont présentées à part', missing ? null : total, ctx.base, {
    components: slices.map((s) => fig(`anneau.${s.family_id}`, s.name, 'Dépense nette de la famille', s.value, ctx.base)),
    missingReason: 'taux EUR/CHF manquant',
  });
  return { slices, denominator, netPositive, missing };
}
