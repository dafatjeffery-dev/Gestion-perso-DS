// Génération du modèle d'import (XLSX et CSV) à partir de la définition unique du format.
// Aucune macro, formule ni lien externe ; ni solde, ni IBAN.

import ExcelJS from 'exceljs';
import type { Snapshot } from '../domain/types';
import { ALL_KEYS, COLUMNS, CSV_SEPARATOR, EXAMPLE_ROWS, FORMAT_VERSION, NOTICE_LINES, SHEET_EXAMPLES, SHEET_NOTICE, SHEET_OPERATIONS, SHEET_REFERENTIALS, accountCode } from './format';

export function csvTemplate(): string {
  return '﻿' + ALL_KEYS.join(CSV_SEPARATOR) + '\r\n';
}

export async function xlsxTemplate(snap: Snapshot): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'DS Finances';
  wb.title = `Modèle d’import ${FORMAT_VERSION}`;
  const ops = wb.addWorksheet(SHEET_OPERATIONS);
  ops.addRow([...ALL_KEYS]);
  ops.getRow(1).font = { bold: true };
  ops.columns.forEach((c, i) => {
    c.width = Math.max(14, COLUMNS[i]!.label.length + 4);
  });
  ops.views = [{ state: 'frozen', ySplit: 1 }];

  const notice = wb.addWorksheet(SHEET_NOTICE);
  notice.addRow(['Version du format', FORMAT_VERSION]);
  notice.addRow([]);
  for (const l of NOTICE_LINES) notice.addRow([l]);
  notice.addRow([]);
  notice.addRow(['Colonne', 'Libellé', 'Obligatoire', 'Contenu attendu', 'Exemple']).font = { bold: true };
  for (const c of COLUMNS) notice.addRow([c.key, c.label, c.required ? 'oui' : 'non', c.description, c.example]);
  notice.getColumn(1).width = 24;
  notice.getColumn(4).width = 90;

  const ex = wb.addWorksheet(SHEET_EXAMPLES);
  ex.addRow(['EXEMPLES FICTIFS — NE PAS IMPORTER']).font = { bold: true, color: { argb: 'FFA8432F' } };
  ex.addRow([...ALL_KEYS]).font = { bold: true };
  for (const r of EXAMPLE_ROWS) ex.addRow(ALL_KEYS.map((k) => r[k]));

  const ref = wb.addWorksheet(SHEET_REFERENTIALS);
  ref.addRow(['COMPTES']).font = { bold: true };
  ref.addRow(['Référence', 'Nom', 'Devise', 'Type', 'Statut']).font = { bold: true };
  for (const a of snap.accounts) ref.addRow([accountCode(a.id), a.name, a.currency, a.type, a.status === 'actif' ? 'actif' : 'archivé']);
  ref.addRow([]);
  ref.addRow(['NATURES']).font = { bold: true };
  ref.addRow(['Code', 'Libellé']).font = { bold: true };
  for (const n of snap.natures) ref.addRow([n.code, n.label]);
  ref.addRow([]);
  ref.addRow(['RUBRIQUES']).font = { bold: true };
  ref.addRow(['Référence', 'Famille', 'Rubrique', 'Sens', 'Natures compatibles', 'Disponible']).font = { bold: true };
  const natByDir: Record<string, string> = {
    revenu: 'revenu_ordinaire, revenu_exceptionnel',
    depense: 'depense, remboursement_depense, cout_credit, frais_transfert',
    technique: 'transfert, emprunt_recu, capital_credit, epargne, a_classer',
  };
  for (const r of snap.rubriques) {
    const f = snap.families.find((x) => x.id === r.family_id)!;
    ref.addRow([r.ref, f.name, r.name, f.direction, natByDir[f.direction], r.available_for_entry ? 'oui' : 'non']);
  }
  ref.getColumn(1).width = 30;
  ref.getColumn(2).width = 24;
  ref.getColumn(3).width = 26;
  ref.getColumn(5).width = 52;
  const buf = await wb.xlsx.writeBuffer();
  return new Uint8Array(buf as ArrayBuffer);
}
