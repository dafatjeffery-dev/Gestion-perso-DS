// Lecture d'un fichier d'import (CSV ou XLSX) vers une table brute commune, avec les
// contrôles de structure. Aucune interprétation des valeurs ici.

import ExcelJS from 'exceljs';
import { ALL_KEYS, COLUMNS, FORMAT_VERSION, REQUIRED_KEYS, SHEET_NOTICE, SHEET_OPERATIONS, type ColumnKey } from './format';

export interface Issue {
  level: 'bloquant' | 'avertissement' | 'info';
  file: string;
  sheet?: string;
  row?: number;
  column?: ColumnKey | string;
  value?: string;
  reason: string;
  expected?: string;
}

export function issueText(i: Issue): string {
  const where = [i.sheet && i.sheet !== 'CSV' ? `Feuille ${i.sheet}` : null, i.row ? `Ligne ${i.row}` : null, i.column ? `colonne ${COLUMNS.find((c) => c.key === i.column)?.label ?? i.column}` : null].filter(Boolean).join(', ');
  const v = i.value !== undefined && i.value !== '' ? `« ${i.value} » : ` : '';
  return `${where ? `${where} : ` : ''}${v}${i.reason}${i.expected ? ` — attendu : ${i.expected}` : ''}`;
}

export interface RawRow {
  rowNo: number;
  cells: Partial<Record<ColumnKey, unknown>>;
}

export interface RawTable {
  kind: 'csv' | 'xlsx';
  fileName: string;
  sheet: string;
  rows: RawRow[];
  issues: Issue[];
  formatVersion: string;
}

function structure(fileName: string, sheet: string, headers: string[], issues: Issue[]): Map<number, ColumnKey> {
  const map = new Map<number, ColumnKey>();
  const seen = new Map<string, number>();
  headers.forEach((h, idx) => {
    const key = h.trim().replace(/^﻿/, '').toLowerCase();
    if (!key) return;
    if (seen.has(key)) {
      issues.push({ level: 'bloquant', file: fileName, sheet, row: 1, column: key, reason: `colonne en double (colonnes ${seen.get(key)! + 1} et ${idx + 1})`, expected: 'chaque colonne une seule fois' });
      return;
    }
    seen.set(key, idx);
    if ((ALL_KEYS as string[]).includes(key)) map.set(idx, key as ColumnKey);
    else issues.push({ level: 'avertissement', file: fileName, sheet, row: 1, column: key, reason: 'colonne inconnue, ignorée', expected: `l’une des colonnes du format ${FORMAT_VERSION}` });
  });
  for (const k of REQUIRED_KEYS) {
    if (![...map.values()].includes(k)) issues.push({ level: 'bloquant', file: fileName, sheet, row: 1, column: k, reason: 'colonne obligatoire absente', expected: `en-tête « ${k} » en première ligne` });
  }
  return map;
}

/** CSV RFC 4180, séparateur ; (ou , ou tabulation détectés sur l'en-tête). */
export function parseCsvText(text: string): string[][] {
  const t = text.replace(/^﻿/, '');
  const firstLine = t.split(/\r?\n/, 1)[0] ?? '';
  const sep = firstLine.includes(';') ? ';' : firstLine.includes('\t') ? '\t' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i]!;
    if (q) {
      if (c === '"') {
        if (t[i + 1] === '"') {
          cell += '"';
          i++;
        } else q = false;
      } else cell += c;
    } else if (c === '"' && cell === '') q = true;
    else if (c === sep) {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && t[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

export function readCsv(fileName: string, text: string): RawTable {
  const issues: Issue[] = [];
  const all = parseCsvText(text);
  if (all.length === 0 || all.every((r) => r.every((c) => c.trim() === ''))) {
    issues.push({ level: 'bloquant', file: fileName, reason: 'fichier vide' });
    return { kind: 'csv', fileName, sheet: 'CSV', rows: [], issues, formatVersion: FORMAT_VERSION };
  }
  const map = structure(fileName, 'CSV', all[0]!, issues);
  const rows: RawRow[] = [];
  all.slice(1).forEach((r, i) => {
    if (r.every((c) => c.trim() === '')) return;
    const cells: RawRow['cells'] = {};
    for (const [idx, key] of map) cells[key] = r[idx] ?? '';
    rows.push({ rowNo: i + 2, cells });
  });
  return { kind: 'csv', fileName, sheet: 'CSV', rows, issues, formatVersion: FORMAT_VERSION };
}

function cellValue(v: ExcelJS.CellValue, issues: Issue[], fileName: string, row: number, column: string): unknown {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    if ('formula' in v || 'sharedFormula' in v) {
      issues.push({ level: 'bloquant', file: fileName, sheet: SHEET_OPERATIONS, row, column, reason: 'formule refusée', expected: 'une valeur saisie (le modèle ne contient aucune formule)' });
      return '';
    }
    if ('richText' in v) return v.richText.map((x) => x.text).join('');
    if ('hyperlink' in v) return (v as { text?: string }).text ?? '';
    if ('error' in v) return '';
  }
  return v;
}

export async function readXlsx(fileName: string, data: ArrayBuffer | Uint8Array): Promise<RawTable> {
  const issues: Issue[] = [];
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(data instanceof Uint8Array ? (data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer) : data);
  } catch {
    issues.push({ level: 'bloquant', file: fileName, reason: 'fichier Excel illisible', expected: 'un fichier .xlsx (le format .xls et les fichiers protégés ne sont pas lus)' });
    return { kind: 'xlsx', fileName, sheet: SHEET_OPERATIONS, rows: [], issues, formatVersion: FORMAT_VERSION };
  }
  const sheets = wb.worksheets.filter((w) => w.name.trim().toLowerCase() === SHEET_OPERATIONS.toLowerCase());
  if (sheets.length !== 1) {
    issues.push({ level: 'bloquant', file: fileName, sheet: SHEET_OPERATIONS, reason: sheets.length ? 'feuille présente plusieurs fois' : 'feuille absente', expected: `une feuille nommée « ${SHEET_OPERATIONS} » contenant les opérations` });
    return { kind: 'xlsx', fileName, sheet: SHEET_OPERATIONS, rows: [], issues, formatVersion: FORMAT_VERSION };
  }
  const notice = wb.getWorksheet(SHEET_NOTICE);
  let version = FORMAT_VERSION;
  if (notice) {
    const v = String(notice.getCell('B1').value ?? '').trim();
    if (v && v !== FORMAT_VERSION) {
      issues.push({ level: 'bloquant', file: fileName, sheet: SHEET_NOTICE, value: v, reason: `version du format différente de celle de l’application (${FORMAT_VERSION})`, expected: 'téléchargez le modèle à jour' });
      version = v;
    }
  }
  const ws = sheets[0]!;
  const headerRow = ws.getRow(1);
  const headers: string[] = [];
  headerRow.eachCell({ includeEmpty: true }, (c, col) => {
    headers[col - 1] = String(c.value ?? '');
  });
  const map = structure(fileName, SHEET_OPERATIONS, headers, issues);
  const rows: RawRow[] = [];
  ws.eachRow({ includeEmpty: false }, (r, rowNo) => {
    if (rowNo === 1) return;
    const cells: RawRow['cells'] = {};
    let any = false;
    for (const [idx, key] of map) {
      const v = cellValue(r.getCell(idx + 1).value, issues, fileName, rowNo, key);
      cells[key] = v;
      if (v !== '' && v !== null) any = true;
    }
    if (any) rows.push({ rowNo, cells });
  });
  return { kind: 'xlsx', fileName, sheet: SHEET_OPERATIONS, rows, issues, formatVersion: version };
}
