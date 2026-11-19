// Foyer fictif pour les tests. Aucune donnée réelle.
import * as ref from '../../src/services/referentials';
import { setup, rubriqueId } from '../helpers';

export async function foyer() {
  const env = await setup();
  const { driver, snap } = env;
  const courant = await ref.createAccount(driver, await snap(), { name: 'Courant commun', currency: 'EUR', owner: 'commun', type: 'courant', is_default_for_currency: true, initialBalance: { ref_date: '2026-10-31', amount_minor: 300000 } });
  const chf = await ref.createAccount(driver, await snap(), { name: 'Courant CHF', currency: 'CHF', owner: 'B', type: 'courant', is_default_for_currency: true, initialBalance: { ref_date: '2026-10-31', amount_minor: 512000 } });
  const livret = await ref.createAccount(driver, await snap(), { name: 'Livret A', currency: 'EUR', owner: 'A', type: 'epargne', tracking: 'synthetique', initialBalance: { ref_date: '2026-10-15', amount_minor: 2295000 } });
  await ref.setFxRate(driver, await snap(), { rate_date: '2026-10-01', eur_chf: '0,9400' });
  await ref.setFxRate(driver, await snap(), { rate_date: '2026-10-31', eur_chf: '0,9412' });
  const r = async (x: string) => rubriqueId(driver, x);
  return {
    ...env,
    acc: { courant, chf, livret },
    rub: {
      courses: await r('DEP.ALIM.COURSES'),
      restaurants: await r('DEP.ALIM.RESTAURANTS'),
      abonnements: await r('DEP.LOISIRS.ABONNEMENTS'),
      assurance: await r('DEP.LOGEMENT.ASSURANCE'),
      energie: await r('DEP.LOGEMENT.ENERGIE'),
      taxes: await r('DEP.IMPOTS.LOCALES'),
      salaireA: await r('REV.TRAVAIL.SALAIRE_A'),
      salaireB: await r('REV.TRAVAIL.SALAIRE_B'),
      fraisTransfert: await r('SYS.FRAIS.TRANSFERT'),
      ecartChange: await r('SYS.FRAIS.ECART_CHANGE'),
    },
  };
}
