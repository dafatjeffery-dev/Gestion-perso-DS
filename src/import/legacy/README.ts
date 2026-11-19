// Reprise des données de l'ancienne version de DS Finances — PRÉVUE, NON DÉVELOPPÉE.
//
// En attente d'un exemple de fichier d'export de l'ancienne application. Le principe retenu
// (docs/ARCHITECTURE.md § 9.2) :
//   1. lire l'export vers une base TEMPORAIRE (jamais la base courante) ;
//   2. produire un rapport de correspondance : comptes, rubriques, natures, et totaux mensuels
//      par rubrique comparés entre l'ancien fichier et la base temporaire ;
//   3. après confirmation, écrire en une transaction (après une sauvegarde « avant nouveau départ »).

import type { Driver } from '../../storage/driver';

export interface LegacyReport {
  accounts: { legacy: string; mapped: number | null }[];
  rubriques: { legacy: string; mapped: number | null }[];
  monthlyTotals: { month: string; rubrique: string; legacy: number; imported: number }[];
  issues: string[];
}

export interface LegacyImporter {
  /** Reconnaît le fichier (format, version de l'ancienne application). */
  detect(fileName: string, bytes: Uint8Array): boolean;
  /** Charge dans une base temporaire et rend le rapport de correspondance. */
  stage(bytes: Uint8Array, temporary: Driver): Promise<LegacyReport>;
}
