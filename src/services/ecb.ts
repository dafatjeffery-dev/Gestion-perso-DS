// Récupération FACULTATIVE des taux EUR/CHF auprès de la Banque centrale européenne.
// Seule connexion réseau de l'application ; déclenchée explicitement par l'utilisateur ;
// aucune donnée personnelle envoyée (la requête ne contient que des dates).

import type { IsoDate, Snapshot } from '../domain/types';
import type { Driver } from '../storage/driver';
import { applyRateCsv, readRateCsv } from './referentials';

export const ECB_HOST = 'data-api.ecb.europa.eu';

export function ecbUrl(from: IsoDate, to: IsoDate): string {
  return `https://${ECB_HOST}/service/data/EXR/D.CHF.EUR.SP00.A?startPeriod=${from}&endPeriod=${to}&format=csvdata`;
}

/** Convertit la réponse CSV de la BCE (colonnes TIME_PERIOD, OBS_VALUE) en « date;taux ». */
export function ecbCsvToRates(csv: string): string {
  const lines = csv.trim().split(/\r?\n/);
  const head = lines[0]!.split(',');
  const di = head.indexOf('TIME_PERIOD');
  const vi = head.indexOf('OBS_VALUE');
  if (di < 0 || vi < 0) throw new Error('Réponse de la BCE inattendue (colonnes TIME_PERIOD / OBS_VALUE absentes)');
  return ['date;taux', ...lines.slice(1).map((l) => l.split(',')).filter((c) => c[vi]).map((c) => `${c[di]};${String(Number(c[vi])).replace('.', ',')}`)].join('\n');
}

export async function fetchEcbRates(driver: Driver, snap: Snapshot, from: IsoDate, to: IsoDate, fetchImpl: typeof fetch = fetch): Promise<number> {
  const res = await fetchImpl(ecbUrl(from, to), { headers: { Accept: 'text/csv' } });
  if (!res.ok) throw new Error(`La BCE a répondu ${res.status}`);
  const report = readRateCsv(snap, ecbCsvToRates(await res.text()));
  return applyRateCsv(driver, snap, report, 'bce');
}
