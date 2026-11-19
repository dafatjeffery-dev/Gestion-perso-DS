import { createContext, useContext } from 'react';

export type ScreenId = 'overview' | 'monthly' | 'accounts' | 'operations' | 'commitments' | 'loans' | 'funds' | 'wealth' | 'imports' | 'settings';

export interface NavParams {
  accountId?: number;
  month?: string;
  rubriqueId?: number;
  batchId?: number;
}

export interface Nav {
  screen: ScreenId;
  params: NavParams;
  go: (s: ScreenId, p?: NavParams) => void;
}

export const NavCtx = createContext<Nav>({ screen: 'overview', params: {}, go: () => undefined });
export const useNav = () => useContext(NavCtx);
