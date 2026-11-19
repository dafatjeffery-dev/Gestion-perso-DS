import { useState } from 'react';
import type { Driver } from '../storage/driver';
import { DetailProvider } from './components/detail';
import { GuardProvider, useGuard } from './components/guard';
import { DataProvider, useData } from './data';
import { NavCtx, type NavParams, type ScreenId } from './nav';
import { AccountsScreen } from './screens/Accounts';
import { CommitmentsScreen } from './screens/Commitments';
import { FundsScreen } from './screens/Funds';
import { LoansScreen } from './screens/Loans';
import { MonthlyScreen } from './screens/Monthly';
import { OperationsScreen } from './screens/Operations';
import { SettingsScreen } from './screens/Settings';

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

const SCREENS: Partial<Record<ScreenId, () => JSX.Element>> = {
  monthly: MonthlyScreen,
  accounts: AccountsScreen,
  operations: OperationsScreen,
  commitments: CommitmentsScreen,
  loans: LoansScreen,
  funds: FundsScreen,
  settings: SettingsScreen,
};

export const registerScreen = (id: ScreenId, c: () => JSX.Element) => {
  SCREENS[id] = c;
};

function Shell() {
  const { info, snap } = useData();
  const guard = useGuard();
  const [nav, setNav] = useState<{ screen: ScreenId; params: NavParams; key: number }>({ screen: snap.accounts.length ? 'overview' : 'accounts', params: {}, key: 0 });
  const go = (screen: ScreenId, params: NavParams = {}) => guard.attempt(() => setNav((n) => ({ screen, params, key: n.key + 1 })));
  const Screen = SCREENS[nav.screen];
  return (
    <NavCtx.Provider value={{ screen: nav.screen, params: nav.params, go }}>
      <DetailProvider snap={snap}>
        <div className="app">
          <nav className="side" aria-label="Navigation principale">
            <div className="brand">DS Finances</div>
            {NAV.map((n) => (
              <button key={n.id} className={n.id === nav.screen ? 'nav on' : 'nav'} aria-current={n.id === nav.screen ? 'page' : undefined} onClick={() => go(n.id)}>
                {n.label}
              </button>
            ))}
            <div className="store-hint">{info.kind === 'mac' ? 'Données sur ce Mac' : info.kind === 'navigateur' ? 'Aperçu navigateur — données dans ce navigateur' : 'Mémoire (tests)'}</div>
          </nav>
          <main className="main">
            {info.kind !== 'mac' && <div className="banner-preview" role="status">{info.locationLabel}</div>}
            {Screen ? (
              <Screen key={nav.key} />
            ) : (
              <div className="placeholder">
                <h1>{NAV.find((n) => n.id === nav.screen)?.label ?? nav.screen}</h1>
                <p className="sub">Écran prévu dans un lot ultérieur.</p>
              </div>
            )}
          </main>
        </div>
      </DetailProvider>
    </NavCtx.Provider>
  );
}

export function App({ driver, today }: { driver: Driver; today?: string }) {
  return (
    <DataProvider driver={driver} today={today}>
      <GuardProvider driver={driver}>
        <Shell />
      </GuardProvider>
    </DataProvider>
  );
}
