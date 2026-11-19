//! Accès à la base : lectures (`query`) et plans d'écriture atomiques (`apply`).

use crate::{Result, StoreError};
use rusqlite::types::{Value as SqlValue, ValueRef};
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};

/// Une instruction d'un plan d'écriture. Un paramètre `{"$ref": n}` est remplacé par
/// l'identifiant inséré par l'instruction n° n du même plan (création de lignes liées).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Stmt {
    pub sql: String,
    #[serde(default)]
    pub params: Vec<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ApplyResult {
    pub inserted_ids: Vec<i64>,
    pub changes: Vec<usize>,
}

pub fn open_connection(path: &Path) -> Result<Connection> {
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    configure(&conn)?;
    Ok(conn)
}

pub fn configure(conn: &Connection) -> Result<()> {
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "FULL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    Ok(())
}

pub fn check_integrity(conn: &Connection) -> Result<()> {
    let ok: String = conn.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
    if ok != "ok" {
        return Err(StoreError::msg(format!("Contrôle d'intégrité en échec : {ok}")));
    }
    let mut stmt = conn.prepare("PRAGMA foreign_key_check")?;
    let mut rows = stmt.query([])?;
    if let Some(row) = rows.next()? {
        let table: String = row.get(0)?;
        return Err(StoreError::msg(format!("Référence invalide dans la table {table}")));
    }
    Ok(())
}

fn to_sql(v: &Value, inserted: &[i64]) -> Result<SqlValue> {
    Ok(match v {
        Value::Null => SqlValue::Null,
        Value::Bool(b) => SqlValue::Integer(*b as i64),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                SqlValue::Integer(i)
            } else {
                return Err(StoreError::msg(format!("Nombre non entier refusé : {n} (montants en unités mineures)")));
            }
        }
        Value::String(s) => SqlValue::Text(s.clone()),
        Value::Object(o) if o.len() == 1 && o.contains_key("$ref") => {
            let idx = o["$ref"].as_u64().ok_or_else(|| StoreError::msg("$ref invalide"))? as usize;
            let id = *inserted.get(idx).ok_or_else(|| StoreError::msg(format!("$ref {idx} hors plan")))?;
            if id == 0 {
                return Err(StoreError::msg(format!("$ref {idx} ne désigne pas une insertion")));
            }
            SqlValue::Integer(id)
        }
        other => return Err(StoreError::msg(format!("Paramètre non pris en charge : {other}"))),
    })
}

fn from_sql(v: ValueRef<'_>) -> Value {
    match v {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) => Value::from(i),
        ValueRef::Real(f) => Value::from(f),
        ValueRef::Text(t) => Value::String(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(b) => Value::String(format!("<blob {} octets>", b.len())),
    }
}

/// Lecture seule : toute instruction qui modifierait la base est refusée.
pub fn query(conn: &Connection, sql: &str, params: &[Value]) -> Result<Vec<Map<String, Value>>> {
    let mut stmt = conn.prepare(sql)?;
    if !stmt.readonly() {
        return Err(StoreError::msg("db_query n'accepte que des lectures"));
    }
    let names: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
    let values: Vec<SqlValue> = params.iter().map(|p| to_sql(p, &[])).collect::<Result<_>>()?;
    let mut rows = stmt.query(rusqlite::params_from_iter(values.iter()))?;
    let mut out = vec![];
    while let Some(row) = rows.next()? {
        let mut m = Map::new();
        for (i, n) in names.iter().enumerate() {
            m.insert(n.clone(), from_sql(row.get_ref(i)?));
        }
        out.push(m);
    }
    Ok(out)
}

/// Exécute un plan d'écriture en une transaction : tout ou rien.
pub fn apply(conn: &mut Connection, plan: &[Stmt]) -> Result<ApplyResult> {
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let mut inserted = Vec::with_capacity(plan.len());
    let mut changes = Vec::with_capacity(plan.len());
    for (i, s) in plan.iter().enumerate() {
        let values: Vec<SqlValue> = s.params.iter().map(|p| to_sql(p, &inserted)).collect::<Result<_>>()?;
        let n = tx
            .execute(&s.sql, rusqlite::params_from_iter(values.iter()))
            .map_err(|e| StoreError::msg(format!("Instruction {i} : {e}")))?;
        let after = tx.last_insert_rowid();
        let is_insert = s.sql.trim_start().to_ascii_uppercase().starts_with("INSERT");
        inserted.push(if is_insert && n > 0 { after } else { 0 });
        changes.push(n);
    }
    {
        let mut stmt = tx.prepare("PRAGMA foreign_key_check")?;
        let mut rows = stmt.query([])?;
        if let Some(row) = rows.next()? {
            let table: String = row.get(0)?;
            return Err(StoreError::msg(format!("Référence invalide dans la table {table}")));
        }
    }
    tx.commit()?;
    Ok(ApplyResult { inserted_ids: inserted, changes })
}

/// Nombre de lignes par table utilisateur (manifeste des sauvegardes, résumé de restauration).
pub fn table_counts(conn: &Connection) -> Result<Vec<(String, i64)>> {
    let mut stmt = conn.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )?;
    let names: Vec<String> = stmt.query_map([], |r| r.get(0))?.collect::<std::result::Result<_, _>>()?;
    let mut out = vec![];
    for n in names {
        let c: i64 = conn.query_row(&format!("SELECT COUNT(*) FROM \"{}\"", n.replace('"', "\"\"")), [], |r| r.get(0))?;
        out.push((n, c));
    }
    Ok(out)
}

/// Emplacements des données.
#[derive(Debug, Clone, Serialize)]
pub struct Locations {
    pub data_dir: PathBuf,
    pub database: PathBuf,
    pub backups_dir: PathBuf,
    pub drafts: PathBuf,
}

impl Locations {
    pub fn new(data_dir: PathBuf, backups_dir: Option<PathBuf>) -> Self {
        Locations {
            database: data_dir.join("ds-finances.sqlite"),
            drafts: data_dir.join("drafts.json"),
            backups_dir: backups_dir.unwrap_or_else(|| data_dir.join("backups")),
            data_dir,
        }
    }
}
