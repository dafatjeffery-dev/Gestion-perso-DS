// Protection des saisies : brouillons locaux + choix Enregistrer / Abandonner / Rester
// avant de quitter un formulaire modifié. Un brouillon n'est jamais une donnée enregistrée.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Driver } from '../../storage/driver';

interface Entry {
  label: string;
  isDirty: () => boolean;
  save: () => Promise<boolean>;
  discard: () => void;
}

interface DraftRecord {
  data: unknown;
  savedAt: string;
}

interface GuardCtx {
  register: (id: string, e: Entry) => () => void;
  /** Exécute `action` après avoir protégé les formulaires modifiés. */
  attempt: (action: () => void) => void;
  getDraft: (key: string) => DraftRecord | null;
  putDraft: (key: string, data: unknown) => void;
  dropDraft: (key: string) => void;
}

const Ctx = createContext<GuardCtx | null>(null);
export const useGuard = () => {
  const c = useContext(Ctx);
  if (!c) throw new Error('useGuard hors GuardProvider');
  return c;
};

export function GuardProvider({ driver, children }: { driver: Driver; children: ReactNode }) {
  const entries = useRef(new Map<string, Entry>());
  const drafts = useRef<Record<string, DraftRecord>>({});
  const [loaded, setLoaded] = useState(false);
  const [pending, setPending] = useState<{ action: () => void; entry: [string, Entry] } | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    void driver.readDrafts().then((t) => {
      try {
        drafts.current = JSON.parse(t || '{}') as Record<string, DraftRecord>;
      } catch {
        drafts.current = {};
      }
      setLoaded(true);
    });
  }, [driver]);

  const flush = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void driver.writeDrafts(JSON.stringify(drafts.current)), 400);
  }, [driver]);

  const dirtyEntry = () => [...entries.current.entries()].find(([, e]) => e.isDirty()) ?? null;

  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => {
      if (dirtyEntry()) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', h);
    let unlisten: (() => void) | undefined;
    if ('__TAURI_INTERNALS__' in window) {
      void import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
        const w = getCurrentWindow();
        void w
          .onCloseRequested((ev) => {
            const d = dirtyEntry();
            if (d) {
              ev.preventDefault();
              setPending({ action: () => void w.destroy(), entry: d });
            }
          })
          .then((u) => (unlisten = u));
      });
    }
    return () => {
      window.removeEventListener('beforeunload', h);
      unlisten?.();
    };
  }, []);

  const value = useMemo<GuardCtx>(
    () => ({
      register: (id, e) => {
        entries.current.set(id, e);
        return () => entries.current.delete(id);
      },
      attempt: (action) => {
        const d = dirtyEntry();
        if (!d) action();
        else {
          setSaveError(null);
          setPending({ action, entry: d });
        }
      },
      getDraft: (k) => drafts.current[k] ?? null,
      putDraft: (k, data) => {
        drafts.current[k] = { data, savedAt: new Date().toISOString() };
        flush();
      },
      dropDraft: (k) => {
        if (k in drafts.current) {
          delete drafts.current[k];
          flush();
        }
      },
    }),
    [flush],
  );

  if (!loaded) return null;
  return (
    <Ctx.Provider value={value}>
      {children}
      {pending && (
        <div className="modal-backdrop">
          <div className="modal" role="alertdialog" aria-label="Modifications non enregistrées">
            <h2>Modifications non enregistrées</h2>
            <p>« {pending.entry[1].label} » contient des modifications qui ne sont pas enregistrées.</p>
            {saveError && <p className="alert">{saveError}</p>}
            <div className="actions">
              <button
                className="primary"
                onClick={async () => {
                  try {
                    const ok = await pending.entry[1].save();
                    if (ok) {
                      const a = pending.action;
                      setPending(null);
                      a();
                    } else setSaveError('L’enregistrement n’a pas abouti : corrigez les champs signalés.');
                  } catch (e) {
                    setSaveError((e as Error).message);
                  }
                }}
              >
                Enregistrer
              </button>
              <button
                onClick={() => {
                  pending.entry[1].discard();
                  entries.current.delete(pending.entry[0]);
                  const a = pending.action;
                  setPending(null);
                  a();
                }}
              >
                Abandonner les modifications
              </button>
              <button onClick={() => setPending(null)}>Rester</button>
            </div>
          </div>
        </div>
      )}
    </Ctx.Provider>
  );
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * État d'un formulaire protégé. Les valeurs modifiées sont recopiées en brouillon local ;
 * à la réouverture, un brouillon existant est proposé (jamais appliqué d'office).
 */
export function useProtectedForm<T>(key: string, label: string, initial: T, save: (v: T) => Promise<boolean>) {
  const g = useGuard();
  const [values, setValues] = useState<T>(initial);
  const [baseline, setBaseline] = useState<T>(initial);
  const draft = g.getDraft(key);
  const [offer, setOffer] = useState<{ data: T; savedAt: string } | null>(draft && !same(draft.data, initial) ? { data: draft.data as T, savedAt: draft.savedAt } : null);
  const dirty = !same(values, baseline);
  const ref = useRef({ values, dirty });
  ref.current = { values, dirty };

  const doSave = useCallback(async () => {
    const ok = await save(ref.current.values);
    if (ok) {
      g.dropDraft(key);
      setBaseline(ref.current.values);
    }
    return ok;
  }, [save, g, key]);

  useEffect(
    () =>
      g.register(key, {
        label,
        isDirty: () => ref.current.dirty,
        save: doSave,
        discard: () => g.dropDraft(key),
      }),
    [g, key, label, doSave],
  );

  useEffect(() => {
    if (dirty) g.putDraft(key, values);
  }, [values, dirty, g, key]);

  return {
    values,
    set: (patch: Partial<T>) => setValues((v) => ({ ...v, ...patch })),
    setValues,
    dirty,
    save: doSave,
    discard: () => {
      g.dropDraft(key);
      setValues(baseline);
    },
    draftOffer: offer,
    restoreDraft: () => {
      if (offer) setValues(offer.data);
      setOffer(null);
    },
    ignoreDraft: () => {
      g.dropDraft(key);
      setOffer(null);
    },
  };
}

export function DraftBanner({ offer, onRestore, onIgnore }: { offer: { savedAt: string } | null; onRestore: () => void; onIgnore: () => void }) {
  if (!offer) return null;
  const d = new Date(offer.savedAt);
  return (
    <div className="notice warn" role="status">
      Brouillon non enregistré du {d.toLocaleDateString('fr-FR')} à {d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}.{' '}
      <button type="button" onClick={onRestore}>Reprendre le brouillon</button> <button type="button" onClick={onIgnore}>L’ignorer</button>
    </div>
  );
}
