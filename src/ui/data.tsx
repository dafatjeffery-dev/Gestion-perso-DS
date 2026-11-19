// Contexte de données : un snapshot unique rechargé après chaque écriture validée.

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Snapshot } from '../domain/types';
import type { Driver, StorageInfo } from '../storage/driver';
import { loadSnapshot } from '../storage/snapshot';

interface DataCtx {
  driver: Driver;
  snap: Snapshot;
  info: StorageInfo;
  reload: () => Promise<void>;
}

const Ctx = createContext<DataCtx | null>(null);

export function DataProvider({ driver, children }: { driver: Driver; children: ReactNode }) {
  const [state, setState] = useState<{ snap: Snapshot; info: StorageInfo } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try {
      const [snap, info] = await Promise.all([loadSnapshot(driver), driver.info()]);
      setState({ snap, info });
    } catch (e) {
      setError((e as Error).message);
    }
  }, [driver]);
  useEffect(() => {
    void reload();
  }, [reload]);
  if (error) return <div className="fatal">Erreur de lecture des données : {error}</div>;
  if (!state) return <div className="loading">Ouverture des données…</div>;
  return <Ctx.Provider value={{ driver, ...state, reload }}>{children}</Ctx.Provider>;
}

export function useData(): DataCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useData hors DataProvider');
  return c;
}
