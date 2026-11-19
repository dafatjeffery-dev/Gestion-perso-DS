// Biens, valeurs déclarées datées, paramètres des scénarios.

import { formatDateFr, isValidIsoDate } from '../domain/dates';
import { formatMoney } from '../domain/money';
import type { Asset, Currency, IsoDate, ScenarioParams, Snapshot } from '../domain/types';
import type { Driver } from '../storage/driver';
import { Plan, ValidationError, fail, type FieldError } from './plan';

export async function saveAsset(driver: Driver, snap: Snapshot, input: { kind: Asset['kind']; name: string; currency: Currency; ownership_pct_e2?: number }, id: number | null = null): Promise<number> {
  if (!input.name?.trim()) fail('name', 'Nom : à renseigner');
  const pct = input.ownership_pct_e2 ?? 10000;
  if (!(pct >= 1 && pct <= 10000)) fail('ownership_pct_e2', 'Quote-part : entre 0,01 % et 100 %');
  const p = new Plan();
  const vals = { kind: input.kind, name: input.name.trim(), currency: input.currency, ownership_pct_e2: pct };
  if (id) {
    const a = snap.assets.find((x) => x.id === id);
    if (!a) fail('id', 'Bien introuvable');
    if (a.currency !== input.currency && snap.assetValuations.some((v) => v.asset_id === id)) fail('currency', 'La devise d’un bien déjà évalué ne peut pas changer');
    p.update('asset', id, a as unknown as Record<string, unknown>, vals, `Bien « ${a.name} » modifié`);
    await p.run(driver);
    return id;
  }
  const ref = p.insert('asset', { ...vals, status: 'actif' }, `Bien « ${vals.name} » créé`);
  return Plan.id(await p.run(driver), ref);
}

export async function setAssetValue(driver: Driver, snap: Snapshot, input: { asset_id: number; date: IsoDate; value_minor: number }): Promise<void> {
  const a = snap.assets.find((x) => x.id === input.asset_id);
  if (!a) fail('asset_id', 'Bien introuvable');
  if (!isValidIsoDate(input.date)) fail('date', 'Date invalide');
  if (!(Number.isSafeInteger(input.value_minor) && input.value_minor >= 0)) fail('value_minor', 'Valeur : positive');
  const ex = snap.assetValuations.find((v) => v.asset_id === a.id && v.valuation_date === input.date);
  const p = new Plan();
  if (ex) {
    p.raw('UPDATE asset_valuation SET value_minor = ? WHERE asset_id = ? AND valuation_date = ?', [input.value_minor, a.id, input.date]);
    p.audit('asset_valuation', `${a.id}:${input.date}`, 'update', `Valeur de « ${a.name} » au ${formatDateFr(input.date)} corrigée`, ex, { value_minor: input.value_minor });
  } else {
    p.raw('INSERT INTO asset_valuation (asset_id, valuation_date, value_minor, source) VALUES (?, ?, ?, ?)', [a.id, input.date, input.value_minor, 'declaration']);
    p.audit('asset_valuation', `${a.id}:${input.date}`, 'create', `Valeur de « ${a.name} » au ${formatDateFr(input.date)} : ${formatMoney(input.value_minor, a.currency)}`, undefined, { value_minor: input.value_minor });
  }
  await p.run(driver);
}

const RANGES: Record<keyof ScenarioParams, [number, number, string]> = {
  inflation: [-0.05, 0.2, 'Inflation'],
  return_default: [-0.1, 0.2, 'Rendement des placements'],
  real_estate: [-0.1, 0.15, 'Évolution de l’immobilier'],
  eur_chf: [0.5, 2, 'Taux EUR/CHF'],
  income_growth: [-0.1, 0.15, 'Évolution des revenus'],
};

export async function setScenario(driver: Driver, snap: Snapshot, kind: 'prudent' | 'central' | 'favorable', params: ScenarioParams): Promise<void> {
  const s = snap.scenarios.find((x) => x.kind === kind);
  if (!s) fail('kind', 'Scénario introuvable');
  const errs: FieldError[] = [];
  for (const [k, [lo, hi, label]] of Object.entries(RANGES) as [keyof ScenarioParams, [number, number, string]][]) {
    const v = params[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) errs.push({ field: k, message: `${label} : entre ${lo} et ${hi}` });
  }
  if (errs.length) throw new ValidationError(errs);
  const p = new Plan();
  p.update('scenario', s.id, s as unknown as Record<string, unknown>, { params_json: JSON.stringify(params) }, `Scénario ${kind} modifié`);
  await p.run(driver);
}
