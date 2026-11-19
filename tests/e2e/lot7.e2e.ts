// Interface sur l'APERÇU NAVIGATEUR (Chromium). Ne valide pas l'application Mac.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp } from './browser';

let app: Awaited<ReturnType<typeof startApp>>;
beforeAll(async () => { app = await startApp(); });
afterAll(async () => { await app?.close(); });

describe('lot 7 — patrimoine et projection', () => {
  it('patrimoine net détaillé, bien déclaré, fourchette des trois scénarios', async () => {
    const { page } = app;
    await page.getByRole('button', { name: 'Nouveau compte' }).click();
    const d = page.getByRole('dialog');
    await d.getByLabel('Nom', { exact: true }).fill('Courant');
    await d.getByLabel('Solde initial').fill('10 000');
    await d.getByRole('button', { name: 'Enregistrer' }).click();
    await page.getByRole('navigation', { name: 'Navigation principale' }).getByRole('button', { name: 'Patrimoine et projection' }).click();
    await page.getByRole('button', { name: 'Nouveau bien' }).click();
    await page.getByRole('dialog').getByLabel('Nom').fill('Maison');
    await page.getByRole('dialog').getByRole('button', { name: 'Enregistrer' }).click();
    await page.getByRole('row', { name: /Maison/ }).getByRole('button', { name: 'Déclarer une valeur' }).click();
    await page.getByRole('dialog').getByLabel('Valeur déclarée').fill('400 000');
    await page.getByRole('dialog').getByRole('button', { name: 'Enregistrer' }).click();
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    await expect.poll(() => page.getByRole('button', { name: /^Patrimoine net :/ }).getAttribute('aria-label')).toMatch(/410\s000,00\s€/);
    const table = await page.locator('table', { hasText: 'Prudent' }).first().innerText();
    expect(table).toMatch(/Central/);
    expect(await page.getByText(/aucune date de retraite renseignée/).count()).toBe(1);
  });
});
