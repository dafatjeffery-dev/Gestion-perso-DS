// Briques d'affichage communes : montants (absence ≠ zéro), boîtes de dialogue, champs.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { formatDateFr } from '../../domain/dates';
import { formatMoney, parseAmount } from '../../domain/money';
import type { Currency } from '../../domain/types';
import type { Figure } from '../../engine/figure';
import { useDetail } from './detail';

export function Amount({ value, currency, reason, signed, decimals = true, className }: { value: number | null | undefined; currency: Currency; reason?: string; signed?: boolean; decimals?: boolean; className?: string }) {
  if (value === null || value === undefined) {
    return <span className={`num absent ${className ?? ''}`} title={reason ?? 'donnée absente'}>—</span>;
  }
  return <span className={`num ${value < 0 ? 'neg' : ''} ${className ?? ''}`}>{formatMoney(value, currency, { signed, decimals })}</span>;
}

/** Montant cliquable qui ouvre sa composition dans le panneau « Détail ». */
export function FigureValue({ f, signed, decimals, invert }: { f: Figure; signed?: boolean; decimals?: boolean; invert?: boolean }) {
  const { show } = useDetail();
  return (
    <button
      type="button"
      className="figure-btn"
      onClick={() => show(f)}
      title={`${f.label} — voir le détail`}
      aria-label={`${f.label} : ${f.value === null ? 'absent' : formatMoney(invert ? -f.value : f.value, f.currency)} — voir le détail`}
    >
      <Amount value={f.value === null ? null : invert ? -f.value : f.value} currency={f.currency} reason={f.missingReason} signed={signed} decimals={decimals} />
    </button>
  );
}

export const DateFr = ({ d }: { d: string | null | undefined }) => <span className="nowrap">{d ? formatDateFr(d) : '—'}</span>;

export function Modal({ title, children, onClose, wide }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button type="button" className="icon" aria-label="Fermer" onClick={onClose}>×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Field({ label, error, hint, children }: { label: string; error?: string; hint?: string; children: ReactNode }) {
  return (
    <label className={`field ${error ? 'has-error' : ''}`}>
      <span className="field-label">{label}</span>
      {children}
      {hint && !error && <span className="field-hint">{hint}</span>}
      {error && <span className="field-error">{error}</span>}
    </label>
  );
}

/** Saisie d'un montant au format français ; la valeur est en centimes, ou null si invalide/vide. */
export function MoneyInput({ value, onChange, currency, ariaLabel, allowEmpty }: { value: number | null; onChange: (v: number | null, raw: string) => void; currency: Currency | string; ariaLabel?: string; allowEmpty?: boolean }) {
  const toText = (v: number | null) => (v === null ? '' : (v / 100).toFixed(2).replace('.', ','));
  const [text, setText] = useState(toText(value));
  const [err, setErr] = useState<string | null>(null);
  const last = useRef(value);
  useEffect(() => {
    if (value !== last.current) {
      setText(toText(value));
      last.current = value;
    }
  }, [value]);
  return (
    <span className="money-input">
      <input
        inputMode="decimal"
        aria-label={ariaLabel}
        value={text}
        onChange={(e) => {
          const t = e.target.value;
          setText(t);
          if (t.trim() === '' && allowEmpty) {
            setErr(null);
            last.current = null;
            onChange(null, t);
            return;
          }
          const r = parseAmount(t);
          setErr(r.ok ? null : r.reason);
          last.current = r.ok ? r.value : null;
          onChange(r.ok ? r.value : null, t);
        }}
      />
      <span className="cur">{currency}</span>
      {err && text.trim() !== '' && <span className="field-error">{err}</span>}
    </span>
  );
}

export function Notice({ kind = 'info', children }: { kind?: 'info' | 'warn' | 'error' | 'ok'; children: ReactNode }) {
  return <div className={`notice ${kind}`}>{children}</div>;
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
