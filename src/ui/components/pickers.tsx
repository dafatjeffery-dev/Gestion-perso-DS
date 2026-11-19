import type { Snapshot } from '../../domain/types';

/** Sélecteur de rubrique groupé par famille. Les rubriques indisponibles ne sont proposées que si déjà choisies. */
export function RubriqueSelect({ snap, value, onChange, includeTechnical, ariaLabel, allowAll }: { snap: Snapshot; value: number | null; onChange: (id: number | null) => void; includeTechnical?: boolean; ariaLabel?: string; allowAll?: string }) {
  const fams = [...snap.families].sort((a, b) => a.sort_order - b.sort_order).filter((f) => includeTechnical || f.direction !== 'technique');
  return (
    <select aria-label={ariaLabel ?? 'Rubrique'} value={value ?? ''} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}>
      <option value="">{allowAll ?? '— choisir —'}</option>
      {fams.map((f) => (
        <optgroup key={f.id} label={`${f.name}${f.direction === 'revenu' ? ' (revenus)' : ''}`}>
          {snap.rubriques
            .filter((r) => r.family_id === f.id && (r.available_for_entry || r.id === value || allowAll))
            .map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
                {!r.available_for_entry ? ' (indisponible pour de nouvelles saisies)' : ''}
              </option>
            ))}
        </optgroup>
      ))}
    </select>
  );
}

export function AccountSelect({ snap, value, onChange, includeArchived, ariaLabel, allowAll, currency }: { snap: Snapshot; value: number | null; onChange: (id: number | null) => void; includeArchived?: boolean; ariaLabel?: string; allowAll?: string; currency?: string }) {
  return (
    <select aria-label={ariaLabel ?? 'Compte'} value={value ?? ''} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}>
      <option value="">{allowAll ?? '— choisir —'}</option>
      {snap.accounts
        .filter((a) => (includeArchived || a.status === 'actif' || a.id === value) && (!currency || a.currency === currency))
        .map((a) => (
          <option key={a.id} value={a.id}>
            {a.name} ({a.currency}){a.status === 'archive' ? ' — archivé' : ''}
          </option>
        ))}
    </select>
  );
}
