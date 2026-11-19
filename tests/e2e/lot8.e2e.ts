// Interface sur l'APERÇU NAVIGATEUR (Chromium). Ne valide pas l'application Mac.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp } from './browser';

let app: Awaited<ReturnType<typeof startApp>>;
beforeAll(async () => { app = await startApp(); });
afterAll(async () => { await app?.close(); });
const nav = (name: string) => app.page.getByRole('navigation', { name: 'Navigation principale' }).getByRole('button', { name, exact: true });

describe('lot 8 — exports, corbeille, restauration (aperçu)', () => {
  it('export complet téléchargé, corbeille restaurable, sauvegarde et restauration de la base du navigateur', async () => {
    const { page } = app;
    page.on('dialog', (d) => void d.accept());
    await page.getByRole('button', { name: 'Nouveau compte' }).click();
    await page.getByRole('dialog').getByLabel('Nom', { exact: true }).fill('Courant');
    await page.getByRole('dialog').getByRole('button', { name: 'Enregistrer' }).click();
    await nav('Opérations').click();
    await page.getByRole('button', { name: 'Nouvelle opération' }).click();
    const d = page.getByRole('dialog');
    await d.getByLabel('Compte').selectOption({ label: 'Courant (EUR)' });
    await d.getByLabel('Montant').fill('-10');
    await d.getByLabel('Rubrique').selectOption({ label: 'Courses' });
    await d.getByLabel('Libellé simplifié').fill('Pain');
    await d.getByRole('button', { name: 'Enregistrer' }).click();
    await nav('Paramètres').click();
    await page.getByRole('tab', { name: 'Données et sauvegardes' }).click();
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export complet (JSON, réimportable)' }).click()]);
    const exp = JSON.parse(readFileSync((await dl.path())!, 'utf8'));
    expect(exp.format).toBe('ds-finances-export');
    expect(exp.tables.movement).toHaveLength(1);
    const [bk] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Télécharger une sauvegarde (.sqlite)' }).click()]);
    const backupPath = (await bk.path())!;
    // suppression puis restauration depuis la corbeille
    await nav('Opérations').click();
    await page.getByRole('button', { name: 'Pain' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Supprimer…' }).click();
    await page.getByRole('button', { name: 'Confirmer la suppression' }).click();
    await nav('Paramètres').click();
    await page.getByRole('tab', { name: 'Données et sauvegardes' }).click();
    const trash = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Corbeille', exact: true }) });
    await trash.getByRole('button', { name: 'Restaurer' }).click();
    await expect.poll(() => trash.innerText()).toContain('Vide');
    // restaurer la sauvegarde : l'opération est là (état de la sauvegarde)
    await page.getByText('Restaurer depuis un fichier .sqlite…').locator('input').setInputFiles(backupPath);
    await page.getByText(/Base restaurée depuis/).waitFor();
    expect(await page.locator('section').filter({ has: page.getByRole('heading', { name: /Journal des modifications/ }) }).innerText()).toMatch(/Opération du/);
  });
});
