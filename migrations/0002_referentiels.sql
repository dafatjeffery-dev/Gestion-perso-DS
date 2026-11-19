-- Natures financières, familles et rubriques système, familles et rubriques par défaut.

INSERT INTO nature (code, label, sort_order) VALUES
  ('revenu_ordinaire',      'Revenu ordinaire', 1),
  ('revenu_exceptionnel',   'Revenu exceptionnel', 2),
  ('depense',               'Dépense courante', 3),
  ('remboursement_depense', 'Remboursement de dépense', 4),
  ('transfert',             'Transfert interne', 5),
  ('emprunt_recu',          'Emprunt reçu', 6),
  ('capital_credit',        'Remboursement de capital', 7),
  ('cout_credit',           'Intérêts, assurance et frais de crédit', 8),
  ('epargne',               'Épargne / investissement', 9),
  ('frais_transfert',       'Frais de transfert', 10),
  ('a_classer',             'À classer', 11);

INSERT INTO nature_direction (nature, direction) VALUES
  ('revenu_ordinaire', 'revenu'), ('revenu_exceptionnel', 'revenu'),
  ('depense', 'depense'), ('remboursement_depense', 'depense'),
  ('cout_credit', 'depense'), ('frais_transfert', 'depense'),
  ('transfert', 'technique'), ('emprunt_recu', 'technique'),
  ('capital_credit', 'technique'), ('epargne', 'technique'),
  ('a_classer', 'technique');

-- Familles (id fixés pour les rubriques ci-dessous)
INSERT INTO family (id, name, direction, is_system, sort_order) VALUES
  (1,  'Revenus du travail', 'revenu', 0, 10),
  (2,  'Autres revenus',     'revenu', 0, 20),
  (10, 'Logement',           'depense', 0, 100),
  (11, 'Alimentation',       'depense', 0, 110),
  (12, 'Transport',          'depense', 0, 120),
  (13, 'Enfants',            'depense', 0, 130),
  (14, 'Santé',              'depense', 0, 140),
  (15, 'Loisirs',            'depense', 0, 150),
  (16, 'Équipement',         'depense', 0, 160),
  (17, 'Impôts et taxes',    'depense', 0, 170),
  (18, 'Crédits',            'depense', 1, 180),
  (19, 'Frais bancaires',    'depense', 1, 190),
  (90, 'Mouvements techniques', 'technique', 1, 900);

INSERT INTO rubrique (family_id, name, ref, is_system, sort_order) VALUES
  (1,  'Salaire A',                'REV.TRAVAIL.SALAIRE_A', 0, 1),
  (1,  'Salaire B',                'REV.TRAVAIL.SALAIRE_B', 0, 2),
  (1,  'Primes',                   'REV.TRAVAIL.PRIMES', 0, 3),
  (2,  'Allocations',              'REV.AUTRES.ALLOCATIONS', 0, 1),
  (2,  'Revenus locatifs',         'REV.AUTRES.LOCATIFS', 0, 2),
  (2,  'Divers',                   'REV.AUTRES.DIVERS', 0, 3),
  (10, 'Loyer ou charges',         'DEP.LOGEMENT.CHARGES', 0, 1),
  (10, 'Énergie',                  'DEP.LOGEMENT.ENERGIE', 0, 2),
  (10, 'Assurance habitation',     'DEP.LOGEMENT.ASSURANCE', 0, 3),
  (10, 'Travaux et entretien',     'DEP.LOGEMENT.TRAVAUX', 0, 4),
  (11, 'Courses',                  'DEP.ALIM.COURSES', 0, 1),
  (11, 'Restaurants',              'DEP.ALIM.RESTAURANTS', 0, 2),
  (12, 'Carburant et recharge',    'DEP.TRANSPORT.CARBURANT', 0, 1),
  (12, 'Assurance véhicule',       'DEP.TRANSPORT.ASSURANCE', 0, 2),
  (12, 'Entretien véhicule',       'DEP.TRANSPORT.ENTRETIEN', 0, 3),
  (12, 'Transports en commun',     'DEP.TRANSPORT.COMMUN', 0, 4),
  (13, 'Garde et école',           'DEP.ENFANTS.GARDE', 0, 1),
  (13, 'Activités',                'DEP.ENFANTS.ACTIVITES', 0, 2),
  (14, 'Frais de santé',           'DEP.SANTE.FRAIS', 0, 1),
  (14, 'Mutuelle',                 'DEP.SANTE.MUTUELLE', 0, 2),
  (15, 'Sorties et vacances',      'DEP.LOISIRS.VACANCES', 0, 1),
  (15, 'Abonnements',              'DEP.LOISIRS.ABONNEMENTS', 0, 2),
  (16, 'Gros achats',              'DEP.EQUIP.GROS_ACHATS', 0, 1),
  (16, 'Électroménager',           'DEP.EQUIP.ELECTROMENAGER', 0, 2),
  (16, 'Électronique',             'DEP.EQUIP.ELECTRONIQUE', 0, 3),
  (17, 'Impôt sur le revenu',      'DEP.IMPOTS.REVENU', 0, 1),
  (17, 'Taxes locales',            'DEP.IMPOTS.LOCALES', 0, 2),
  -- système : coûts de crédit (nature cout_credit)
  (18, 'Intérêts',                 'SYS.CREDIT.INTERETS', 1, 1),
  (18, 'Assurance emprunteur',     'SYS.CREDIT.ASSURANCE', 1, 2),
  (18, 'Frais de crédit',          'SYS.CREDIT.FRAIS', 1, 3),
  (18, 'Échéance non ventilée',    'SYS.CREDIT.NON_VENTILEE', 1, 4),
  -- système : frais bancaires
  (19, 'Frais de transfert',       'SYS.FRAIS.TRANSFERT', 1, 1),
  (19, 'Écart de change',          'SYS.FRAIS.ECART_CHANGE', 1, 2),
  (19, 'Frais de tenue de compte', 'DEP.FRAIS.TENUE', 0, 3),
  -- système : mouvements techniques
  (90, 'Transfert interne',        'SYS.TECH.TRANSFERT', 1, 1),
  (90, 'Capital remboursé',        'SYS.TECH.CAPITAL', 1, 2),
  (90, 'Emprunt reçu',             'SYS.TECH.EMPRUNT', 1, 3),
  (90, 'Épargne placée',           'SYS.TECH.EPARGNE', 1, 4),
  (90, 'À classer',                'SYS.TECH.A_CLASSER', 1, 5);

INSERT INTO scenario (kind, params_json) VALUES
  ('prudent',   '{"inflation":0.03,"return_default":0.01,"real_estate":0.0,"eur_chf":0.90,"income_growth":0.005}'),
  ('central',   '{"inflation":0.02,"return_default":0.03,"real_estate":0.01,"eur_chf":0.94,"income_growth":0.015}'),
  ('favorable', '{"inflation":0.015,"return_default":0.05,"real_estate":0.02,"eur_chf":0.98,"income_growth":0.025}');
