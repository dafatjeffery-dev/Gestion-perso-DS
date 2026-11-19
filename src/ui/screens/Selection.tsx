import { useEffect, useMemo, useState } from 'react';
import type { Movement } from '../../domain/types';
import * as bulk from '../../services/bulk';
import * as mv from '../../services/movements';
import { Notice, errorText } from '../components/core';
import { RubriqueSelect } from '../components/pickers';
import { useData } from '../data';

export interface Selection {
  ids: Set<number>;
  has: (id: number) => boolean;
  toggle: (id: number) => void;
  toggleAll: () => void;
  clear: () => void;
  allSelected: boolean;
  /** Périmètre explicite de la sélection. */
  scope: 'aucune' | 'lignes' | 'tout-le-filtre';
}

export function useSelection(visible: Movement[]): Selection {
  const [ids, setIds] = useState<Set<number>>(new Set());
  const visibleIds = useMemo(() => new Set(visible.map((m) => m.id)), [visible]);
  // la sélection ne conserve que des lignes du résultat filtré affiché
  useEffect(() => {
    setIds((s) => {
      const n = new Set([...s].filter((id) => visibleIds.has(id)));
      return n.size === s.size ? s : n;
    });
  }, [visibleIds]);
  const allSelected = visible.length > 0 && visible.every((m) => ids.has(m.id));
  return {
    ids,
    has: (id) => ids.has(id),
    toggle: (id) => setIds((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    }),
    toggleAll: () => setIds(allSelected ? new Set() : new Set(visibleIds)),
    clear: () => setIds(new Set()),
    allSelected,
    scope: ids.size === 0 ? 'aucune' : allSelected ? 'tout-le-filtre' : 'lignes',
  };
}

export function BulkBar({ sel, filteredCount }: { sel: Selection; filteredCount: number }) {
  const { driver, snap, reload } = useData();
  const [mode, setMode] = useState<'rubrique' | 'commentaire' | 'suppression' | null>(null);
  const [rubrique, setRubrique] = useState<number | null>(null);
  const [comment, setComment] = useState('');
  const [preview, setPreview] = useState<bulk.ReclassifyPreview | null>(null);
  const [deps, setDeps] = useState<mv.Dependencies | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  if (sel.ids.size === 0) return msg ? <Notice kind={msg.kind}>{msg.text}</Notice> : null;
  const ids = [...sel.ids];
  const done = async (text: string) => {
    await reload();
    sel.clear();
    setMode(null);
    setPreview(null);
    setDeps(null);
    setMsg({ kind: 'ok', text });
  };
  return (
    <div className="bulkbar" role="region" aria-label="Actions sur la sélection">
      <strong>
        {sel.ids.size} opération(s) sélectionnée(s)
        {sel.scope === 'tout-le-filtre' ? ` — toutes les lignes du filtre (${filteredCount})` : ''}
      </strong>
      <button onClick={() => setMode('rubrique')}>Changer de rubrique</button>
      <button onClick={() => setMode('commentaire')}>Commentaire commun</button>
      <button
        className="danger"
        onClick={async () => {
          setMode('suppression');
          const r = await mv.deleteMovements(driver, snap, ids, { confirmed: false });
          if ('deps' in r) setDeps(r.deps);
        }}
      >
        Supprimer…
      </button>
      <button onClick={() => sel.clear()}>Désélectionner</button>
      {mode === 'rubrique' && (
        <div className="bulk-panel">
          <RubriqueSelect snap={snap} value={rubrique} onChange={(v) => { setRubrique(v); setPreview(v ? bulk.previewReclassify(snap, ids, v) : null); }} includeTechnical ariaLabel="Nouvelle rubrique" />
          {preview && (
            <>
              <p>{preview.compatible.length} opération(s) peuvent passer dans « {preview.rubriqueName} ».</p>
              {preview.incompatible.map((x) => <p key={x.id} className="alert">{x.reason}</p>)}
              <p className="sub">Le signe, la nature et la devise ne sont jamais modifiés automatiquement.</p>
              <button className="primary" disabled={!preview.compatible.length} onClick={async () => {
                try {
                  const r = await bulk.reclassify(driver, snap, preview.compatible, rubrique!);
                  await done(`${r.changed} opération(s) reclassée(s).`);
                } catch (e) { setMsg({ kind: 'error', text: errorText(e) }); }
              }}>Reclasser {preview.compatible.length} opération(s)</button>
            </>
          )}
        </div>
      )}
      {mode === 'commentaire' && (
        <div className="bulk-panel">
          <input aria-label="Commentaire commun" value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Commentaire" />
          <button className="primary" onClick={async () => {
            try {
              const r = await bulk.setComment(driver, snap, ids, comment);
              await done(`Commentaire appliqué à ${r.changed} opération(s).`);
            } catch (e) { setMsg({ kind: 'error', text: errorText(e) }); }
          }}>Appliquer</button>
        </div>
      )}
      {mode === 'suppression' && deps && (
        <div className="bulk-panel">
          <p>Mettre à la corbeille {deps.movements.length + deps.transferPartners.length} opération(s) ?</p>
          {deps.consequences.map((c) => <p key={c}>{c}</p>)}
          <button className="danger" onClick={async () => {
            try {
              const r = await mv.deleteMovements(driver, snap, ids, { confirmed: true });
              await done(`${'deleted' in r ? r.deleted : 0} opération(s) mises à la corbeille.`);
            } catch (e) { setMsg({ kind: 'error', text: errorText(e) }); }
          }}>Confirmer</button>
          <button onClick={() => setMode(null)}>Annuler</button>
        </div>
      )}
      {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}
    </div>
  );
}
