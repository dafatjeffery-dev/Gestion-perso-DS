// Éléments « À vérifier » : ce qui demande une action ou rend un chiffre moins fiable.

import { addMonths, formatDateFr, formatMonthFr, lastDay } from '../domain/dates';
import { accountBalance, isLiquid } from './balances';
import type { Ctx } from './context';
import { situation } from './funds';
import { realLines, type RealLines } from './lines';
import { expectedBetween } from './occurrences';

export interface CheckItem {
  kind: 'conflit' | 'classement' | 'retard' | 'credit' | 'mois' | 'solde' | 'compte' | 'taux' | 'non_affecte';
  severity: 'important' | 'info';
  text: string;
  target: { screen: 'monthly' | 'operations' | 'accounts' | 'commitments' | 'loans' | 'funds' | 'settings'; month?: string; accountId?: number; batchId?: number };
}

export function checks(ctx: Ctx, real: RealLines = realLines(ctx)): CheckItem[] {
  const out: CheckItem[] = [];
  for (const c of real.conflicts) {
    out.push({ kind: 'conflit', severity: 'important', text: `« ${ctx.rubrique.get(c.rubrique_id)!.name} » en ${formatMonthFr(c.month)} : total et opérations sans décision (non comptés)`, target: { screen: 'monthly', month: c.month } });
  }
  const toCheck = ctx.snap.movements.filter((m) => m.classification === 'a_verifier');
  if (toCheck.length) {
    const batches = new Set(toCheck.map((m) => m.import_batch_id).filter(Boolean));
    out.push({ kind: 'classement', severity: 'important', text: `${toCheck.length} opération(s) au classement « à vérifier »${batches.size ? ` (${batches.size} lot(s) d’import)` : ''}`, target: { screen: 'operations' } });
  }
  const aClasser = ctx.rubriqueByRef.get('SYS.TECH.A_CLASSER');
  const unclassified = ctx.snap.movements.filter((m) => m.rubrique_id === aClasser?.id);
  if (unclassified.length) out.push({ kind: 'classement', severity: 'info', text: `${unclassified.length} opération(s) « À classer »`, target: { screen: 'operations' } });
  const from = `${addMonths(ctx.currentMonth, -12)}-01`;
  for (const e of expectedBetween(ctx, from, ctx.today)) {
    if (e.status === 'en_retard') out.push({ kind: 'retard', severity: 'important', text: `${e.label} — échéance du ${formatDateFr(e.due_date)} non rapprochée`, target: { screen: 'commitments' } });
  }
  const nv = ctx.rubriqueByRef.get('SYS.CREDIT.NON_VENTILEE');
  const unventilated = real.lines.filter((l) => l.rubrique_id === nv?.id && l.movement_id && !l.creditComponent);
  if (unventilated.length) out.push({ kind: 'credit', severity: 'info', text: `${unventilated.length} paiement(s) de crédit non rapproché(s) d’une échéance (non ventilés)`, target: { screen: 'operations' } });
  for (let k = 1; k <= 3; k++) {
    const m = addMonths(ctx.currentMonth, -k);
    if (!ctx.closedMonths.has(m) && ctx.snap.movements.some((x) => x.period_month === m)) out.push({ kind: 'mois', severity: 'info', text: `${formatMonthFr(m)} n’est pas clôturé (chiffres provisoires)`, target: { screen: 'monthly', month: m } });
  }
  for (const a of ctx.snap.accounts) {
    const b = accountBalance(ctx, a.id);
    if (isLiquid(a) && a.status === 'actif' && !b.reference) out.push({ kind: 'compte', severity: 'important', text: `« ${a.name} » n’a aucun solde constaté`, target: { screen: 'accounts' } });
    else if (a.status === 'actif' && b.stale) out.push({ kind: 'solde', severity: 'info', text: `Solde constaté de « ${a.name} » ancien de ${b.referenceAgeDays} jours`, target: { screen: 'accounts' } });
    if (a.status === 'archive' && b.minor) out.push({ kind: 'compte', severity: 'info', text: `« ${a.name} » est archivé avec un solde non nul (toujours compté dans les liquidités)`, target: { screen: 'accounts' } });
  }
  const chfDates = [...new Set(ctx.snap.movements.filter((m) => m.currency !== ctx.base).map((m) => m.op_date ?? lastDay(m.period_month)))].sort();
  const stale = chfDates.filter((d) => {
    const r = ctx.rates.at(d);
    return !r || r.kind === 'posterieur' || Math.round((Date.parse(d) - Date.parse(r.rate_date)) / 86400000) > 7;
  });
  if (stale.length) out.push({ kind: 'taux', severity: 'info', text: `Taux EUR/CHF manquant ou ancien de plus de 7 jours pour ${stale.length} date(s) d’opération (du ${formatDateFr(stale[0]!)} au ${formatDateFr(stale[stale.length - 1]!)})`, target: { screen: 'settings' } });
  const s = situation(ctx);
  if (s.nonAffecte.value !== null && s.nonAffecte.value < 0) out.push({ kind: 'non_affecte', severity: 'important', text: 'Le non affecté est négatif : les réservations dépassent les liquidités', target: { screen: 'funds' } });
  return out.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'important' ? -1 : 1));
}
