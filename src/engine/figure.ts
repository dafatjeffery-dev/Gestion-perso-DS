// Chiffre explicable : valeur + définition + composition + sources (docs/ARCHITECTURE.md § 6.1).

import type { Currency } from '../domain/types';

export type SourceRef =
  | { kind: 'movement'; id: number }
  | { kind: 'balance_reference'; id: number }
  | { kind: 'occurrence'; recurrence_id: number; date: string }
  | { kind: 'echeance'; id: number }
  | { kind: 'credit'; loan_id: number; seq: number }
  | { kind: 'transfer'; id: number }
  | { kind: 'budget'; rubrique_id: number; month: string }
  | { kind: 'fund'; id: number }
  | { kind: 'asset'; id: number }
  | { kind: 'account'; id: number };

export interface Figure {
  key: string;
  label: string;
  definition: string;
  value: number | null;
  currency: Currency;
  missingReason?: string;
  components: Figure[];
  sources: SourceRef[];
  notes: string[];
}

export function fig(
  key: string,
  label: string,
  definition: string,
  value: number | null,
  currency: Currency,
  extra: Partial<Pick<Figure, 'components' | 'sources' | 'notes' | 'missingReason'>> = {},
): Figure {
  return {
    key,
    label,
    definition,
    value,
    currency,
    components: extra.components ?? [],
    sources: extra.sources ?? [],
    notes: extra.notes ?? [],
    ...(value === null ? { missingReason: extra.missingReason ?? 'donnée absente' } : {}),
  };
}

/** Somme exacte de composants. Un composant absent rend la somme absente (jamais zéro). */
export function sumFig(
  key: string,
  label: string,
  definition: string,
  currency: Currency,
  components: Figure[],
  extra: Partial<Pick<Figure, 'sources' | 'notes'>> = {},
): Figure {
  const missing = components.find((c) => c.value === null);
  const value = missing ? null : components.reduce((s, c) => s + (c.value as number), 0);
  return fig(key, label, definition, value, currency, {
    components,
    ...extra,
    ...(missing ? { missingReason: `${missing.label} : ${missing.missingReason ?? 'absent'}` } : {}),
  });
}

/** Vérifie récursivement que chaque chiffre composé est la somme exacte de ses composants. */
export function checkFigureSums(f: Figure, path: string[] = []): string[] {
  const errs: string[] = [];
  const here = [...path, f.label];
  if (f.components.length > 0 && f.value !== null && !f.notes.includes('non-additif')) {
    const s = f.components.reduce((a, c) => a + (c.value ?? 0), 0);
    if (s !== f.value) errs.push(`${here.join(' › ')} : ${f.value} ≠ Σ ${s}`);
  }
  for (const c of f.components) errs.push(...checkFigureSums(c, here));
  return errs;
}

/** Marque un chiffre dont les composants sont une explication et non une somme. */
export function nonAdditive(f: Figure): Figure {
  return { ...f, notes: [...f.notes, 'non-additif'] };
}
