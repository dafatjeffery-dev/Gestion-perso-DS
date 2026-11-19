import { formatMoney } from '../domain/money';
import type { Expected } from '../engine/occurrences';

export function statusLabel(e: Expected): { text: string; cls: string } {
  switch (e.status) {
    case 'soldee':
      return { text: e.gap ? `soldée (écart ${formatMoney(e.gap, e.currency, { signed: true })})` : 'soldée', cls: 'ok' };
    case 'partielle':
      return { text: `partielle — reste ${formatMoney(e.remaining, e.currency)}`, cls: 'n' };
    case 'en_retard':
      return { text: 'en retard', cls: '' };
    case 'incluse':
      return { text: 'réputée incluse dans le solde constaté', cls: 'n' };
    default:
      return { text: 'à venir', cls: 'n' };
  }
}
