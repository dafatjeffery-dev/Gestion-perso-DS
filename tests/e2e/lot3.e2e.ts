// Tests de l'interface sur l'APERÇU NAVIGATEUR (Chromium). Ne valident pas l'application Mac.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp } from './browser';

let app: Awaited<ReturnType<typeof startApp>>;
beforeAll(async () => { app = await startApp(); });
afterAll(async () => { await app?.close(); });

describe('lot 3 — comptes, opérations, suivi, protection des saisies', () => {
  it('créer un compte avec son dernier solde, puis le voir dans les cartes', async () => {
    const { page } = app;
    await page.getByRole('button', { name: 'Comptes', exact: true }).click();
    await page.getByRole('button', { name: 'Nouveau compte' }).click();
    const dlg = page.getByRole('dialog', { name: 'Nouveau compte' });
    await dlg.getByLabel('Nom').fill('Courant commun');
    await dlg.getByLabel('Solde initial').fill('1 234,56');
    await dlg.getByRole('button', { name: 'Enregistrer' }).click();
    await page.getByRole('article', { name: 'Compte Courant commun' }).waitFor();
    expect(await page.getByRole('article', { name: 'Compte Courant commun' }).innerText()).toMatch(/1\s234,56\s€/);
  });

  it('une saisie modifiée est protégée : Rester / Abandonner, et le brouillon est proposé ailleurs', async () => {
    const { page } = app;
    await page.getByRole('button', { name: 'Nouveau compte' }).click();
    const dlg = page.getByRole('dialog', { name: 'Nouveau compte' });
    await dlg.getByLabel('Nom').fill('Livret en cours de saisie');
    await page.waitForTimeout(600); // écriture du brouillon
    // un second onglet voit le brouillon, présenté comme non enregistré
    const page2 = await page.context().newPage();
    await page2.goto(app.url);
    await page2.getByRole('button', { name: 'Comptes', exact: true }).click();
    await page2.getByRole('button', { name: 'Nouveau compte' }).click();
    const banner = page2.getByRole('dialog', { name: 'Nouveau compte' }).getByRole('status');
    expect(await banner.innerText()).toMatch(/Brouillon non enregistré/);
    expect(await page2.getByRole('article').count()).toBe(1); // le brouillon n'est pas un compte
    await page2.close();
    // quitter vers un autre écran : choix explicite
    await page.keyboard.press('Escape');
    const alert = page.getByRole('alertdialog', { name: 'Modifications non enregistrées' });
    await alert.waitFor();
    await alert.getByRole('button', { name: 'Rester' }).click();
    expect(await dlg.getByLabel('Nom').inputValue()).toBe('Livret en cours de saisie');
    // changer d'écran depuis la navigation : même protection
    await dlg.getByRole('button', { name: 'Annuler' }).click();
    await alert.waitFor();
    expect(await alert.innerText()).toContain('« Nouveau compte » contient des modifications');
    await alert.getByRole('button', { name: 'Abandonner les modifications' }).click();
    expect(await page.getByRole('dialog', { name: 'Nouveau compte' }).count()).toBe(0);
    expect(await page.getByRole('article').count()).toBe(1);
    // le brouillon abandonné n'est plus proposé
    await page.getByRole('button', { name: 'Nouveau compte' }).click();
    expect(await page.getByRole('dialog', { name: 'Nouveau compte' }).getByRole('status').count()).toBe(0);
    expect(await page.getByRole('dialog', { name: 'Nouveau compte' }).getByLabel('Nom').inputValue()).toBe('');
    await page.getByRole('dialog', { name: 'Nouveau compte' }).getByRole('button', { name: 'Annuler' }).click();
  });

  it('saisir une opération puis la retrouver dans le suivi mensuel, avec son détail', async () => {
    const { page } = app;
    await page.getByRole('navigation', { name: 'Navigation principale' }).getByRole('button', { name: 'Opérations' }).click();
    await page.getByRole('button', { name: 'Nouvelle opération' }).click();
    const dlg = page.getByRole('dialog', { name: 'Nouvelle opération' });
    await dlg.getByLabel('Compte').selectOption({ label: 'Courant commun (EUR)' });
    await dlg.getByLabel('Montant').fill('-42,10');
    await dlg.getByLabel('Rubrique').selectOption({ label: 'Courses' });
    await dlg.getByLabel('Libellé simplifié').fill('Marché');
    await dlg.getByRole('button', { name: 'Enregistrer' }).click();
    await page.getByRole('button', { name: 'Marché' }).waitFor();
    expect(await page.locator('table.ops').innerText()).toMatch(/−42,10\s€/);
    await page.getByRole('navigation', { name: 'Navigation principale' }).getByRole('button', { name: 'Suivi mensuel' }).click();
    await page.getByRole('button', { name: /Alimentation/ }).click();
    const row = page.locator('tr.rub-row', { hasText: 'Courses' });
    expect(await row.innerText()).toContain('42');
    await row.getByRole('button', { name: /^Réel :/ }).click();
    const panel = page.getByRole('complementary', { name: /Détail : Réel/ });
    expect(await panel.innerText()).toContain('Marché');
  });

  it('un total mensuel dans une rubrique qui a du détail exige un choix explicite', async () => {
    const { page } = app;
    await page.getByRole('button', { name: 'Fermer le détail' }).click();
    const row = page.locator('tr.rub-row', { hasText: 'Courses' });
    await row.getByRole('button', { name: 'Total du mois' }).click();
    const dlg = page.getByRole('dialog', { name: /Total du mois — Courses/ });
    expect(await dlg.innerText()).toContain('aucun compte : il n’agit pas sur les soldes');
    await dlg.getByLabel('Montant du total').fill('300');
    await dlg.getByRole('button', { name: 'Enregistrer le total' }).click();
    const choice = dlg.getByRole('group', { name: 'Choix de couverture' });
    await choice.waitFor();
    await choice.getByLabel(/Le total remplace le détail/).check();
    await dlg.getByRole('button', { name: 'Enregistrer le total' }).click();
    await dlg.getByText('Total enregistré :').waitFor();
    await dlg.getByRole('button', { name: 'Fermer' }).click();
    expect(await page.locator('tr.rub-row', { hasText: 'Courses' }).innerText()).toContain('300');
  });
});
