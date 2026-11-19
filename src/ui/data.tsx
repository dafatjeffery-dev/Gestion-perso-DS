// Contexte de données : un snapshot unique rechargé après chaque écriture validée,
// et le contexte du moteur (même moteur pour tous les écrans).

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { todayParis } from '../domain/dates';
import type { Snapshot } from '../domain/types';
import { buildCtx, type Ctx } from '../engine/context';
import { realLines, type RealLines } from '../engine/lines';
import type { Driver, StorageInfo } from '../storage/driver';
import { loadSnapshot } from '../storage/snapshot';

interface DataCtx {
  driver: Driver;
  snap: Snapshot;
  info: StorageInfo;
  ctx: Ctx;
  real: RealLines;
  today: string;
  reload: () => Promise<void>;
}

const Ctx_ = createContext<DataCtx | null>(null);

export function DataProvider({ driver, children, today: forcedToday }: { driver: Driver; children: ReactNode; today?: string }) {
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
  const today = forcedToday ?? todayParis();
  const derived = useMemo(() => {
    if (!state) return null;
    const ctx = buildCtx(state.snap, today);
    return { ctx, real: realLines(ctx) };
  }, [state, today]);
  if (error) return <div className="fatal">Erreur de lecture des données : {error}</div>;
  if (!state || !derived) return <div className="loading">Ouverture des données…</div>;
  return <Ctx_.Provider value={{ driver, ...state, ...derived, today, reload }}>{children}</Ctx_.Provider>;
}

export function useData(): DataCtx {
  const c = useContext(Ctx_);
  if (!c) throw new Error('useData hors DataProvider');
  return c;
}
