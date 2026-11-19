import { useState } from 'react';
import type { Driver } from '../storage/driver';
import { DataProvider, useData } from './data';
import { SettingsScreen } from './screens/Settings';

export type ScreenId =
  | 'overview' | 'monthly' | 'accounts' | 'operations' | 'commitments'
  | 'loans' | 'funds' | 'wealth' | 'settings';

const NAV: { id: ScreenId; label: string }[] = [
  { id: 'overview', label: "Vue d'ensemble" },
  { id: 'monthly', label: 'Suivi mensuel' },
  { id: 'accounts', label: 'Comptes' },
  { id: 'operations', label: 'Opérations' },
  { id: 'commitments', label: 'Engagements' },
  { id: 'loans', label: 'Crédits' },
  { id: 'funds', label: 'Réserve, fonds et projets' },
  { id: 'wealth', label: 'Patrimoine et projection' },
  { id: 'settings', label: 'Paramètres' },
];

function Shell() {
  const { info, snap } = useData();
  const [screen, setScreen] = useState<ScreenId>('settings');
  return (
    <div className="app">
      <nav className="side">
        <div className="brand">DS Finances</div>
        {NAV.map((n) => (
          <button key={n.id} className={n.id === screen ? 'nav on' : 'nav'} onClick={() => setScreen(n.id)}>
            {n.label}
          </button>
        ))}
        <div className="store-hint">{info.kind === 'mac' ? 'Données sur ce Mac' : info.kind === 'navigateur' ? 'Aperçu navigateur' : 'Mémoire (tests)'}</div>
      </nav>
      <main className="main">
        {info.kind !== 'mac' && <div className="banner-preview" role="status">{info.locationLabel}</div>}
        {screen === 'settings' ? (
          <SettingsScreen />
        ) : (
          <div className="placeholder">
            <h1>{NAV.find((n) => n.id === screen)!.label}</h1>
            <p className="sub">Écran prévu dans un lot ultérieur. Foyer : {snap.household.name}.</p>
          </div>
        )}
      </main>
    </div>
  );
}

export function App({ driver }: { driver: Driver }) {
  return (
    <DataProvider driver={driver}>
      <Shell />
    </DataProvider>
  );
}
