//! Stockage local de DS Finances : base SQLite unique, migrations versionnées,
//! écritures atomiques et sauvegardes. Aucun calcul financier ici (voir docs/ARCHITECTURE.md § 2).

pub mod backup;
pub mod db;
pub mod migrations;

use thiserror::Error;

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("erreur SQLite : {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("erreur de fichier : {0}")]
    Io(#[from] std::io::Error),
    #[error("erreur JSON : {0}")]
    Json(#[from] serde_json::Error),
    #[error("{0}")]
    Message(String),
}

impl StoreError {
    pub fn msg(s: impl Into<String>) -> Self {
        StoreError::Message(s.into())
    }
}

impl serde::Serialize for StoreError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

pub type Result<T> = std::result::Result<T, StoreError>;

pub fn now_utc() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
