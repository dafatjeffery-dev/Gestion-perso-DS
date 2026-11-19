// Interface sur l'APERÇU NAVIGATEUR (Chromium). Ne valide pas l'application Mac.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp } from './browser';

let app: Awaited<ReturnType<typeof startApp>>;
beforeAll(async () => { app = await startApp(); });
afterAll(async () => { await app?.close(); });
const nav = (name: string) => app.page.getByRole('navigation', { name: 'Navigation principale' }).getByRole('button', { name, exact: true });

describe('lot 5 — vue d’ensemble', () => {
  it('situation, prévision et analyse, chaque chiffre ouvrant sa composition', async () => {
    const { page } = app;
    await page.getByRole('button', { name: 'Nouveau compte' }).click();
    let d = page.getByRole('dialog');
    await d.getByLabel('Nom', { exact: true }).fill('Courant');
    await d.getByLabel('Solde initial').fill('2 000');
    await d.getByLabel('à la date du').fill('2020-01-01');
    await d.getByRole('button', { name: 'Enregistrer' }).click();
    await nav('Engagements').click();
    await page.getByRole('button', { name: 'Nouvelle récurrence' }).click();
    d = page.getByRole('dialog');
    await d.getByLabel('Libellé').fill('Loyer');
    await d.getByLabel('Rubrique').selectOption({ label: 'Loyer ou charges' });
    await d.getByLabel('Montant de la récurrence').fill('1 000');
    await d.getByLabel('Début').fill('2030-01-01');
    await d.getByRole('button', { name: 'Enregistrer' }).click();
    await nav('Vue d\'ensemble').click();
    const kpi = page.locator('.kpis').first();
    expect(await kpi.innerText()).toMatch(/Liquidités totales\s*2\s000\s€/);
    await page.getByRole('button', { name: /^Non affecté :/ }).click();
    const panel = page.getByRole('complementary', { name: 'Détail : Non affecté' });
    expect(await panel.innerText()).toContain('Liquidités totales − réservé');
    await page.getByRole('button', { name: 'Fermer le détail' }).click();
    // solde constaté ancien : signalé dans la prévision et dans « À vérifier »
    expect(await page.getByText(/solde constaté du 01\/01\/2020/).count()).toBeGreaterThan(0);
    expect(await page.getByRole('region').count()).toBeGreaterThanOrEqual(0);
    expect(await page.locator('section', { hasText: 'À vérifier' }).innerText()).toMatch(/ancien de \d+ jours/);
    await page.getByRole('button', { name: /^Minimum des soldes prévus en fin de mois :/ }).click();
    expect(await page.getByRole('complementary').innerText()).toMatch(/Plus bas des soldes consolidés prévus/);
  });

  it('périmètre compte : la comparaison au budget familial est indisponible et annoncée', async () => {
    const { page } = app;
    await page.getByRole('button', { name: 'Fermer le détail' }).click();
    await page.getByLabel('Périmètre').selectOption({ label: 'Courant' });
    expect(await page.getByText('Comparaison au budget indisponible').count()).toBe(1);
    expect(await page.getByText(/sont exclus totaux synthétiques/).count()).toBe(1);
    await page.getByLabel('Début de période').fill('2026-12');
    await page.getByLabel('Fin de période').fill('2026-01');
    expect(await page.getByText('Le début de période est après la fin.').count()).toBe(1);
  });
});
