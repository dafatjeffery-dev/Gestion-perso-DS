import type { AccountType, NatureCode, Owner, Snapshot, Frequency } from '../domain/types';

export const ACCOUNT_TYPE: Record<AccountType, string> = { courant: 'Courant', epargne: 'Épargne', investissement: 'Investissement' };
export const FREQUENCY: Record<Frequency, string> = { mensuelle: 'Mensuelle', trimestrielle: 'Trimestrielle', semestrielle: 'Semestrielle', annuelle: 'Annuelle', personnalisee: 'Personnalisée' };

export function ownerLabel(snap: Snapshot, o: Owner): string {
  if (o === 'commun') return 'Commun';
  return snap.persons.find((p) => p.role === o)?.display_name ?? `Personne ${o}`;
}

export function natureLabel(snap: Snapshot, n: NatureCode): string {
  return snap.natures.find((x) => x.code === n)?.label ?? n;
}

export function rubriqueLabel(snap: Snapshot, id: number): string {
  const r = snap.rubriques.find((x) => x.id === id);
  if (!r) return '?';
  const f = snap.families.find((x) => x.id === r.family_id);
  return `${f?.name ?? ''} › ${r.name}`;
}

/** Natures proposées pour une rubrique (selon le sens de sa famille). */
export function naturesFor(snap: Snapshot, rubriqueId: number): NatureCode[] {
  const r = snap.rubriques.find((x) => x.id === rubriqueId);
  const f = r && snap.families.find((x) => x.id === r.family_id);
  if (!f) return [];
  if (f.direction === 'revenu') return ['revenu_ordinaire', 'revenu_exceptionnel'];
  if (f.direction === 'depense') {
    if (r.ref.startsWith('SYS.CREDIT')) return ['cout_credit'];
    if (r.ref.startsWith('SYS.FRAIS')) return ['frais_transfert'];
    return ['depense', 'remboursement_depense'];
  }
  if (r.ref === 'SYS.TECH.EPARGNE') return ['epargne'];
  if (r.ref === 'SYS.TECH.CAPITAL') return ['capital_credit'];
  if (r.ref === 'SYS.TECH.EMPRUNT') return ['emprunt_recu'];
  if (r.ref === 'SYS.TECH.A_CLASSER') return ['a_classer'];
  return ['transfert'];
}

export function defaultNature(snap: Snapshot, rubriqueId: number, amount: number | null): NatureCode {
  const ns = naturesFor(snap, rubriqueId);
  if (ns.includes('remboursement_depense') && amount !== null && amount > 0) return 'remboursement_depense';
  return ns[0] ?? 'a_classer';
}
