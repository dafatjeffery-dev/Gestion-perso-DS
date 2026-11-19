//! Sauvegardes : copie à chaud (API SQLite online backup), manifeste, vérification,
//! rotation, restauration sur copie isolée. Voir docs/ARCHITECTURE.md § 8.

use crate::db::{self, check_integrity, table_counts, Locations};
use crate::migrations::{self, Migration};
use crate::{now_utc, Result, StoreError};
use chrono::{DateTime, Datelike, Duration, NaiveDateTime, Utc};
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Reason {
    Demarrage,
    AvantMigration,
    AvantRestauration,
    AvantNouveauDepart,
    Automatique,
    Fermeture,
    Manuelle,
}

impl Reason {
    pub fn slug(self) -> &'static str {
        match self {
            Reason::Demarrage => "demarrage",
            Reason::AvantMigration => "avant-migration",
            Reason::AvantRestauration => "avant-restauration",
            Reason::AvantNouveauDepart => "avant-nouveau-depart",
            Reason::Automatique => "automatique",
            Reason::Fermeture => "fermeture",
            Reason::Manuelle => "manuelle",
        }
    }
    pub fn is_safety(self) -> bool {
        matches!(self, Reason::AvantMigration | Reason::AvantRestauration | Reason::AvantNouveauDepart)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Manifest {
    pub file: String,
    pub created_at: String,
    pub reason: Reason,
    pub app_version: String,
    pub schema_version: i64,
    pub sha256: String,
    pub size_bytes: u64,
    pub table_counts: BTreeMap<String, i64>,
}

pub fn sha256_file(path: &Path) -> Result<String> {
    let bytes = fs::read(path)?;
    let mut h = Sha256::new();
    h.update(&bytes);
    Ok(format!("{:x}", h.finalize()))
}

fn stamp(now: DateTime<Utc>) -> String {
    now.format("%Y%m%d-%H%M%S%.3f").to_string().replace('.', "")
}

/// Copie la base ouverte `conn` dans `dir` et écrit le manifeste. La copie est vérifiée
/// (intégrité, nombre de lignes) avant d'être déclarée valide.
pub fn backup_now(conn: &Connection, dir: &Path, reason: Reason, app_version: &str) -> Result<Manifest> {
    fs::create_dir_all(dir)?;
    let now = Utc::now();
    let base = format!("ds-finances-{}-{}", stamp(now), reason.slug());
    let tmp = dir.join(format!("{base}.sqlite.partial"));
    let final_path = dir.join(format!("{base}.sqlite"));
    {
        let mut dst = Connection::open(&tmp)?;
        {
            let b = rusqlite::backup::Backup::new(conn, &mut dst)?;
            b.run_to_completion(256, std::time::Duration::from_millis(0), None)?;
        }
        // la copie hérite du mode WAL de la source : fichier autonome, sans -wal ni -shm
        dst.pragma_update(None, "journal_mode", "DELETE")?;
    }
    let counts_src: BTreeMap<String, i64> = table_counts(conn)?.into_iter().collect();
    let (schema_version, counts_copy) = {
        let c = Connection::open_with_flags(&tmp, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        check_integrity(&c)?;
        (migrations::current_version_readonly(&c)?, table_counts(&c)?.into_iter().collect::<BTreeMap<_, _>>())
    };
    if counts_src != counts_copy {
        let _ = fs::remove_file(&tmp);
        return Err(StoreError::msg("Sauvegarde incomplète : nombre de lignes différent de la base"));
    }
    for ext in ["partial-wal", "partial-shm"] {
        let _ = fs::remove_file(tmp.with_extension(format!("sqlite.{ext}")));
    }
    fs::rename(&tmp, &final_path)?;
    let manifest = Manifest {
        file: final_path.file_name().unwrap().to_string_lossy().into_owned(),
        created_at: now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        reason,
        app_version: app_version.to_string(),
        schema_version,
        sha256: sha256_file(&final_path)?,
        size_bytes: fs::metadata(&final_path)?.len(),
        table_counts: counts_copy,
    };
    fs::write(dir.join(format!("{base}.json")), serde_json::to_vec_pretty(&manifest)?)?;
    Ok(manifest)
}

/// Liste les sauvegardes valides (manifeste présent), de la plus récente à la plus ancienne.
pub fn list(dir: &Path) -> Result<Vec<Manifest>> {
    let mut out = vec![];
    if !dir.exists() {
        return Ok(out);
    }
    for entry in fs::read_dir(dir)? {
        let p = entry?.path();
        if p.extension().and_then(|e| e.to_str()) == Some("json") {
            if let Ok(m) = serde_json::from_slice::<Manifest>(&fs::read(&p)?) {
                if dir.join(&m.file).exists() {
                    out.push(m);
                }
            }
        }
    }
    out.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(out)
}

fn parse_ts(s: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(s)
        .map(|d| d.with_timezone(&Utc))
        .unwrap_or_else(|_| NaiveDateTime::default().and_utc())
}

/// Politique de rotation (fonction pure) : renvoie les fichiers à supprimer.
/// Conservées : les 10 plus récentes ; la plus récente de chaque jour sur 14 jours,
/// de chaque semaine sur 8 semaines, de chaque mois sur 12 mois ; les sauvegardes de
/// sécurité (avant migration / restauration / nouveau départ) pendant 90 jours.
pub fn rotation_to_delete(backups: &[Manifest], now: DateTime<Utc>) -> Vec<String> {
    let mut sorted: Vec<&Manifest> = backups.iter().collect();
    sorted.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    let mut keep = std::collections::HashSet::new();
    for m in sorted.iter().take(10) {
        keep.insert(m.file.clone());
    }
    let mut seen_day = std::collections::HashSet::new();
    let mut seen_week = std::collections::HashSet::new();
    let mut seen_month = std::collections::HashSet::new();
    for m in &sorted {
        let t = parse_ts(&m.created_at);
        let age = now - t;
        if m.reason.is_safety() && age <= Duration::days(90) {
            keep.insert(m.file.clone());
        }
        if age <= Duration::days(14) && seen_day.insert(t.date_naive()) {
            keep.insert(m.file.clone());
        }
        let w = t.iso_week();
        if age <= Duration::weeks(8) && seen_week.insert((w.year(), w.week())) {
            keep.insert(m.file.clone());
        }
        if age <= Duration::days(366) && seen_month.insert((t.year(), t.month())) {
            keep.insert(m.file.clone());
        }
    }
    sorted.iter().filter(|m| !keep.contains(&m.file)).map(|m| m.file.clone()).collect()
}

pub fn rotate(dir: &Path, now: DateTime<Utc>) -> Result<Vec<String>> {
    let all = list(dir)?;
    let del = rotation_to_delete(&all, now);
    for f in &del {
        let p = dir.join(f);
        let _ = fs::remove_file(&p);
        let _ = fs::remove_file(p.with_extension("json"));
    }
    Ok(del)
}

#[derive(Debug, Clone, Serialize)]
pub struct RestorePreview {
    pub backup_file: String,
    pub created_at: String,
    pub schema_version_before: i64,
    pub schema_version_after: i64,
    pub table_counts: BTreeMap<String, i64>,
    pub staged_path: PathBuf,
}

/// Étape 1 de la restauration : copie isolée, contrôle de la somme et de l'intégrité,
/// migration de la copie si nécessaire. La base courante n'est pas touchée.
pub fn stage_restore(backup_dir: &Path, file: &str, staging_dir: &Path, migs: &[Migration]) -> Result<RestorePreview> {
    let src = backup_dir.join(file);
    let manifest: Manifest = serde_json::from_slice(&fs::read(src.with_extension("json"))?)?;
    if sha256_file(&src)? != manifest.sha256 {
        return Err(StoreError::msg("Sauvegarde altérée : somme de contrôle différente du manifeste"));
    }
    fs::create_dir_all(staging_dir)?;
    let staged = staging_dir.join(format!("restauration-{}.sqlite", stamp(Utc::now())));
    fs::copy(&src, &staged)?;
    let mut c = Connection::open(&staged)?;
    c.pragma_update(None, "foreign_keys", "ON")?;
    check_integrity(&c)?;
    let before = migrations::current_version(&c)?;
    migrations::apply_pending(&mut c, migs)?;
    let after = migrations::current_version(&c)?;
    let counts = table_counts(&c)?.into_iter().collect();
    c.pragma_update(None, "journal_mode", "DELETE")?;
    drop(c);
    Ok(RestorePreview {
        backup_file: file.to_string(),
        created_at: manifest.created_at,
        schema_version_before: before,
        schema_version_after: after,
        table_counts: counts,
        staged_path: staged,
    })
}

/// Base ouverte + état des sauvegardes automatiques.
pub struct Store {
    pub loc: Locations,
    pub conn: Connection,
    pub app_version: String,
    pub dirty: bool,
    pub last_backup: Option<Instant>,
    pub last_manifest: Option<Manifest>,
    pub read_only: bool,
    migs: Vec<Migration>,
}

impl Store {
    /// Ouvre (ou crée) la base. Sauvegarde de démarrage si elle existait déjà ;
    /// sauvegarde « avant migration » si des migrations sont en attente.
    pub fn open(loc: Locations, app_version: &str, migs: Vec<Migration>) -> Result<Store> {
        fs::create_dir_all(&loc.data_dir)?;
        let existed = loc.database.exists();
        let mut conn = db::open_connection(&loc.database)?;
        let mut last_manifest = None;
        if existed {
            last_manifest = Some(backup_now(&conn, &loc.backups_dir, Reason::Demarrage, app_version)?);
        }
        let mut read_only = false;
        match migrations::inspect(&conn, &migs)? {
            migrations::SchemaState::UpToDate => {}
            migrations::SchemaState::Newer { .. } => {
                read_only = true;
                conn.pragma_update(None, "query_only", "ON")?;
            }
            migrations::SchemaState::Pending(_) => {
                if existed && migrations::current_version(&conn)? > 0 {
                    last_manifest = Some(backup_now(&conn, &loc.backups_dir, Reason::AvantMigration, app_version)?);
                }
                migrations::apply_pending(&mut conn, &migs)?;
            }
        }
        let _ = rotate(&loc.backups_dir, Utc::now());
        Ok(Store {
            loc,
            conn,
            app_version: app_version.to_string(),
            dirty: false,
            last_backup: last_manifest.as_ref().map(|_| Instant::now()),
            last_manifest,
            read_only,
            migs,
        })
    }

    pub fn apply(&mut self, plan: &[db::Stmt]) -> Result<db::ApplyResult> {
        if self.read_only {
            return Err(StoreError::msg("Base en lecture seule (schéma plus récent que l'application)"));
        }
        let r = db::apply(&mut self.conn, plan)?;
        self.dirty = true;
        Ok(r)
    }

    pub fn backup(&mut self, reason: Reason) -> Result<Manifest> {
        let m = backup_now(&self.conn, &self.loc.backups_dir, reason, &self.app_version)?;
        self.dirty = false;
        self.last_backup = Some(Instant::now());
        self.last_manifest = Some(m.clone());
        let _ = rotate(&self.loc.backups_dir, Utc::now());
        Ok(m)
    }

    /// Sauvegarde automatique : au plus toutes les `min_interval` s'il y a eu des changements.
    pub fn maybe_autobackup(&mut self, min_interval: std::time::Duration) -> Result<Option<Manifest>> {
        let due = self.dirty && self.last_backup.map(|t| t.elapsed() >= min_interval).unwrap_or(true);
        if due {
            return self.backup(Reason::Automatique).map(Some);
        }
        Ok(None)
    }

    pub fn on_close(&mut self) -> Result<Option<Manifest>> {
        if self.dirty {
            return self.backup(Reason::Fermeture).map(Some);
        }
        Ok(None)
    }

    pub fn stage_restore(&self, file: &str) -> Result<RestorePreview> {
        stage_restore(&self.loc.backups_dir, file, &self.loc.data_dir.join("restauration"), &self.migs)
    }

    /// Étape 2 : sauvegarde de l'état courant, remplacement atomique, réouverture.
    pub fn commit_restore(&mut self, preview: &RestorePreview) -> Result<Manifest> {
        let safety = backup_now(&self.conn, &self.loc.backups_dir, Reason::AvantRestauration, &self.app_version)?;
        self.conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")?;
        let placeholder = Connection::open_in_memory()?;
        let old = std::mem::replace(&mut self.conn, placeholder);
        drop(old);
        let db_path = &self.loc.database;
        for ext in ["sqlite-wal", "sqlite-shm"] {
            let _ = fs::remove_file(db_path.with_extension(ext));
        }
        let incoming = db_path.with_extension("sqlite.incoming");
        fs::copy(&preview.staged_path, &incoming)?;
        fs::rename(&incoming, db_path)?;
        let _ = fs::remove_file(&preview.staged_path);
        self.conn = db::open_connection(db_path)?;
        check_integrity(&self.conn)?;
        self.dirty = false;
        self.last_manifest = Some(safety.clone());
        Ok(safety)
    }

    /// « Nouveau départ » : sauvegarde puis base vide (migrations seules).
    pub fn fresh_start(&mut self) -> Result<Manifest> {
        let safety = backup_now(&self.conn, &self.loc.backups_dir, Reason::AvantNouveauDepart, &self.app_version)?;
        let placeholder = Connection::open_in_memory()?;
        drop(std::mem::replace(&mut self.conn, placeholder));
        let db_path = &self.loc.database;
        for ext in ["sqlite-wal", "sqlite-shm"] {
            let _ = fs::remove_file(db_path.with_extension(ext));
        }
        fs::remove_file(db_path)?;
        let mut conn = db::open_connection(db_path)?;
        migrations::apply_pending(&mut conn, &self.migs)?;
        self.conn = conn;
        self.dirty = false;
        Ok(safety)
    }

    pub fn status(&self) -> StoreStatus {
        StoreStatus {
            locations: self.loc.clone(),
            read_only: self.read_only,
            dirty: self.dirty,
            last_backup: self.last_manifest.clone(),
            now: now_utc(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct StoreStatus {
    pub locations: Locations,
    pub read_only: bool,
    pub dirty: bool,
    pub last_backup: Option<Manifest>,
    pub now: String,
}
