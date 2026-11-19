// Interface sur l'APERÇU NAVIGATEUR (Chromium). Ne valide pas l'application Mac.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp } from './browser';

let app: Awaited<ReturnType<typeof startApp>>;
beforeAll(async () => { app = await startApp(); });
afterAll(async () => { await app?.close(); });

const nav = (name: string) => app.page.getByRole('navigation', { name: 'Navigation principale' }).getByRole('button', { name, exact: true });

describe('lot 4 — crédits et projets', () => {
  it('annuler une fiche de crédit n’enregistre ni le crédit ni ses associations', async () => {
    const { page } = app;
    await nav('Comptes').click();
    await page.getByRole('button', { name: 'Nouveau compte' }).click();
    await page.getByRole('dialog').getByLabel('Nom', { exact: true }).fill('Courant');
    await page.getByRole('dialog').getByRole('button', { name: 'Enregistrer' }).click();
    await nav('Crédits').click();
    await page.getByRole('button', { name: 'Nouveau crédit' }).click();
    const dlg = page.getByRole('dialog', { name: 'Nouveau crédit' });
    await dlg.getByLabel('Nom', { exact: true }).fill('Prêt immo');
    await dlg.getByLabel('Capital emprunté').fill('200 000');
    await dlg.getByLabel('Taux nominal').fill('1,85');
    await dlg.getByLabel('Compte de prélèvement').selectOption({ label: 'Courant (EUR)' });
    expect(await dlg.innerText()).toMatch(/Première échéance : 997,62/);
    await dlg.getByRole('button', { name: 'Annuler' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Abandonner les modifications' }).click();
    expect(await page.getByRole('article').count()).toBe(0);
  });

  it('enregistrer la fiche : carte avec capital restant dû et tableau d’amortissement', async () => {
    const { page } = app;
    await page.getByRole('button', { name: 'Nouveau crédit' }).click();
    const dlg = page.getByRole('dialog', { name: 'Nouveau crédit' });
    await dlg.getByLabel('Nom', { exact: true }).fill('Prêt immo');
    await dlg.getByLabel('Capital emprunté').fill('200 000');
    await dlg.getByLabel('Taux nominal').fill('1,85');
    await dlg.getByRole('button', { name: 'Enregistrer la fiche' }).click();
    const card = page.getByRole('article', { name: 'Crédit Prêt immo' });
    await card.waitFor();
    await card.getByRole('button', { name: 'Tableau d’amortissement' }).click();
    const table = page.getByRole('dialog', { name: /Tableau d’amortissement/ });
    expect(await table.innerText()).toMatch(/308,33/);
    expect(await table.innerText()).toContain('Seul l’échéancier de votre banque fait foi');
    await table.getByRole('button', { name: 'Archiver' }).click();
    await page.getByRole('heading', { name: 'Crédits archivés ou soldés' }).waitFor();
  });

  it('réserve et projet : non affecté = liquidités − réservé', async () => {
    const { page } = app;
    await nav('Réserve, fonds et projets').click();
    await page.getByRole('button', { name: 'Nouveau projet' }).click();
    const dlg = page.getByRole('dialog', { name: 'Nouveau projet' });
    await dlg.getByLabel('Nom', { exact: true }).fill('Véhicule');
    await dlg.getByLabel('Objectif').fill('22 000');
    await dlg.getByRole('button', { name: 'Enregistrer' }).click();
    await page.getByRole('article', { name: 'Projet Véhicule' }).getByRole('button', { name: 'Affecter / libérer' }).click();
    const a = page.getByRole('dialog', { name: /Affecter ou libérer/ });
    await a.getByLabel('Montant à affecter').fill('9 000');
    await a.getByRole('button', { name: 'Enregistrer' }).click();
    await page.getByRole('article', { name: 'Projet Véhicule' }).getByText('41 %', { exact: false }).waitFor();
    // aucun solde constaté sur le compte : les liquidités sont absentes, donc le non affecté aussi
    const kpi = await page.locator('.kpis').innerText();
    expect(kpi).toMatch(/Réservé \(réserve \+ fonds\)\s*9\s000\s€/);
    expect(kpi).toMatch(/Non affecté\s*—/);
  });
});
