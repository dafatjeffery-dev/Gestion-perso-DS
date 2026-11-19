// Contrôles d'un import : lignes, correspondances, doublons, conflits, récapitulatif.
// Fonction pure : (référentiels + table brute + décisions de l'utilisateur) → aperçu.

import { daysBetween, formatDateFr, formatMonthFr, monthOf, parseDate } from '../domain/dates';
import { parseAmount } from '../domain/money';
import type { CoverageMode, Currency, IsoDate, Movement, NatureCode, Rubrique, Snapshot } from '../domain/types';
import { accountCode, STATUS_VALUES } from './format';
import type { Issue, RawTable } from './read';

export interface Decisions {
  /** Rubrique inconnue (texte normalisé) → rubrique existante ou « À classer ». */
  rubriqueMap: Record<string, number | 'a_classer'>;
  /** Décision par ligne pour les doublons : true = importer quand même. */
  keepDuplicate: Record<number, boolean>;
  /** Couverture total / détail : clé `${rubrique_id}|${mois}`. */
  coverage: Record<string, CoverageMode>;
}

export const emptyDecisions = (): Decisions => ({ rubriqueMap: {}, keepDuplicate: {}, coverage: {} });

export interface Candidate {
  rowNo: number;
  account_id: number;
  currency: Currency;
  op_date: IsoDate;
  value_date: IsoDate | null;
  amount_minor: number;
  nature: NatureCode;
  rubrique_id: number;
  label_original: string;
  label_simple: string | null;
  bank_id: string | null;
  comment: string;
  classification: 'a_verifier' | 'confirme';
  transfer_ref: string | null;
}

export type DupStatus = 'nouvelle' | 'doublon_certain' | 'doublon_possible';

export interface RowResult {
  rowNo: number;
  raw: Record<string, unknown>;
  candidate: Candidate | null;
  issues: Issue[];
  dup: DupStatus;
  dupOf: Movement | null;
  dupReason: string | null;
  /** Ligne importée si l'utilisateur confirme. */
  willImport: boolean;
}

export interface Preview {
  fileName: string;
  kind: 'csv' | 'xlsx';
  formatVersion: string;
  rows: RowResult[];
  blocking: Issue[];
  warnings: Issue[];
  unknownRubriques: { key: string; raw: string; family: string; rows: number[]; nature: string }[];
  coverageNeeded: { key: string; rubrique_id: number; month: string; rows: number[]; totals: number }[];
  transfers: { ref: string; rows: [number, number] }[];
  uncertain: number[];
  accounts: number[];
  period: { from: IsoDate; to: IsoDate } | null;
  counts: { total: number; toImport: number; excluded: number; flagged: number; certain: number; possible: number };
}

const DIR_NATURES: Record<string, NatureCode[]> = {
  revenu: ['revenu_ordinaire', 'revenu_exceptionnel'],
  depense: ['depense', 'remboursement_depense', 'cout_credit', 'frais_transfert'],
  technique: ['transfert', 'emprunt_recu', 'capital_credit', 'epargne', 'a_classer'],
};

export const normKey = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
export const normLabel = (s: string) => normKey(s).replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const text = (v: unknown) => (v === null || v === undefined ? '' : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).trim());

function similarity(a: string, b: string): number {
  const ta = new Set(normLabel(a).split(' ').filter((x) => x.length > 2));
  const tb = new Set(normLabel(b).split(' ').filter((x) => x.length > 2));
  if (!ta.size || !tb.size) return 0;
  let n = 0;
  for (const t of ta) if (tb.has(t)) n++;
  return n / Math.min(ta.size, tb.size);
}

function resolveRubrique(snap: Snapshot, raw: string, familyRaw: string): Rubrique | null {
  const k = normKey(raw);
  if (!k) return null;
  const byRef = snap.rubriques.find((r) => r.ref.toLowerCase() === k);
  if (byRef) return byRef;
  const cands = snap.rubriques.filter((r) => normKey(r.name) === k);
  if (familyRaw) {
    const f = snap.families.find((x) => normKey(x.name) === normKey(familyRaw));
    const c = cands.find((r) => r.family_id === f?.id);
    if (c) return c;
  }
  return cands.length === 1 ? cands[0]! : null;
}

export function analyze(snap: Snapshot, table: RawTable, decisions: Decisions, opts: { previousSha?: { sha: string; date: string } | null } = {}): Preview {
  const file = table.fileName;
  const sheet = table.sheet;
  const blocking: Issue[] = table.issues.filter((i) => i.level === 'bloquant');
  const warnings: Issue[] = table.issues.filter((i) => i.level !== 'bloquant');
  if (opts.previousSha) warnings.push({ level: 'avertissement', file, reason: `un fichier identique a déjà été importé le ${formatDateFr(opts.previousSha.date.slice(0, 10))} ; les doublons sont contrôlés ligne par ligne` });
  const aClasser = snap.rubriques.find((r) => r.ref === 'SYS.TECH.A_CLASSER')!;
  const unknown = new Map<string, Preview['unknownRubriques'][number]>();
  const rows: RowResult[] = [];
  const seenBank = new Map<string, number>();

  for (const r of table.rows) {
    const c = r.cells;
    const issues: Issue[] = [];
    const err = (column: string, value: unknown, reason: string, expected?: string) => issues.push({ level: 'bloquant', file, sheet, row: r.rowNo, column, value: text(value), reason, expected });
    const warn = (column: string | undefined, value: unknown, reason: string) => issues.push({ level: 'avertissement', file, sheet, row: r.rowNo, column, value: text(value), reason });
    const accRaw = text(c.compte);
    const acc = snap.accounts.find((a) => accountCode(a.id).toLowerCase() === accRaw.toLowerCase()) ?? snap.accounts.find((a) => normKey(a.name) === normKey(accRaw));
    if (!accRaw) err('compte', '', 'ligne incomplète : compte absent', 'une référence CPT-n ou un nom de compte');
    else if (!acc) err('compte', accRaw, 'compte inconnu', 'une référence CPT-n ou un nom exact de la feuille Referentiels');
    else if (acc.status === 'archive') err('compte', accRaw, `le compte « ${acc.name} » est archivé`, 'réactivez-le avant l’import ou choisissez un autre compte');
    const d = parseDate(c.date_operation);
    if (!d.ok) err('date_operation', c.date_operation, d.reason, d.expected);
    const vdRaw = text(c.date_valeur);
    const vd = vdRaw ? parseDate(c.date_valeur) : null;
    if (vd && !vd.ok) err('date_valeur', c.date_valeur, vd.reason, vd.expected);
    const amt = parseAmount(typeof c.montant === 'number' ? c.montant : text(c.montant));
    if (!amt.ok) err('montant', c.montant, amt.reason, amt.expected);
    const cur = text(c.devise).toUpperCase();
    if (!cur) err('devise', '', 'ligne incomplète : devise absente', 'EUR ou CHF');
    else if (acc && cur !== acc.currency) err('devise', cur, `${cur} n’est pas compatible avec le compte ${acc.name}`, acc.currency);
    const label = text(c.libelle_bancaire);
    if (!label) err('libelle_bancaire', '', 'ligne incomplète : libellé bancaire absent', 'le libellé exact du relevé');
    const natureRaw = text(c.nature).toLowerCase();
    const nature = snap.natures.find((n) => n.code === natureRaw || normKey(n.label) === normKey(natureRaw))?.code;
    if (!natureRaw) err('nature', '', 'ligne incomplète : nature absente', 'un code de la feuille Referentiels');
    else if (!nature) err('nature', natureRaw, 'nature inconnue', 'un code de la feuille Referentiels (ex. depense)');
    const statusRaw = normKey(text(c.statut_classement));
    const classification = STATUS_VALUES[statusRaw] ?? STATUS_VALUES[text(c.statut_classement).toLowerCase()];
    if (!classification) err('statut_classement', c.statut_classement, 'statut inconnu', '« à vérifier » ou « confirmé »');
    // rubrique
    const rubRaw = text(c.rubrique);
    const famRaw = text(c.famille);
    let rub = resolveRubrique(snap, rubRaw, famRaw);
    let finalNature = nature;
    if (!rub) {
      if (!rubRaw && nature === 'a_classer') rub = aClasser;
      else {
        const key = `${normKey(rubRaw)}|${normKey(famRaw)}`;
        const mapped = decisions.rubriqueMap[key];
        if (mapped === 'a_classer') {
          rub = aClasser;
          finalNature = 'a_classer';
        } else if (mapped) rub = snap.rubriques.find((x) => x.id === mapped) ?? null;
        if (!rub) {
          const u = unknown.get(key) ?? { key, raw: rubRaw, family: famRaw, rows: [], nature: natureRaw };
          u.rows.push(r.rowNo);
          unknown.set(key, u);
          err('rubrique', rubRaw || '(vide)', rubRaw ? 'rubrique inconnue' : 'rubrique vide avec une nature autre que « a_classer »', 'associez-la à une rubrique existante ou à « À classer » (étape Correspondances)');
        }
      }
    }
    if (rub && famRaw && !mappedOrSys(rub, decisions)) {
      const fam = snap.families.find((x) => x.id === rub!.family_id)!;
      if (normKey(fam.name) !== normKey(famRaw)) err('famille', famRaw, `famille incohérente avec la rubrique « ${rub.name} » (famille « ${fam.name} »)`, fam.name);
    }
    if (rub && finalNature) {
      const fam = snap.families.find((x) => x.id === rub!.family_id)!;
      if (!DIR_NATURES[fam.direction]!.includes(finalNature)) err('nature', finalNature, `nature incompatible avec la rubrique « ${rub.name} »`, DIR_NATURES[fam.direction]!.join(', '));
      if (!rub.available_for_entry && rub.id !== aClasser.id) err('rubrique', rubRaw, `la rubrique « ${rub.name} » n’est plus proposée pour de nouvelles saisies`, 'une rubrique disponible');
    }
    const bank = text(c.identifiant_bancaire) || null;
    if (bank && acc) {
      const k = `${acc.id}|${bank}`;
      if (seenBank.has(k)) err('identifiant_bancaire', bank, `identifiant bancaire en double dans le fichier (ligne ${seenBank.get(k)})`, 'un identifiant par opération');
      else seenBank.set(k, r.rowNo);
    }
    let candidate: Candidate | null = null;
    if (!issues.some((i) => i.level === 'bloquant') && acc && d.ok && amt.ok && rub && finalNature && classification) {
      candidate = {
        rowNo: r.rowNo,
        account_id: acc.id,
        currency: acc.currency,
        op_date: d.value,
        value_date: vd && vd.ok ? vd.value : null,
        amount_minor: amt.value,
        nature: finalNature,
        rubrique_id: rub.id,
        label_original: label,
        label_simple: text(c.libelle_simplifie) || null,
        bank_id: bank,
        comment: text(c.commentaire),
        classification,
        transfer_ref: text(c.reference_transfert) || null,
      };
      const ref = snap.balanceRefs.filter((b) => b.account_id === acc.id && b.ref_date >= d.value).sort((a, b) => (a.ref_date < b.ref_date ? -1 : 1))[0];
      if (ref) warn('date_operation', d.value, `antérieure ou égale au solde constaté du ${formatDateFr(ref.ref_date)} de « ${acc.name} » : ce solde l’inclut déjà, elle ne le modifiera pas`);
      if (amt.value === 0) warn('montant', c.montant, 'montant nul');
    }
    rows.push({ rowNo: r.rowNo, raw: c, candidate, issues, dup: 'nouvelle', dupOf: null, dupReason: null, willImport: false });
  }

  // doublons : identifiant bancaire, puis appariement par multiensemble, puis ressemblance
  const existing = snap.movements.filter((m) => m.granularity === 'operation');
  const used = new Set<number>();
  for (const row of rows) {
    const c = row.candidate;
    if (!c?.bank_id) continue;
    const m = existing.find((x) => x.account_id === c.account_id && x.bank_id === c.bank_id);
    if (m) {
      row.dup = 'doublon_certain';
      row.dupOf = m;
      row.dupReason = `même identifiant bancaire que l’opération du ${formatDateFr(m.op_date!)}`;
      used.add(m.id);
    }
  }
  const key = (acc: number, date: string, amount: number, label: string) => `${acc}|${date}|${amount}|${normLabel(label)}`;
  const pool = new Map<string, Movement[]>();
  for (const m of existing) {
    if (used.has(m.id)) continue;
    const k = key(m.account_id!, m.op_date!, m.amount_minor, m.label_original ?? '');
    pool.set(k, [...(pool.get(k) ?? []), m]);
  }
  for (const row of rows) {
    const c = row.candidate;
    if (!c || row.dup !== 'nouvelle') continue;
    if (c.bank_id && existing.some((x) => x.account_id === c.account_id && x.bank_id && x.bank_id !== c.bank_id && x.op_date === c.op_date && x.amount_minor === c.amount_minor)) continue; // identifiants différents : opérations distinctes
    const list = pool.get(key(c.account_id, c.op_date, c.amount_minor, c.label_original));
    if (list?.length) {
      const m = list.shift()!;
      used.add(m.id);
      row.dup = 'doublon_certain';
      row.dupOf = m;
      row.dupReason = `même compte, date, montant et libellé qu’une opération déjà enregistrée${m.import_batch_id ? ` (lot n° ${m.import_batch_id})` : ''}`;
    }
  }
  for (const row of rows) {
    const c = row.candidate;
    if (!c || row.dup !== 'nouvelle') continue;
    const near = existing.find((m) => !used.has(m.id) && m.account_id === c.account_id && m.amount_minor === c.amount_minor && Math.abs(daysBetween(m.op_date!, c.op_date)) <= 3 && (similarity(m.label_original ?? m.label_simple ?? '', c.label_original) >= 0.5 || m.op_date === c.op_date));
    if (near) {
      row.dup = 'doublon_possible';
      row.dupOf = near;
      row.dupReason = `ressemble à l’opération du ${formatDateFr(near.op_date!)} « ${near.label_original ?? near.label_simple ?? ''} » (même montant)`;
    }
  }
  for (const row of rows) {
    if (!row.candidate) continue;
    if (row.dup === 'nouvelle') row.willImport = true;
    else if (row.dup === 'doublon_certain') row.willImport = decisions.keepDuplicate[row.rowNo] === true;
    else {
      const d = decisions.keepDuplicate[row.rowNo];
      if (d === undefined) row.issues.push({ level: 'bloquant', file, sheet, row: row.rowNo, reason: `doublon possible : ${row.dupReason}`, expected: 'choisissez « importer » ou « ne pas importer »' });
      row.willImport = d === true;
    }
  }

  // transferts
  const byRef = new Map<string, RowResult[]>();
  for (const row of rows) if (row.candidate?.transfer_ref && row.willImport) byRef.set(row.candidate.transfer_ref, [...(byRef.get(row.candidate.transfer_ref) ?? []), row]);
  const transfers: Preview['transfers'] = [];
  for (const [ref, rs] of byRef) {
    const [a, b] = rs;
    const ok = rs.length === 2 && a!.candidate!.account_id !== b!.candidate!.account_id && Math.sign(a!.candidate!.amount_minor) === -Math.sign(b!.candidate!.amount_minor) && a!.candidate!.nature === 'transfert' && b!.candidate!.nature === 'transfert';
    if (ok) transfers.push({ ref, rows: [a!.rowNo, b!.rowNo] });
    else for (const r of rs) r.issues.push({ level: 'avertissement', file, sheet, row: r.rowNo, column: 'reference_transfert', value: ref, reason: 'référence de transfert sans seconde ligne cohérente (autre compte, signe opposé, nature transfert) : importée comme opération simple' });
  }

  // couverture total / détail
  const coverageNeeded = new Map<string, Preview['coverageNeeded'][number]>();
  for (const row of rows) {
    const c = row.candidate;
    if (!c || !row.willImport) continue;
    const month = monthOf(c.op_date);
    const k = `${c.rubrique_id}|${month}`;
    const totals = snap.movements.filter((m) => m.granularity === 'total' && m.rubrique_id === c.rubrique_id && m.period_month === month).length;
    const decided = snap.coverage.some((x) => x.rubrique_id === c.rubrique_id && x.period_month === month);
    if (totals && !decided) {
      const e = coverageNeeded.get(k) ?? { key: k, rubrique_id: c.rubrique_id, month, rows: [], totals };
      e.rows.push(row.rowNo);
      coverageNeeded.set(k, e);
    }
  }
  for (const e of coverageNeeded.values()) {
    if (!decisions.coverage[e.key]) {
      const r = snap.rubriques.find((x) => x.id === e.rubrique_id)!;
      blocking.push({ level: 'bloquant', file, reason: `« ${r.name} » en ${formatMonthFr(e.month)} a déjà un total mensuel : choisissez comment compter ce total et les ${e.rows.length} opération(s) importée(s)`, expected: 'le total remplace, le détail remplace, ou le total devient un complément' });
    }
  }

  for (const row of rows) for (const i of row.issues) (i.level === 'bloquant' ? blocking : warnings).push(i);
  const imported = rows.filter((r) => r.willImport && r.candidate);
  const dates = imported.map((r) => r.candidate!.op_date).sort();
  return {
    fileName: file,
    kind: table.kind,
    formatVersion: table.formatVersion,
    rows,
    blocking,
    warnings,
    unknownRubriques: [...unknown.values()],
    coverageNeeded: [...coverageNeeded.values()],
    transfers,
    uncertain: imported.filter((r) => r.candidate!.classification === 'a_verifier').map((r) => r.rowNo),
    accounts: [...new Set(imported.map((r) => r.candidate!.account_id))],
    period: dates.length ? { from: dates[0]!, to: dates[dates.length - 1]! } : null,
    counts: {
      total: rows.length,
      toImport: imported.length,
      excluded: rows.length - imported.length,
      flagged: imported.filter((r) => r.issues.some((i) => i.level === 'avertissement')).length,
      certain: rows.filter((r) => r.dup === 'doublon_certain').length,
      possible: rows.filter((r) => r.dup === 'doublon_possible').length,
    },
  };
}

function mappedOrSys(r: Rubrique, d: Decisions): boolean {
  return r.ref === 'SYS.TECH.A_CLASSER' || Object.values(d.rubriqueMap).includes(r.id);
}
