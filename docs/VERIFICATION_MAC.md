# Vérifications à faire sur le Mac réel

Les tests automatisés couvrent le moteur, le stockage (sql.js et rusqlite) et l'interface dans l'**aperçu navigateur** (Chromium). Ils ne valident pas l'application Mac compilée : Tauri ne fournit pas de pilote WebDriver sur macOS, et le développement s'est fait sous Linux (où le Rust compile et ses tests passent).

## Préparer

```bash
xcode-select --install
```

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

```bash
npm install
```

```bash
cd src-tauri && cargo test --workspace && cd ..
```

```bash
npm test
```

```bash
npm run tauri build
```

L'application est produite dans `src-tauri/target/release/bundle/macos/DS Finances.app` (et un `.dmg`). Non signée : au premier lancement, clic droit › Ouvrir.

## Liste de contrôle

| # | Vérification | Attendu |
|---|---|---|
| 1 | Lancer l'application | Paramètres › Données affiche « Données enregistrées sur ce Mac : ~/Library/Application Support/fr.dsfinances.app/ds-finances.sqlite » ; aucun bandeau « Aperçu navigateur » |
| 2 | Créer un compte, quitter (⌘Q), relancer | Le compte est là ; une sauvegarde « fermeture » puis « démarrage » apparaît dans la liste |
| 3 | Modifier une opération, attendre 10 minutes | Une sauvegarde « automatique » apparaît |
| 4 | Ouvrir un formulaire, taper, fermer la fenêtre | Boîte « Modifications non enregistrées » (Enregistrer / Abandonner / Rester) |
| 5 | Taper dans un formulaire, forcer la fermeture (Moniteur d'activité), relancer, rouvrir le même formulaire | « Brouillon non enregistré du … » proposé, rien d'enregistré |
| 6 | Paramètres › Données › Restaurer… une ancienne sauvegarde | Résumé ; après confirmation, données de la sauvegarde ; une sauvegarde « avant restauration » existe |
| 7 | Importer › Télécharger le modèle (.xlsx) | Boîte « Enregistrer sous » ; le fichier s'ouvre dans Numbers / Excel avec 4 feuilles |
| 8 | Copier les consignes pour l'IA | Le texte est dans le presse-papiers |
| 9 | Importer un fichier rempli | Aperçu, confirmation, lot dans l'historique |
| 10 | Exports complet et lisibles | Boîte « Enregistrer sous », fichiers lisibles |
| 11 | Taux › Récupérer les taux (BCE) | Taux ajoutés, source « BCE » (si la connexion échoue : message clair, rien d'écrit) |
| 12 | Mode sombre de macOS | Interface lisible, graphiques contrastés |
| 13 | Installer une version plus récente du schéma (future mise à jour) | Sauvegarde « avant migration » créée avant la mise à jour de la base |
