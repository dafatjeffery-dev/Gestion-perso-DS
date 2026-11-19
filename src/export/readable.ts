// Exports lisibles (CSV et XLSX) : opérations, totaux mensuels, budgets, crédits.
// Contenu exact et omissions : docs/GUIDE_UTILISATEUR.md § « Exports ».

import ExcelJS from 'exceljs';
import type { Snapshot } from '../domain/types';
import { buildCtx } from '../engine/context';
import { installmentsOf } from '../engine/loans';

type Table = { name: string; headers: string[]; rows: (string | number | null)[][] };

const amount = (minor: number) => (minor / 100).toFixed(2).replace('.', ',');
const rubLabel = (s: Snapshot, id: number) => {
  const r = s.rubriques.find((x) => x.id === id)!;
  return [s.families.find((f) => f.id === r.family_id)!.name, r.name, r.ref];
};

export function readableTables(snap: Snapshot, today: string): Table[] {
  const acc = (id: number | null) => snap.accounts.find((a) => a.id === id)?.name ?? '';
  const ops: Table = {
    name: 'Operations',
    headers: ['Date', 'Date de valeur', 'Compte', 'Libellé bancaire original', 'Libellé simplifié', 'Montant', 'Devise', 'Nature', 'Famille', 'Rubrique', 'Référence rubrique', 'Statut', 'Commentaire', 'Transfert', 'Lot d’import', 'Identifiant bancaire'],
    rows: snap.movements.filter((m) => m.granularity === 'operation').map((m) => [m.op_date, m.value_date, acc(m.account_id), m.label_original, m.label_simple, amount(m.amount_minor), m.currency, m.nature, ...rubLabel(snap, m.rubrique_id), m.classification === 'a_verifier' ? 'à vérifier' : 'confirmé', m.comment, m.transfer_id ? `T${m.transfer_id} (${m.transfer_role})` : '', m.import_batch_id, m.bank_id]),
  };
  const totals: Table = {
    name: 'Totaux',
    headers: ['Mois', 'Famille', 'Rubrique', 'Référence rubrique', 'Montant', 'Devise', 'Nature', 'Règle de couverture', 'Commentaire'],
    rows: snap.movements.filter((m) => m.granularity === 'total').map((m) => [m.period_month, ...rubLabel(snap, m.rubrique_id), amount(m.amount_minor), m.currency, m.nature, snap.coverage.find((c) => c.rubrique_id === m.rubrique_id && c.period_month === m.period_month)?.mode ?? '', m.comment]),
  };
  const budgets: Table = {
    name: 'Budgets',
    headers: ['Type', 'Famille', 'Rubrique', 'Référence rubrique', 'Du mois', 'Au mois', 'Budget initial', 'Budget actualisé', 'Devise'],
    rows: [
      ...snap.budgetPlans.map((b) => ['plan mensuel', ...rubLabel(snap, b.rubrique_id), b.valid_from_month, b.valid_to_month, amount(b.monthly_minor), null, b.currency]),
      ...snap.budgetMonths.map((b) => ['mois', ...rubLabel(snap, b.rubrique_id), b.period_month, b.period_month, amount(b.initial_minor), b.actualise_minor === null ? null : amount(b.actualise_minor), b.currency]),
    ],
  };
  const ctx = buildCtx(snap, today);
  const credits: Table = {
    name: 'Credits',
    headers: ['Crédit', 'Mode', 'Statut', 'N°', 'Date', 'Capital', 'Intérêts', 'Assurance', 'Frais', 'Total', 'Capital restant dû', 'Origine', 'Devise'],
    rows: snap.loans.flatMap((l) => installmentsOf(ctx, l).map((i) => [l.label, l.mode, l.status, i.seq, i.due_date, amount(i.principal_minor), amount(i.interest_minor), amount(i.insurance_minor), amount(i.fees_minor), amount(i.total_minor), amount(i.crd_after_minor), i.origin === 'banque' ? 'banque' : i.origin === 'calcule' ? 'calculé' : i.unventilated ? 'estimé (non ventilé)' : 'estimé', l.currency])),
  };
  return [ops, totals, budgets, credits];
}

export function toCsv(t: Table): string {
  const esc = (v: string | number | null) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + [t.headers, ...t.rows].map((r) => r.map(esc).join(';')).join('\r\n') + '\r\n';
}

export async function toXlsx(tables: Table[]): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'DS Finances';
  for (const t of tables) {
    const ws = wb.addWorksheet(t.name);
    ws.addRow(t.headers).font = { bold: true };
    for (const r of t.rows) ws.addRow(r);
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    ws.columns.forEach((c) => (c.width = 16));
  }
  return new Uint8Array((await wb.xlsx.writeBuffer()) as ArrayBuffer);
}
