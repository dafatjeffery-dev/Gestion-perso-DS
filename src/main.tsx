import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import './ui/styles.css';
import type { Driver } from './storage/driver';
import { TauriDriver, isTauri } from './storage/tauriDriver';

async function start() {
  const root = createRoot(document.getElementById('root')!);
  let driver: Driver;
  try {
    driver = isTauri() ? new TauriDriver() : await (await import('./storage/browser')).createBrowserDriver();
  } catch (e) {
    root.render(<div className="fatal">Impossible d’ouvrir les données : {(e as Error).message}</div>);
    return;
  }
  root.render(
    <StrictMode>
      <App driver={driver} />
    </StrictMode>,
  );
}
void start();
