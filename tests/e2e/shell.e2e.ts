import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp } from './browser';

let app: Awaited<ReturnType<typeof startApp>>;
beforeAll(async () => { app = await startApp(); });
afterAll(async () => { await app?.close(); });

describe('aperçu navigateur — coquille', () => {
  it('annonce clairement que les données sont dans le navigateur, jamais sur le Mac', async () => {
    const { page } = app;
    await page.getByRole('status').waitFor();
    const banner = await page.getByRole('status').innerText();
    expect(banner).toContain('Aperçu navigateur');
    expect(banner).toContain('pas dans l\'application Mac');
    await page.getByRole('button', { name: 'Paramètres' }).click();
    await page.getByRole('tab', { name: 'Données et sauvegardes' }).click();
    const loc = await page.getByTestId('storage-location').innerText();
    expect(loc).not.toMatch(/enregistrées sur ce Mac/);
  });
});
