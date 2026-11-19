import { createRequire } from 'node:module';
import { preview, build } from 'vite';
import type { Browser, Page } from 'playwright';

const require = createRequire(import.meta.url);
function loadPlaywright(): typeof import('playwright') {
  try {
    return require('playwright');
  } catch {
    return require('/opt/node-tools/node_modules/playwright');
  }
}

let built = false;
export async function startApp(): Promise<{ url: string; browser: Browser; page: Page; close: () => Promise<void> }> {
  if (!built) {
    await build({ logLevel: 'silent' });
    built = true;
  }
  const server = await preview({ preview: { port: 4173, strictPort: false }, logLevel: 'silent' });
  const url = server.resolvedUrls!.local[0]!;
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch();
  const page = await browser.newPage({ locale: 'fr-FR', timezoneId: 'Europe/Paris' });
  await page.goto(url);
  return {
    url,
    browser,
    page,
    close: async () => {
      await browser.close();
      await new Promise<void>((r) => server.httpServer.close(() => r()));
    },
  };
}
