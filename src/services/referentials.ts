// Référentiels : foyer, personnes, comptes, soldes de référence, familles, rubriques, taux.
// Chaque fonction valide, construit un plan atomique journalisé et l'exécute.

import { isValidIsoDate, formatDateFr } from '../domain/dates';
import type {
  Account,
  AccountType,
  Currency,
  Direction,
  Family,
  IsoDate,
  Owner,
  Rubrique,
  Snapshot,
  Tracking,
} from '../domain/types';
import { CURRENCIES } from '../domain/types';
import { parseRate, formatRate } from '../engine/fx';
import type { Driver } from '../storage/driver';
import { Plan, ValidationError, fail, type FieldError } from './plan';

const OWNERS: Owner[] = ['A', 'B', 'commun'];
const TYPES: AccountType[] = ['courant', 'epargne', 'investissement'];

function byId<T extends { id: number }>(list: T[], id: number, what: string): T {
  const x = list.find((e) => e.id === id);
  if (!x) fail('id', `${what} introuvable (n° ${id})`);
  return x;
}

const nonEmpty = (s: string | undefined, field: string, label: string, errs: FieldError[]) => {
  if (!s || s.trim() === '') errs.push({ field, message: `${label} : à renseigner` });
};

// ---------------------------------------------------------------- foyer et personnes

export async function updateHousehold(
  driver: Driver,
  snap: Snapshot,
  patch: Partial<Pick<Snapshot['household'], 'name' | 'forecast_horizon_months' | 'ref_balance_max_age_days'>>,
): Promise<void> {
  const errs: FieldError[] = [];
  if (patch.name !== undefined) nonEmpty(patch.name, 'name', 'Nom du foyer', errs);
  if (patch.forecast_horizon_months !== undefined && !(patch.forecast_horizon_months >= 1 && patch.forecast_horizon_months <= 120))
    errs.push({ field: 'forecast_horizon_months', message: 'Horizon de prévision : entre 1 et 120 mois' });
  if (patch.ref_balance_max_age_days !== undefined && !(patch.ref_balance_max_age_days >= 1))
    errs.push({ field: 'ref_balance_max_age_days', message: 'Ancienneté maximale : au moins 1 jour' });
  if (errs.length) throw new ValidationError(errs);
  const p = new Plan();
  p.update('household', 1, snap.household as unknown as Record<string, unknown>, clean(patch), 'Foyer modifié');
  await p.run(driver);
}

export async function updatePerson(
  driver: Driver,
  snap: Snapshot,
  id: number,
  patch: { display_name?: string; birth_date?: IsoDate | null; retirement_date?: IsoDate | null },
): Promise<void> {
  const person = byId(snap.persons, id, 'Personne');
  const errs: FieldError[] = [];
  if (patch.display_name !== undefined) nonEmpty(patch.display_name, 'display_name', 'Prénom', errs);
  for (const f of ['birth_date', 'retirement_date'] as const) {
    const v = patch[f];
    if (v && !isValidIsoDate(v)) errs.push({ field: f, message: 'Date invalide' });
  }
  if (errs.length) throw new ValidationError(errs);
  const p = new Plan();
  p.update('person', id, person as unknown as Record<string, unknown>, clean(patch), `Personne ${person.role} modifiée`);
  await p.run(driver);
}

// ---------------------------------------------------------------- comptes

export interface AccountInput {
  name: string;
  institution?: string;
  currency: Currency;
  owner: Owner;
  type: AccountType;
  tracking?: Tracking;
  is_default_for_currency?: boolean;
  /** Solde de référence initial facultatif, enregistré avec le compte. */
  initialBalance?: { ref_date: IsoDate; amount_minor: number };
}

function validateAccount(input: Partial<AccountInput>, errs: FieldError[]) {
  if (input.name !== undefined) nonEmpty(input.name, 'name', 'Nom du compte', errs);
  if (input.currency !== undefined && !CURRENCIES.includes(input.currency))
    errs.push({ field: 'currency', message: `Devise ${String(input.currency)} non prise en charge (EUR ou CHF)` });
  if (input.owner !== undefined && !OWNERS.includes(input.owner))
    errs.push({ field: 'owner', message: 'Propriétaire : personne A, personne B ou commun' });
  if (input.type !== undefined && !TYPES.includes(input.type))
    errs.push({ field: 'type', message: 'Type : courant, épargne ou investissement' });
}

export async function createAccount(driver: Driver, snap: Snapshot, input: AccountInput): Promise<number> {
  const errs: FieldError[] = [];
  validateAccount(input, errs);
  if (snap.accounts.some((a) => a.name.trim().toLowerCase() === input.name.trim().toLowerCase()))
    errs.push({ field: 'name', message: `Un compte s'appelle déjà « ${input.name.trim()} »` });
  if (input.initialBalance && !isValidIsoDate(input.initialBalance.ref_date))
    errs.push({ field: 'initialBalance.ref_date', message: 'Date du solde invalide' });
  if (errs.length) throw new ValidationError(errs);
  const p = new Plan();
  if (input.is_default_for_currency) {
    for (const a of snap.accounts.filter((x) => x.currency === input.currency && x.is_default_for_currency)) {
      p.update('account', a.id, a as unknown as Record<string, unknown>, { is_default_for_currency: 0 }, `« ${a.name} » n'est plus le compte par défaut ${a.currency}`);
    }
  }
  const ref = p.insert(
    'account',
    {
      name: input.name.trim(),
      institution: (input.institution ?? '').trim(),
      currency: input.currency,
      owner: input.owner,
      type: input.type,
      tracking: input.tracking ?? 'detaille',
      is_default_for_currency: input.is_default_for_currency ? 1 : 0,
      sort_order: snap.accounts.length,
    },
    `Compte « ${input.name.trim()} » créé`,
  );
  if (input.initialBalance) {
    p.insert(
      'balance_reference',
      { account_id: ref, ref_date: input.initialBalance.ref_date, amount_minor: input.initialBalance.amount_minor, source: 'saisie', note: '' },
      `Solde de référence du ${formatDateFr(input.initialBalance.ref_date)}`,
    );
  }
  const r = await p.run(driver);
  return Plan.id(r, ref);
}

export async function updateAccount(
  driver: Driver,
  snap: Snapshot,
  id: number,
  patch: Partial<Pick<Account, 'name' | 'institution' | 'owner' | 'type' | 'tracking' | 'sort_order' | 'expected_return_class'>> & {
    currency?: Currency;
    is_default_for_currency?: boolean;
  },
): Promise<void> {
  const acc = byId(snap.accounts, id, 'Compte');
  const errs: FieldError[] = [];
  validateAccount(patch as Partial<AccountInput>, errs);
  if (patch.currency !== undefined && patch.currency !== acc.currency) {
    if (snap.movements.some((m) => m.account_id === id) || snap.balanceRefs.some((b) => b.account_id === id))
      errs.push({ field: 'currency', message: 'La devise ne peut plus changer : le compte a déjà des soldes ou des opérations' });
  }
  if (patch.name !== undefined && snap.accounts.some((a) => a.id !== id && a.name.trim().toLowerCase() === patch.name!.trim().toLowerCase()))
    errs.push({ field: 'name', message: `Un compte s'appelle déjà « ${patch.name.trim()} »` });
  if (errs.length) throw new ValidationError(errs);
  const p = new Plan();
  const changes: Record<string, string | number | null> = clean({ ...patch, is_default_for_currency: undefined });
  if (patch.is_default_for_currency !== undefined) {
    changes.is_default_for_currency = patch.is_default_for_currency ? 1 : 0;
    if (patch.is_default_for_currency) {
      const cur = patch.currency ?? acc.currency;
      for (const a of snap.accounts.filter((x) => x.id !== id && x.currency === cur && x.is_default_for_currency)) {
        p.update('account', a.id, a as unknown as Record<string, unknown>, { is_default_for_currency: 0 }, `« ${a.name} » n'est plus le compte par défaut ${cur}`);
      }
    }
  }
  p.update('account', id, acc as unknown as Record<string, unknown>, changes, `Compte « ${acc.name} » modifié`);
  await p.run(driver);
}

/**
 * Archiver : le compte n'est plus proposé à la saisie et se replie dans les listes.
 * Son historique et son solde restent dans tous les totaux (liquidités, patrimoine).
 */
export async function archiveAccount(driver: Driver, snap: Snapshot, id: number): Promise<void> {
  const acc = byId(snap.accounts, id, 'Compte');
  if (acc.status === 'archive') return;
  const p = new Plan();
  p.update('account', id, acc as unknown as Record<string, unknown>, { status: 'archive', archived_at: p.ts, is_default_for_currency: 0 }, `Compte « ${acc.name} » archivé`);
  await p.run(driver);
}

export async function reactivateAccount(driver: Driver, snap: Snapshot, id: number): Promise<void> {
  const acc = byId(snap.accounts, id, 'Compte');
  if (acc.status === 'actif') return;
  const p = new Plan();
  p.update('account', id, acc as unknown as Record<string, unknown>, { status: 'actif', archived_at: null }, `Compte « ${acc.name} » réactivé`);
  await p.run(driver);
}

// ---------------------------------------------------------------- soldes de référence

export async function setBalanceReference(
  driver: Driver,
  snap: Snapshot,
  input: { account_id: number; ref_date: IsoDate; amount_minor: number; source?: 'saisie' | 'releve' | 'import'; note?: string },
): Promise<void> {
  const acc = byId(snap.accounts, input.account_id, 'Compte');
  if (!isValidIsoDate(input.ref_date)) fail('ref_date', 'Date du solde invalide');
  if (!Number.isSafeInteger(input.amount_minor)) fail('amount_minor', 'Montant invalide');
  const existing = snap.balanceRefs.find((b) => b.account_id === acc.id && b.ref_date === input.ref_date);
  const p = new Plan();
  if (existing) {
    p.update(
      'balance_reference',
      existing.id,
      existing as unknown as Record<string, unknown>,
      { amount_minor: input.amount_minor, source: input.source ?? existing.source, note: input.note ?? existing.note },
      `Solde de référence de « ${acc.name} » au ${formatDateFr(input.ref_date)} corrigé`,
    );
  } else {
    p.insert(
      'balance_reference',
      { account_id: acc.id, ref_date: input.ref_date, amount_minor: input.amount_minor, source: input.source ?? 'saisie', note: input.note ?? '' },
      `Solde de référence de « ${acc.name} » au ${formatDateFr(input.ref_date)}`,
    );
  }
  await p.run(driver);
}

export async function deleteBalanceReference(driver: Driver, snap: Snapshot, id: number): Promise<void> {
  const b = byId(snap.balanceRefs, id, 'Solde de référence');
  const p = new Plan();
  p.raw('DELETE FROM balance_reference WHERE id = ?', [id]);
  p.audit('balance_reference', id, 'delete', `Solde de référence du ${formatDateFr(b.ref_date)} supprimé`, b);
  await p.run(driver);
}

// ---------------------------------------------------------------- familles et rubriques

export async function createFamily(driver: Driver, snap: Snapshot, input: { name: string; direction: Direction }): Promise<number> {
  const errs: FieldError[] = [];
  nonEmpty(input.name, 'name', 'Nom de la famille', errs);
  if (!['revenu', 'depense', 'technique'].includes(input.direction)) errs.push({ field: 'direction', message: 'Sens : revenu ou dépense' });
  if (snap.families.some((f) => f.direction === input.direction && f.name.toLowerCase() === input.name.trim().toLowerCase()))
    errs.push({ field: 'name', message: `La famille « ${input.name.trim()} » existe déjà` });
  if (errs.length) throw new ValidationError(errs);
  const p = new Plan();
  const maxSort = Math.max(0, ...snap.families.filter((f) => f.direction === input.direction && !f.is_system).map((f) => f.sort_order));
  const ref = p.insert('family', { name: input.name.trim(), direction: input.direction, sort_order: maxSort + 1 }, `Famille « ${input.name.trim()} » créée`);
  return Plan.id(await p.run(driver), ref);
}

export async function updateFamily(
  driver: Driver,
  snap: Snapshot,
  id: number,
  patch: { name?: string; visible?: boolean; sort_order?: number },
): Promise<void> {
  const f = byId(snap.families, id, 'Famille');
  const errs: FieldError[] = [];
  if (patch.name !== undefined) {
    nonEmpty(patch.name, 'name', 'Nom de la famille', errs);
    if (f.is_system) errs.push({ field: 'name', message: 'Famille système : le nom ne peut pas être modifié' });
  }
  if (errs.length) throw new ValidationError(errs);
  const p = new Plan();
  p.update('family', id, f as unknown as Record<string, unknown>, clean({ ...patch, visible: patch.visible === undefined ? undefined : patch.visible ? 1 : 0 }), `Famille « ${f.name} » modifiée`);
  await p.run(driver);
}

function slug(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 24) || 'X';
}

export function makeRubriqueRef(snap: Snapshot, family: Family, name: string): string {
  const prefix = family.direction === 'revenu' ? 'REV' : family.direction === 'depense' ? 'DEP' : 'TECH';
  const base = `${prefix}.${slug(family.name)}.${slug(name)}`;
  let ref = base;
  let i = 2;
  while (snap.rubriques.some((r) => r.ref === ref)) ref = `${base}_${i++}`;
  return ref;
}

export async function createRubrique(
  driver: Driver,
  snap: Snapshot,
  input: { family_id: number; name: string; estimation_method?: Rubrique['estimation_method'] },
): Promise<number> {
  const fam = byId(snap.families, input.family_id, 'Famille');
  const errs: FieldError[] = [];
  nonEmpty(input.name, 'name', 'Nom de la rubrique', errs);
  if (snap.rubriques.some((r) => r.family_id === fam.id && r.name.toLowerCase() === input.name.trim().toLowerCase()))
    errs.push({ field: 'name', message: `La rubrique « ${input.name.trim()} » existe déjà dans « ${fam.name} »` });
  if (errs.length) throw new ValidationError(errs);
  const p = new Plan();
  const maxSort = Math.max(0, ...snap.rubriques.filter((r) => r.family_id === fam.id).map((r) => r.sort_order));
  const ref = p.insert(
    'rubrique',
    {
      family_id: fam.id,
      name: input.name.trim(),
      ref: makeRubriqueRef(snap, fam, input.name),
      estimation_method: input.estimation_method ?? 'budget',
      sort_order: maxSort + 1,
    },
    `Rubrique « ${input.name.trim()} » créée dans « ${fam.name} »`,
  );
  return Plan.id(await p.run(driver), ref);
}

/**
 * Les drapeaux « disponible pour de nouvelles saisies » et « affichée » sont indépendants
 * et n'ont AUCUN effet sur les engagements ni sur les totaux historiques.
 */
export async function updateRubrique(
  driver: Driver,
  snap: Snapshot,
  id: number,
  patch: {
    name?: string;
    family_id?: number;
    available_for_entry?: boolean;
    visible?: boolean;
    estimation_method?: Rubrique['estimation_method'];
    estimation_n?: number;
    default_account_id?: number | null;
    sort_order?: number;
  },
): Promise<void> {
  const r = byId(snap.rubriques, id, 'Rubrique');
  const errs: FieldError[] = [];
  if (patch.name !== undefined) {
    nonEmpty(patch.name, 'name', 'Nom de la rubrique', errs);
    if (r.is_system) errs.push({ field: 'name', message: 'Rubrique système : le nom ne peut pas être modifié' });
  }
  if (patch.family_id !== undefined && patch.family_id !== r.family_id) {
    const from = byId(snap.families, r.family_id, 'Famille');
    const to = byId(snap.families, patch.family_id, 'Famille');
    if (r.is_system) errs.push({ field: 'family_id', message: 'Rubrique système : elle ne peut pas changer de famille' });
    if (from.direction !== to.direction && snap.movements.some((m) => m.rubrique_id === id))
      errs.push({ field: 'family_id', message: `« ${r.name} » est utilisée : elle ne peut pas passer de ${from.direction} à ${to.direction}` });
  }
  if (patch.default_account_id) byId(snap.accounts, patch.default_account_id, 'Compte');
  if (errs.length) throw new ValidationError(errs);
  const p = new Plan();
  p.update(
    'rubrique',
    id,
    r as unknown as Record<string, unknown>,
    clean({
      ...patch,
      available_for_entry: patch.available_for_entry === undefined ? undefined : patch.available_for_entry ? 1 : 0,
      visible: patch.visible === undefined ? undefined : patch.visible ? 1 : 0,
    }),
    `Rubrique « ${r.name} » modifiée`,
  );
  await p.run(driver);
}

// ---------------------------------------------------------------- taux de change

export interface RateChangeNotice {
  /** Message à afficher : ce qui a été recalculé. */
  message: string;
  affectedMovements: number;
}

function rateNotice(snap: Snapshot, date: IsoDate, nextRateDate: IsoDate | null): RateChangeNotice {
  // Les mouvements concernés sont ceux dont le taux applicable change : de `date` jusqu'au taux suivant.
  const n = snap.movements.filter((m) => {
    const d = m.op_date ?? `${m.period_month}-01`;
    return m.currency === 'CHF' && d >= date && (nextRateDate === null || d < nextRateDate);
  }).length;
  const end = nextRateDate ? ` au ${formatDateFr(nextRateDate)} (exclu)` : '';
  return {
    affectedMovements: n,
    message: `Vues consolidées recalculées pour la période du ${formatDateFr(date)}${end} : ${n} mouvement(s) en CHF concerné(s). Les montants d'origine ne changent pas.`,
  };
}

export async function setFxRate(
  driver: Driver,
  snap: Snapshot,
  input: { rate_date: IsoDate; eur_chf: string | number; source?: 'manuel' | 'csv' | 'bce' },
): Promise<RateChangeNotice> {
  if (!isValidIsoDate(input.rate_date)) fail('rate_date', 'Date du taux invalide');
  const e6 = typeof input.eur_chf === 'number' ? input.eur_chf : parseRate(input.eur_chf);
  if (!e6 || !Number.isInteger(e6)) fail('eur_chf', 'Taux invalide : nombre positif, ex. 0,9412 (CHF pour 1 €)');
  if (e6 < 500_000 || e6 > 2_000_000) fail('eur_chf', `Taux ${formatRate(e6)} hors de la plage plausible (0,5 à 2 CHF pour 1 €)`);
  const existing = snap.fxRates.find((r) => r.rate_date === input.rate_date);
  const p = new Plan();
  if (existing) {
    if (existing.eur_chf_e6 === e6) return { message: 'Taux inchangé.', affectedMovements: 0 };
    p.update('fx_rate', input.rate_date, existing as unknown as Record<string, unknown>,
      { eur_chf_e6: e6, source: input.source ?? 'manuel', updated_at: p.ts },
      `Taux du ${formatDateFr(input.rate_date)} : ${formatRate(existing.eur_chf_e6)} → ${formatRate(e6)}`,
      { idColumn: 'rate_date' });
  } else {
    p.raw('INSERT INTO fx_rate (rate_date, eur_chf_e6, source, updated_at) VALUES (?, ?, ?, ?)', [input.rate_date, e6, input.source ?? 'manuel', p.ts]);
    p.audit('fx_rate', input.rate_date, 'create', `Taux du ${formatDateFr(input.rate_date)} : ${formatRate(e6)}`, undefined, { eur_chf_e6: e6 });
  }
  await p.run(driver);
  const next = snap.fxRates.map((r) => r.rate_date).filter((d) => d > input.rate_date).sort()[0] ?? null;
  return rateNotice(snap, input.rate_date, next);
}

export async function deleteFxRate(driver: Driver, snap: Snapshot, date: IsoDate): Promise<RateChangeNotice> {
  const existing = snap.fxRates.find((r) => r.rate_date === date);
  if (!existing) fail('rate_date', 'Aucun taux à cette date');
  const p = new Plan();
  p.raw('DELETE FROM fx_rate WHERE rate_date = ?', [date]);
  p.audit('fx_rate', date, 'delete', `Taux du ${formatDateFr(date)} supprimé`, existing);
  await p.run(driver);
  const next = snap.fxRates.map((r) => r.rate_date).filter((d) => d > date).sort()[0] ?? null;
  return rateNotice(snap, date, next);
}

export interface RateCsvReport {
  rows: { line: number; rate_date: IsoDate; eur_chf_e6: number; status: 'nouveau' | 'modifie' | 'identique' }[];
  errors: { line: number; message: string }[];
}

/** Lecture d'un CSV « date;taux » (en-tête facultatif). Aucune écriture : voir applyRateCsv. */
export function readRateCsv(snap: Snapshot, text: string): RateCsvReport {
  const report: RateCsvReport = { rows: [], errors: [] };
  const seen = new Set<string>();
  text.replace(/^﻿/, '').split(/\r?\n/).forEach((lineText, i) => {
    const line = i + 1;
    if (lineText.trim() === '') return;
    const cells = lineText.split(/[;\t]/).map((c) => c.trim().replace(/^"|"$/g, ''));
    if (i === 0 && !/\d/.test(cells[0] ?? '')) return; // en-tête
    if (cells.length < 2) {
      report.errors.push({ line, message: `Ligne ${line} : deux colonnes attendues (date;taux)` });
      return;
    }
    const [d, r] = cells as [string, string];
    const fr = /^(\d{2})[/.](\d{2})[/.](\d{4})$/.exec(d);
    const iso = fr ? `${fr[3]}-${fr[2]}-${fr[1]}` : d;
    if (!isValidIsoDate(iso)) {
      report.errors.push({ line, message: `Ligne ${line}, colonne date : « ${d} » n'est pas une date AAAA-MM-JJ ou JJ/MM/AAAA` });
      return;
    }
    const e6 = parseRate(r);
    if (!e6 || e6 < 500_000 || e6 > 2_000_000) {
      report.errors.push({ line, message: `Ligne ${line}, colonne taux : « ${r} » n'est pas un taux plausible (ex. 0,9412)` });
      return;
    }
    if (seen.has(iso)) {
      report.errors.push({ line, message: `Ligne ${line} : la date ${formatDateFr(iso)} apparaît deux fois` });
      return;
    }
    seen.add(iso);
    const ex = snap.fxRates.find((x) => x.rate_date === iso);
    report.rows.push({ line, rate_date: iso, eur_chf_e6: e6, status: !ex ? 'nouveau' : ex.eur_chf_e6 === e6 ? 'identique' : 'modifie' });
  });
  return report;
}

export async function applyRateCsv(driver: Driver, snap: Snapshot, report: RateCsvReport): Promise<number> {
  if (report.errors.length) throw new ValidationError(report.errors.map((e) => ({ field: `ligne ${e.line}`, message: e.message })));
  const p = new Plan();
  let n = 0;
  for (const r of report.rows) {
    if (r.status === 'identique') continue;
    const ex = snap.fxRates.find((x) => x.rate_date === r.rate_date);
    p.raw('INSERT INTO fx_rate (rate_date, eur_chf_e6, source, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(rate_date) DO UPDATE SET eur_chf_e6 = excluded.eur_chf_e6, source = excluded.source, updated_at = excluded.updated_at', [r.rate_date, r.eur_chf_e6, 'csv', p.ts]);
    p.audit('fx_rate', r.rate_date, ex ? 'update' : 'create', `Taux du ${formatDateFr(r.rate_date)} importé : ${formatRate(r.eur_chf_e6)}`, ex, { eur_chf_e6: r.eur_chf_e6 });
    n++;
  }
  if (n) await p.run(driver);
  return n;
}

// ---------------------------------------------------------------- utilitaires

function clean<T extends Record<string, unknown>>(o: T): Record<string, string | number | null> {
  const out: Record<string, string | number | null> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined) continue;
    if (typeof v === 'string') out[k] = k === 'name' || k === 'display_name' ? v.trim() : v;
    else if (typeof v === 'number' || v === null) out[k] = v;
    else if (typeof v === 'boolean') out[k] = v ? 1 : 0;
  }
  return out;
}

/** Journal d'une entité, du plus récent au plus ancien. */
export async function auditTrail(driver: Driver, entity: string, entityId: string | number) {
  return driver.query('SELECT * FROM audit_log WHERE entity = ? AND entity_id = ? ORDER BY id DESC', [entity, String(entityId)]);
}
