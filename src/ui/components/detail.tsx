// Panneau « Détail » commun à tous les chiffres : définition, composition, sources.

import { createContext, useContext, useState, type ReactNode } from 'react';
import { formatDateFr } from '../../domain/dates';
import { formatMoney } from '../../domain/money';
import type { Snapshot } from '../../domain/types';
import type { Figure, SourceRef } from '../../engine/figure';

interface DetailCtx {
  show: (f: Figure) => void;
}
const Ctx = createContext<DetailCtx>({ show: () => undefined });
export const useDetail = () => useContext(Ctx);

function sourceLabel(s: SourceRef, snap: Snapshot): string {
  switch (s.kind) {
    case 'movement': {
      const m = snap.movements.find((x) => x.id === s.id);
      if (!m) return `Opération n° ${s.id}`;
      const what = m.granularity === 'total' ? `Total ${m.period_month}` : `${formatDateFr(m.op_date!)} — ${m.label_simple || m.label_original || 'opération'}`;
      return `${what} : ${formatMoney(m.amount_minor, m.currency)}`;
    }
    case 'balance_reference': {
      const b = snap.balanceRefs.find((x) => x.id === s.id);
      return b ? `Solde de référence du ${formatDateFr(b.ref_date)} : ${formatMoney(b.amount_minor, snap.accounts.find((a) => a.id === b.account_id)?.currency ?? 'EUR')}` : 'Solde de référence';
    }
    case 'occurrence':
      return `${snap.recurrences.find((r) => r.id === s.recurrence_id)?.label ?? 'Récurrence'} — ${formatDateFr(s.date)}`;
    case 'echeance':
      return snap.scheduled.find((x) => x.id === s.id)?.label ?? 'Échéance';
    case 'credit':
      return `${snap.loans.find((l) => l.id === s.loan_id)?.label ?? 'Crédit'} — échéance ${s.seq}`;
    case 'transfer': {
      const legs = snap.movements.filter((m) => m.transfer_id === s.id && m.transfer_role !== 'frais');
      return `Transfert : ${legs.map((m) => formatMoney(m.amount_minor, m.currency)).join(' / ')}`;
    }
    case 'account':
      return `Compte « ${snap.accounts.find((a) => a.id === s.id)?.name ?? s.id} »`;
    case 'budget':
      return `Budget ${s.month}`;
    case 'fund':
      return snap.funds.find((f) => f.id === s.id)?.name ?? 'Fonds';
    case 'asset':
      return snap.assets.find((a) => a.id === s.id)?.name ?? 'Bien';
  }
}

function Node({ f, snap, depth }: { f: Figure; snap: Snapshot; depth: number }) {
  const [open, setOpen] = useState(depth < 1);
  const has = f.components.length > 0 || f.sources.length > 0;
  return (
    <li>
      <div className="detail-line">
        <button type="button" className="link-btn" onClick={() => has && setOpen(!open)} aria-expanded={has ? open : undefined}>
          {has ? (open ? '▾ ' : '▸ ') : ''}
          {f.label}
        </button>
        <span className={`num ${f.value !== null && f.value < 0 ? 'neg' : ''}`} title={f.missingReason}>
          {f.value === null ? '—' : formatMoney(f.value, f.currency)}
        </span>
      </div>
      {f.notes.filter((n) => n !== 'non-additif').length > 0 && <div className="detail-notes">{f.notes.filter((n) => n !== 'non-additif').join(' · ')}</div>}
      {f.value === null && f.missingReason && <div className="detail-notes alert">{f.missingReason}</div>}
      {open && has && (
        <ul>
          {f.components.map((c, i) => (
            <Node key={`${c.key}.${i}`} f={c} snap={snap} depth={depth + 1} />
          ))}
          {f.sources.map((s, i) => (
            <li key={`s${i}`} className="detail-source">{sourceLabel(s, snap)}</li>
          ))}
        </ul>
      )}
    </li>
  );
}

export function DetailProvider({ snap, children }: { snap: Snapshot; children: ReactNode }) {
  const [f, setF] = useState<Figure | null>(null);
  return (
    <Ctx.Provider value={{ show: setF }}>
      {children}
      {f && (
        <aside className="detail-panel" aria-label={`Détail : ${f.label}`}>
          <div className="modal-head">
            <h2>{f.label}</h2>
            <button type="button" className="icon" aria-label="Fermer le détail" onClick={() => setF(null)}>×</button>
          </div>
          <div className="detail-value num">{f.value === null ? '—' : formatMoney(f.value, f.currency)}</div>
          <p className="detail-def">{f.definition}</p>
          {f.value === null && <p className="alert">{f.missingReason}</p>}
          <ul className="detail-tree">
            {f.components.map((c, i) => (
              <Node key={`${c.key}.${i}`} f={c} snap={snap} depth={0} />
            ))}
            {f.sources.map((s, i) => (
              <li key={`s${i}`} className="detail-source">{sourceLabel(s, snap)}</li>
            ))}
          </ul>
          {f.notes.filter((n) => n !== 'non-additif').length > 0 && <p className="detail-notes">{f.notes.filter((n) => n !== 'non-additif').join(' · ')}</p>}
        </aside>
      )}
    </Ctx.Provider>
  );
}
