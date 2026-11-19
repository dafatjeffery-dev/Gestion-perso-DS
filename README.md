# DS Finances

Application locale de pilotage financier d'un foyer (EUR / CHF) : comptes, suivi mensuel synthétique ou détaillé, engagements, budgets, crédits, réserve et projets, prévision de trésorerie, patrimoine et projection, import standardisé de relevés préparés avec une IA.

Tauri 2 + TypeScript + React + SQLite. Aucune donnée envoyée à l'extérieur (seule exception : récupération facultative des taux BCE, déclenchée par l'utilisateur).

## Commandes

```bash
npm install
npm run dev          # aperçu navigateur (données dans le navigateur, pas sur le Mac)
npm test             # moteur, stockage sql.js, services, import, exports
npm run test:e2e     # interface dans Chromium, sur l'aperçu navigateur
cd src-tauri && cargo test --workspace   # stockage réel : migrations, sauvegardes, restauration
npm run tauri dev    # application Mac (sur le Mac)
npm run tauri build  # .app / .dmg (sur le Mac)
```

Sur le Mac, `npx playwright install chromium` est nécessaire une fois avant `npm run test:e2e`.

## Organisation

| Dossier | Rôle |
|---|---|
| `migrations/` | schéma SQL versionné, partagé par Rust et sql.js |
| `src-tauri/store` | stockage Rust : plans d'écriture atomiques, migrations, sauvegardes, restauration |
| `src/domain` | types, montants, dates |
| `src/engine` | moteur de calcul pur (soldes, couverture, échéances, suivi, crédits, fonds, prévision, patrimoine) |
| `src/services` | écritures validées et journalisées |
| `src/import`, `src/export` | format d'import unique, lecture, contrôles ; exports |
| `src/ui` | écrans React (aucun calcul financier) |
| `tests/` | moteur, stockage, import, exports, e2e |

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Règles de calcul](docs/REGLES_DE_CALCUL.md)
- [Format d'import](docs/FORMAT_IMPORT.md)
- [Guide utilisateur](docs/GUIDE_UTILISATEUR.md)
- [Vérifications sur le Mac](docs/VERIFICATION_MAC.md)
- [Maquette](docs/maquette/vue-ensemble.html)
