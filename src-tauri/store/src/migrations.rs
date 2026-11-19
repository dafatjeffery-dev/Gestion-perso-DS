//! Migrations SQL numérotées, partagées avec l'aperçu navigateur (dossier `migrations/`).

use crate::{now_utc, Result, StoreError};
use rusqlite::Connection;
use sha2::{Digest, Sha256};

#[derive(Debug, Clone)]
pub struct Migration {
    pub version: i64,
    pub name: &'static str,
    pub sql: &'static str,
}

/// Migrations embarquées dans le binaire.
pub fn embedded() -> Vec<Migration> {
    vec![
        Migration { version: 1, name: "0001_init", sql: include_str!("../../../migrations/0001_init.sql") },
        Migration { version: 2, name: "0002_referentiels", sql: include_str!("../../../migrations/0002_referentiels.sql") },
    ]
}

pub fn checksum(sql: &str) -> String {
    let mut h = Sha256::new();
    // normalisation des fins de ligne : même somme sous macOS, Linux et Windows
    h.update(sql.replace("\r\n", "\n").as_bytes());
    format!("{:x}", h.finalize())
}

#[derive(Debug, PartialEq, Eq)]
pub enum SchemaState {
    UpToDate,
    Pending(Vec<i64>),
    /// La base a été écrite par une version plus récente de l'application.
    Newer { db: i64, app: i64 },
}

fn ensure_table(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
            version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)",
    )?;
    Ok(())
}

pub fn current_version(conn: &Connection) -> Result<i64> {
    ensure_table(conn)?;
    Ok(conn.query_row("SELECT COALESCE(MAX(version), 0) FROM schema_migrations", [], |r| r.get(0))?)
}

/// Vérifie les sommes de contrôle et indique les migrations en attente.
pub fn inspect(conn: &Connection, migrations: &[Migration]) -> Result<SchemaState> {
    ensure_table(conn)?;
    let mut stmt = conn.prepare("SELECT version, name, checksum FROM schema_migrations ORDER BY version")?;
    let applied: Vec<(i64, String, String)> =
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?.collect::<std::result::Result<_, _>>()?;
    let app_max = migrations.iter().map(|m| m.version).max().unwrap_or(0);
    for (v, name, sum) in &applied {
        match migrations.iter().find(|m| m.version == *v) {
            Some(m) if checksum(m.sql) != *sum => {
                return Err(StoreError::msg(format!(
                    "La migration {name} appliquée à cette base a été modifiée depuis : démarrage refusé."
                )))
            }
            Some(_) => {}
            None if *v > app_max => return Ok(SchemaState::Newer { db: *v, app: app_max }),
            None => return Err(StoreError::msg(format!("Migration {name} inconnue de cette version."))),
        }
    }
    let pending: Vec<i64> =
        migrations.iter().map(|m| m.version).filter(|v| !applied.iter().any(|(a, _, _)| a == v)).collect();
    Ok(if pending.is_empty() { SchemaState::UpToDate } else { SchemaState::Pending(pending) })
}

/// Applique les migrations en attente, chacune dans sa transaction, puis contrôle l'intégrité.
/// En cas d'échec, la migration fautive est annulée et l'erreur remontée.
pub fn apply_pending(conn: &mut Connection, migrations: &[Migration]) -> Result<Vec<i64>> {
    let state = inspect(conn, migrations)?;
    let pending = match state {
        SchemaState::UpToDate => return Ok(vec![]),
        SchemaState::Newer { db, app } => {
            return Err(StoreError::msg(format!(
                "Base au schéma {db}, plus récent que l'application ({app}) : ouverture en lecture seule."
            )))
        }
        SchemaState::Pending(p) => p,
    };
    let mut done = vec![];
    for v in pending {
        let m = migrations.iter().find(|m| m.version == v).expect("migration connue");
        let tx = conn.transaction()?;
        tx.execute_batch(m.sql).map_err(|e| StoreError::msg(format!("Migration {} : {e}", m.name)))?;
        tx.execute(
            "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![m.version, m.name, checksum(m.sql), now_utc()],
        )?;
        crate::db::check_integrity(&tx)?;
        tx.pragma_update(None, "user_version", m.version)?;
        tx.commit()?;
        done.push(v);
    }
    Ok(done)
}

/// Version de schéma d'une base ouverte en lecture seule (0 si jamais migrée).
pub fn current_version_readonly(conn: &Connection) -> Result<i64> {
    let exists: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
        [],
        |r| r.get(0),
    )?;
    if exists == 0 {
        return Ok(0);
    }
    Ok(conn.query_row("SELECT COALESCE(MAX(version), 0) FROM schema_migrations", [], |r| r.get(0))?)
}
