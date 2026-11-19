// Interface sur l'APERÇU NAVIGATEUR (Chromium). Ne valide pas l'application Mac.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp } from './browser';

let app: Awaited<ReturnType<typeof startApp>>;
beforeAll(async () => { app = await startApp(); });
afterAll(async () => { await app?.close(); });
const nav = (name: string) => app.page.getByRole('navigation', { name: 'Navigation principale' }).getByRole('button', { name, exact: true });

const header = 'identifiant_bancaire;compte;date_operation;date_valeur;libelle_bancaire;libelle_simplifie;montant;devise;nature;famille;rubrique;reference_transfert;commentaire;statut_classement';

describe('lot 6 — import standardisé', () => {
  it('télécharger le modèle, importer un fichier, retrouver le lot, l’annuler', async () => {
    const { page } = app;
    await page.getByRole('button', { name: 'Nouveau compte' }).click();
    await page.getByRole('dialog').getByLabel('Nom', { exact: true }).fill('Courant');
    await page.getByRole('dialog').getByRole('button', { name: 'Enregistrer' }).click();
    await page.getByRole('button', { name: 'Importer des opérations' }).click();
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Télécharger le modèle d’import (.xlsx)' }).click()]);
    expect(dl.suggestedFilename()).toBe('modele-import-ds-finances-1.0.xlsx');
    const bytes = readFileSync((await dl.path())!);
    expect(bytes.subarray(0, 2).toString()).toBe('PK');
    const csv = [header, 'B1;CPT-1;2026-11-03;;CB MARCHÉ;Marché;-42,10;EUR;depense;Alimentation;DEP.ALIM.COURSES;;;confirmé', ';CPT-1;04/11/2026;;PRLV INCONNU;;-15,00;EUR;a_classer;;;;doute;à vérifier', ';CPT-1;05/11/2026;;MAUVAISE DEVISE;;-1;CHF;depense;;DEP.ALIM.COURSES;;;confirmé'].join('\r\n');
    await page.getByLabel('Fichier à importer').setInputFiles({ name: 'novembre.csv', mimeType: 'text/csv', buffer: Buffer.from('﻿' + csv, 'utf8') });
    const err = page.locator('.notice.error');
    await err.waitFor();
    expect(await err.innerText()).toContain('Ligne 4, colonne Devise : « CHF » : CHF n’est pas compatible avec le compte Courant — attendu : EUR');
    expect(await page.getByRole('button', { name: /Confirmer l’intégration/ }).isDisabled()).toBe(true);
    const ok = [header, 'B1;CPT-1;2026-11-03;;CB MARCHÉ;Marché;-42,10;EUR;depense;Alimentation;DEP.ALIM.COURSES;;;confirmé', ';CPT-1;04/11/2026;;PRLV INCONNU;;-15,00;EUR;a_classer;;;;doute;à vérifier'].join('\r\n');
    await page.getByLabel('Fichier à importer').setInputFiles({ name: 'novembre.csv', mimeType: 'text/csv', buffer: Buffer.from(ok, 'utf8') });
    await page.getByRole('button', { name: 'Confirmer l’intégration de 2 opération(s)' }).click();
    await page.getByText('Lot n° 1 intégré : 2 opération(s).').waitFor();
    // réimport : doublons certains, rien à intégrer
    await page.getByLabel('Fichier à importer').setInputFiles({ name: 'copie.csv', mimeType: 'text/csv', buffer: Buffer.from(ok, 'utf8') });
    expect(await page.getByText('doublon certain').count()).toBe(2);
    expect(await page.getByRole('button', { name: 'Confirmer l’intégration de 0 opération(s)' }).isDisabled()).toBe(true);
    await page.getByRole('button', { name: 'Abandonner cet import' }).click();
    // lot → opérations filtrées
    await page.getByRole('button', { name: 'Opérations du lot' }).click();
    expect(await page.locator('table.ops tbody tr').count()).toBe(2);
    expect(await page.getByText('Lot d’import n° 1').count()).toBe(1);
    // sélection de toutes les lignes du filtre et reclassement : la ligne « À classer » technique est expliquée
    await page.getByLabel('Tout sélectionner (page filtrée)').check();
    expect(await page.getByRole('region', { name: 'Actions sur la sélection' }).innerText()).toContain('toutes les lignes du filtre (2)');
    await nav('Opérations').click();
    await page.getByRole('button', { name: 'Importer des opérations' }).click();
    await page.getByRole('button', { name: 'Annuler le lot…' }).click();
    await page.getByRole('button', { name: 'Confirmer l’annulation' }).click();
    await page.getByText(/Lot n° 1 annulé : 2 opération\(s\) à la corbeille/).waitFor();
  });
});
