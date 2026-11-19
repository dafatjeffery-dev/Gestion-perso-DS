# DS Finances

Application locale de pilotage financier d'un foyer (EUR/CHF). Tauri 2 + TypeScript + React + SQLite.

## Commandes

```bash
npm install
npm run dev          # aperçu navigateur (données dans le navigateur, pas sur le Mac)
npm test             # moteur, stockage (sql.js), services
npm run test:e2e     # interface dans Chromium, sur l'aperçu navigateur
cd src-tauri && cargo test --workspace   # stockage réel, migrations, sauvegardes
npm run tauri dev    # application Mac (sur le Mac)
npm run tauri build  # paquet .app / .dmg (sur le Mac)
```

Sur le Mac, `npx playwright install chromium` est nécessaire une fois avant `npm run test:e2e`.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Maquette de la vue d'ensemble](docs/maquette/vue-ensemble.html) (données fictives)
