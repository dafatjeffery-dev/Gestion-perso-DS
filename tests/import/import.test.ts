// Cas 12 : import standardisé. Données fictives.
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { analyze, emptyDecisions, type Decisions } from '../../src/import/analyze';
import { ALL_KEYS, aiInstructions, accountCode } from '../../src/import/format';
import { issueText, readCsv, readXlsx } from '../../src/import/read';
import { csvTemplate, xlsxTemplate } from '../../src/import/template';
import * as bulk from '../../src/services/bulk';
import * as imports from '../../src/services/imports';
import * as mv from '../../src/services/movements';
import * as eng from '../../src/services/engagements';
import { buildCtx } from '../../src/engine/context';
import { trackRubrique } from '../../src/engine/tracking';
import { foyer } from '../fixtures/foyer';

type F = Awaited<ReturnType<typeof foyer>>;
const TODAY = '2026-11-19';

function csvOf(rows: Record<string, string>[]): string {
  const esc = (s: string) => (/[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return '﻿' + [ALL_KEYS.join(';'), ...rows.map((r) => ALL_KEYS.map((k) => esc(r[k] ?? '')).join(';'))].join('\r\n') + '\r\n';
}

async function xlsxOf(f: F, rows: Record<string, string | number | Date>[]): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load((await xlsxTemplate(await f.snap())).buffer as ArrayBuffer);
  const ws = wb.getWorksheet('Operations')!;
  for (const r of rows) ws.addRow(ALL_KEYS.map((k) => r[k] ?? ''));
  return new Uint8Array((await wb.xlsx.writeBuffer()) as ArrayBuffer);
}

const row = (f: F, o: Partial<Record<string, string>> = {}): Record<string, string> => ({
  compte: accountCode(f.acc.courant), date_operation: '2026-11-03', libelle_bancaire: 'CB MARCHÉ CRÉPERIE', montant: '-42,10', devise: 'EUR', nature: 'depense', famille: 'Alimentation', rubrique: 'DEP.ALIM.COURSES', statut_classement: 'confirmé', ...o,
});

async function run(f: F, csv: string, d: Decisions = emptyDecisions(), name = 'releve.csv') {
  const p = analyze(await f.snap(), readCsv(name, csv), d);
  return p;
}
async function commit(f: F, csv: string, d: Decisions = emptyDecisions(), name = 'releve.csv') {
  const p = await run(f, csv, d, name);
  return { p, id: await imports.commitImport(f.driver, await f.snap(), p, d, { sha256: 'x' }) };
}

describe('modèle d’import', () => {
  it('XLSX : feuilles Operations, Notice, Exemples, Referentiels ; aucune formule ; ni IBAN ni solde', async () => {
    const f = await foyer();
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await xlsxTemplate(await f.snap())).buffer as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Operations', 'Notice', 'Exemples', 'Referentiels']);
    const ops = wb.getWorksheet('Operations')!;
    expect(ops.rowCount).toBe(1);
    expect((ops.getRow(1).values as unknown[]).slice(1)).toEqual([...ALL_KEYS]);
    let formulas = 0;
    let texts = '';
    wb.eachSheet((ws) => ws.eachRow((r) => r.eachCell((c) => { if (typeof c.value === 'object' && c.value && 'formula' in c.value) formulas++; texts += ` ${String(c.value)}`; })));
    expect(formulas).toBe(0);
    expect(texts).not.toMatch(/IBAN|FR76|3\s?000,00|512000|2295000/);
    expect(texts).toContain('CPT-1');
    expect(texts).toContain('EXEMPLES FICTIFS — NE PAS IMPORTER');
    expect(wb.getWorksheet('Notice')!.getCell('B1').value).toBe('1.0');
  });
  it('CSV : une seule ligne d’en-tête, mêmes colonnes ; consignes IA versionnées', () => {
    expect(csvTemplate()).toBe('﻿' + ALL_KEYS.join(';') + '\r\n');
    const t = aiInstructions();
    expect(t).toMatch(/format 1\.0/);
    for (const k of ALL_KEYS) expect(t).toContain(k);
    expect(t).toMatch(/Ne fusionne jamais/);
    expect(t).toMatch(/PDF illisible/);
  });
});

describe('import : lecture et contrôles', () => {
  it('modèle téléchargé, rempli, importé : résultats identiques en CSV et en XLSX (dates, accents, décimaux français, devises)', async () => {
    const f1 = await foyer();
    const f2 = await foyer();
    const rows = (f: F) => [
      row(f, { identifiant_bancaire: 'B1', montant: '-1 234,56' }),
      row(f, { date_operation: '05/11/2026', libelle_bancaire: 'PRÉLÈVEMENT ÉCOLE', montant: '-12,50', famille: 'Enfants', rubrique: 'Garde et école' }),
      row(f, { compte: 'Courant CHF', devise: 'CHF', montant: '935', libelle_bancaire: 'SALAIRE NOVEMBRE', nature: 'revenu_ordinaire', famille: '', rubrique: 'REV.TRAVAIL.SALAIRE_B' }),
    ];
    const c = await commit(f1, csvOf(rows(f1)));
    const x = await xlsxOf(f2, rows(f2).map((r, i) => (i === 1 ? { ...r, date_operation: new Date(Date.UTC(2026, 10, 5)) } : i === 2 ? { ...r, montant: 935 } : r)));
    const px = analyze(await f2.snap(), await readXlsx('releve.xlsx', x), emptyDecisions());
    expect(px.blocking).toEqual([]);
    await imports.commitImport(f2.driver, await f2.snap(), px, emptyDecisions(), { sha256: 'y' });
    const pick = (s: Awaited<ReturnType<F['snap']>>) => [...s.movements].sort((a, b) => a.import_row! - b.import_row!).map((m) => [m.account_id, m.op_date, m.amount_minor, m.currency, m.nature, m.rubrique_id, m.label_original, m.bank_id]);
    expect(pick(await f1.snap())).toEqual(pick(await f2.snap()));
    expect(pick(await f1.snap())).toEqual([
      [f1.acc.courant, '2026-11-03', -123456, 'EUR', 'depense', f1.rub.courses, 'CB MARCHÉ CRÉPERIE', 'B1'],
      [f1.acc.courant, '2026-11-05', -1250, 'EUR', 'depense', expect.any(Number), 'PRÉLÈVEMENT ÉCOLE', null],
      [f1.acc.chf, '2026-11-03', 93500, 'CHF', 'revenu_ordinaire', f1.rub.salaireB, 'SALAIRE NOVEMBRE', null],
    ]);
    const b = (await f1.snap()).importBatches[0]!;
    expect(b).toMatchObject({ id: c.id, rows_total: 3, rows_excluded: 0, format_version: '1.0', period_from: '2026-11-03', period_to: '2026-11-05', status: 'integre' });
    expect((await f1.snap()).movements.every((m) => m.import_batch_id === c.id && m.import_row)).toBe(true);
  });

  it('fichier non conforme refusé avec messages exploitables ; erreur bloquante = aucune écriture', async () => {
    const f = await foyer();
    const noCol = analyze(await f.snap(), readCsv('a.csv', 'compte;date_operation\nCPT-1;2026-11-01\n'), emptyDecisions());
    expect(noCol.blocking.map(issueText)).toContain('Ligne 1, colonne Montant signé : colonne obligatoire absente — attendu : en-tête « montant » en première ligne');
    const lines = Array.from({ length: 16 }, (_, i) => row(f, { identifiant_bancaire: `OK${i}` }));
    lines.push(row(f, { devise: 'USD' }));
    lines.push(row(f, { compte: 'Courant CHF', devise: 'EUR' }));
    lines.push(row(f, { montant: '1.234' }));
    lines.push(row(f, { date_operation: '03/11/26' }));
    lines.push(row(f, { rubrique: 'DEP.ALIM.COURSES', famille: 'Transport' }));
    lines.push(row(f, { nature: 'revenu_ordinaire' }));
    lines.push(row(f, { compte: 'Compte inconnu' }));
    const p = await run(f, csvOf(lines));
    const msgs = p.blocking.map(issueText);
    expect(msgs).toContain('Ligne 18, colonne Devise : « USD » : USD n’est pas compatible avec le compte Courant commun — attendu : EUR');
    expect(msgs).toContain('Ligne 19, colonne Devise : « EUR » : EUR n’est pas compatible avec le compte Courant CHF — attendu : CHF');
    expect(msgs.some((m) => m.startsWith('Ligne 20, colonne Montant signé : « 1.234 »'))).toBe(true);
    expect(msgs.some((m) => m.startsWith('Ligne 21, colonne Date d’opération : « 03/11/26 »'))).toBe(true);
    expect(msgs.some((m) => m.includes('Ligne 22, colonne Famille') && m.includes('famille incohérente'))).toBe(true);
    expect(msgs.some((m) => m.includes('Ligne 23, colonne Nature') && m.includes('incompatible'))).toBe(true);
    expect(msgs.some((m) => m.includes('Ligne 24, colonne Compte') && m.includes('compte inconnu'))).toBe(true);
    await expect(imports.commitImport(f.driver, await f.snap(), p, emptyDecisions(), { sha256: 'x' })).rejects.toThrow(/aucune écriture/);
    const s = await f.snap();
    expect(s.movements).toHaveLength(0);
    expect(s.importBatches).toHaveLength(0);
  });

  it('XLSX : feuille absente ou colonne en double refusées', async () => {
    const f = await foyer();
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('Feuil1').addRow(['x']);
    const p = analyze(await f.snap(), await readXlsx('b.xlsx', new Uint8Array((await wb.xlsx.writeBuffer()) as ArrayBuffer)), emptyDecisions());
    expect(p.blocking.map(issueText)[0]).toMatch(/Feuille Operations : feuille absente/);
    const dup = analyze(await f.snap(), readCsv('c.csv', ALL_KEYS.join(';') + ';montant\n'), emptyDecisions());
    expect(dup.blocking.map(issueText).join()).toMatch(/colonne en double/);
  });
});

describe('import : doublons et chevauchements', () => {
  it('réimport sans doublon ; deux opérations semblables conservées ; fichiers qui se chevauchent', async () => {
    const f = await foyer();
    const a = [row(f, { libelle_bancaire: 'CAFE' , montant: '-2,50' }), row(f, { libelle_bancaire: 'CAFE', montant: '-2,50' }), row(f, { date_operation: '2026-11-04', libelle_bancaire: 'BOULANGERIE' })];
    const first = await commit(f, csvOf(a));
    expect(first.p.counts.toImport).toBe(3); // deux cafés identiques : deux lignes conservées
    const again = await run(f, csvOf(a));
    expect(again.rows.map((r) => r.dup)).toEqual(['doublon_certain', 'doublon_certain', 'doublon_certain']);
    expect(again.counts.toImport).toBe(0);
    // un troisième café identique dans un fichier qui chevauche : 2 doublons + 1 nouvelle
    const b = [...a, row(f, { libelle_bancaire: 'CAFE', montant: '-2,50' }), row(f, { date_operation: '2026-11-06', libelle_bancaire: 'PHARMACIE' })];
    const p = await run(f, csvOf(b));
    expect(p.rows.map((r) => r.dup)).toEqual(['doublon_certain', 'doublon_certain', 'doublon_certain', 'nouvelle', 'nouvelle']);
    // doublon possible : même montant, date proche, libellé ressemblant → décision exigée
    const c = [row(f, { date_operation: '2026-11-05', libelle_bancaire: 'BOULANGERIE DU CENTRE' })];
    const pc = await run(f, csvOf(c));
    expect(pc.rows[0]!.dup).toBe('doublon_possible');
    expect(pc.blocking.map(issueText)[0]).toMatch(/doublon possible/);
    const keep = await commit(f, csvOf(c), { ...emptyDecisions(), keepDuplicate: { 2: true } });
    expect(keep.p.counts.toImport).toBe(1);
    // identifiant bancaire prioritaire
    const bank1 = await commit(f, csvOf([row(f, { identifiant_bancaire: 'TX9', date_operation: '2026-11-10', libelle_bancaire: 'X' })]));
    void bank1;
    const bank2 = await run(f, csvOf([row(f, { identifiant_bancaire: 'TX9', date_operation: '2026-11-11', libelle_bancaire: 'X modifié' })]));
    expect(bank2.rows[0]!.dup).toBe('doublon_certain');
    expect(bank2.rows[0]!.dupReason).toMatch(/identifiant bancaire/);
  });

  it('le nom du fichier n’est pas la protection : un fichier renommé est contrôlé ligne par ligne', async () => {
    const f = await foyer();
    await commit(f, csvOf([row(f)]), emptyDecisions(), 'nov.csv');
    const p = await run(f, csvOf([row(f)]), emptyDecisions(), 'autre-nom.csv');
    expect(p.rows[0]!.dup).toBe('doublon_certain');
  });
});

describe('import : correspondances, conflits, soldes de référence, transferts', () => {
  it('rubrique inconnue : association explicite, jamais de création en masse ; classement incertain présenté', async () => {
    const f = await foyer();
    const rows = [row(f, { rubrique: 'Fromagerie', famille: 'Alimentation', statut_classement: 'à vérifier' }), row(f, { rubrique: 'Fromagerie', famille: 'Alimentation', date_operation: '2026-11-07' }), row(f, { rubrique: '', nature: 'depense', libelle_bancaire: 'PRLV INCONNU' })];
    const p = await run(f, csvOf(rows));
    expect(p.unknownRubriques.map((u) => [u.raw, u.rows])).toEqual([['Fromagerie', [2, 3]], ['', [4]]]);
    expect(p.counts.toImport).toBe(0);
    const d: Decisions = { ...emptyDecisions(), rubriqueMap: { [p.unknownRubriques[0]!.key]: f.rub.courses, [p.unknownRubriques[1]!.key]: 'a_classer' } };
    const { p: p2 } = await commit(f, csvOf(rows), d);
    expect(p2.uncertain).toEqual([2]);
    const s = await f.snap();
    expect(s.rubriques.filter((r) => r.name === 'Fromagerie')).toHaveLength(0);
    expect([...s.movements].sort((a, b) => a.import_row! - b.import_row!).map((m) => [m.rubrique_id === f.rub.courses, m.nature])).toEqual([[true, 'depense'], [true, 'depense'], [false, 'a_classer']]);
    expect(s.movements.filter((m) => m.classification === 'a_verifier')).toHaveLength(1);
  });

  it('conflit avec un total mensuel : décision exigée, jamais de double compte', async () => {
    const f = await foyer();
    await mv.createTotal(f.driver, await f.snap(), { rubrique_id: f.rub.courses, period_month: '2026-11', amount_minor: -30000, currency: 'EUR', nature: 'depense' });
    const csv = csvOf([row(f, { montant: '-40' })]);
    const p = await run(f, csv);
    expect(p.coverageNeeded).toHaveLength(1);
    expect(p.blocking.map(issueText)[0]).toMatch(/a déjà un total mensuel/);
    await commit(f, csv, { ...emptyDecisions(), coverage: { [p.coverageNeeded[0]!.key]: 'total_remplace' } });
    const t = trackRubrique(buildCtx(await f.snap(), TODAY), f.rub.courses, '2026-11');
    expect(t.reel.value).toBe(30000);
  });

  it('opération antérieure ou égale à un solde constaté : signalée', async () => {
    const f = await foyer();
    const { p } = await commit(f, csvOf([row(f, { date_operation: '2026-10-31' })]));
    expect(p.warnings.map(issueText)[0]).toMatch(/antérieure ou égale au solde constaté du 31\/10\/2026/);
    expect((await f.snap()).importBatches[0]!.rows_flagged).toBe(1);
  });

  it('transfert EUR → CHF reconnu par sa référence', async () => {
    const f = await foyer();
    const t = { nature: 'transfert', famille: 'Mouvements techniques', rubrique: 'SYS.TECH.TRANSFERT', reference_transfert: 'T1' };
    await commit(f, csvOf([row(f, { ...t, montant: '-1000', libelle_bancaire: 'VIR' }), row(f, { ...t, compte: 'Courant CHF', devise: 'CHF', montant: '935', libelle_bancaire: 'VIR RECU' })]));
    const s = await f.snap();
    expect(s.transfers).toHaveLength(1);
    expect(s.movements.map((m) => m.transfer_role).sort()).toEqual(['entree', 'sortie']);
  });
});

describe('après l’import : sélection multiple et annulation', () => {
  it('reclassement multiple, incompatibilités expliquées, tracé', async () => {
    const f = await foyer();
    await commit(f, csvOf([row(f, { identifiant_bancaire: 'a' }), row(f, { identifiant_bancaire: 'b', montant: '5', nature: 'remboursement_depense' }), row(f, { identifiant_bancaire: 'c', nature: 'revenu_ordinaire', famille: '', rubrique: 'REV.AUTRES.DIVERS', montant: '10' })]));
    const ids = (await f.snap()).movements.map((m) => m.id);
    const pv = bulk.previewReclassify(await f.snap(), ids, f.rub.restaurants);
    expect(pv.compatible).toHaveLength(2);
    expect(pv.incompatible[0]!.reason).toMatch(/Revenu ordinaire.*n’est pas compatible.*Restaurants/);
    await bulk.reclassify(f.driver, await f.snap(), pv.compatible, f.rub.restaurants);
    const s = await f.snap();
    expect(s.movements.filter((m) => m.rubrique_id === f.rub.restaurants).map((m) => [m.amount_minor, m.nature])).toEqual([[-4210, 'depense'], [500, 'remboursement_depense']]);
    const log = await f.driver.query("SELECT COUNT(*) AS n FROM audit_log WHERE summary LIKE 'Reclassement groupé%'");
    expect(log[0]!.n).toBe(2);
  });

  it('suppression multiple avec dépendances ; annulation d’un lot simple', async () => {
    const f = await foyer();
    const ech = await eng.createScheduled(f.driver, await f.snap(), { label: 'Facture', due_date: '2026-11-03', amount_minor: -4210, currency: 'EUR', nature: 'depense', rubrique_id: f.rub.courses });
    const { id } = await commit(f, csvOf([row(f, { identifiant_bancaire: 'a' }), row(f, { identifiant_bancaire: 'b', date_operation: '2026-11-04' })]));
    const [m1, m2] = (await f.snap()).movements;
    await eng.reconcile(f.driver, await f.snap(), { movement_id: m1!.id, target_key: `ech:${ech}` }, TODAY);
    const ask = await mv.deleteMovements(f.driver, await f.snap(), [m1!.id, m2!.id], { confirmed: false });
    expect('deps' in ask && ask.deps.consequences.join()).toMatch(/1 rapprochement/);
    // annulation du lot entier
    const a = await imports.analyzeCancel(f.driver, await f.snap(), id);
    expect(a.modified).toEqual([]);
    expect(a.consequences.join(' ')).toMatch(/2 opération\(s\) du lot/);
    const r = await imports.cancelBatch(f.driver, await f.snap(), a, { keepModified: true });
    expect(r).toEqual({ deleted: 2, kept: 0 });
    const s = await f.snap();
    expect(s.movements).toHaveLength(0);
    expect(s.reconciliations).toHaveLength(0);
    expect(s.importBatches[0]!.status).toBe('annule');
    // les lignes de provenance restent consultables
    expect(await f.driver.query('SELECT COUNT(*) AS n FROM import_row WHERE batch_id = ?', [id])).toEqual([{ n: 2 }]);
  });

  it('annulation d’un lot modifié ensuite : conséquences présentées, données modifiées conservées sur demande', async () => {
    const f = await foyer();
    const { id } = await commit(f, csvOf([row(f, { identifiant_bancaire: 'a' }), row(f, { identifiant_bancaire: 'b', date_operation: '2026-11-04' })]));
    await new Promise((r) => setTimeout(r, 5));
    const target = (await f.snap()).movements[1]!;
    await mv.updateOperation(f.driver, await f.snap(), target.id, { comment: 'vérifié avec le ticket' });
    const a = await imports.analyzeCancel(f.driver, await f.snap(), id);
    expect(a.modified).toEqual([target.id]);
    expect(a.consequences.join(' ')).toMatch(/modifiées depuis l’import/);
    const r = await imports.cancelBatch(f.driver, await f.snap(), a, { keepModified: true });
    expect(r).toEqual({ deleted: 1, kept: 1 });
    expect((await f.snap()).movements.map((m) => m.comment)).toEqual(['vérifié avec le ticket']);
  });
});
