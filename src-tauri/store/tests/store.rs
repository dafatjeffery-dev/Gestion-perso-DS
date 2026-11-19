//! Tests du stockage réel (rusqlite) sur fichiers temporaires.

use ds_store::backup::{self, Manifest, Reason, Store};
use ds_store::db::{self, Locations, Stmt};
use ds_store::migrations::{self, Migration};
use serde_json::json;

fn open(dir: &std::path::Path) -> Store {
    Store::open(Locations::new(dir.to_path_buf(), None), "test", migrations::embedded()).unwrap()
}

fn insert_account(s: &mut Store, name: &str, currency: &str) -> i64 {
    let r = s
        .apply(&[Stmt {
            sql: "INSERT INTO account (name, currency, owner, type) VALUES (?1, ?2, 'commun', 'courant')".into(),
            params: vec![json!(name), json!(currency)],
        }])
        .unwrap();
    r.inserted_ids[0]
}

#[test]
fn creation_applique_toutes_les_migrations() {
    let d = tempfile::tempdir().unwrap();
    let s = open(d.path());
    assert_eq!(migrations::current_version(&s.conn).unwrap(), 2);
    let n: i64 = s.conn.query_row("SELECT COUNT(*) FROM rubrique WHERE ref = 'SYS.TECH.A_CLASSER'", [], |r| r.get(0)).unwrap();
    assert_eq!(n, 1);
    // base neuve : pas de sauvegarde de démarrage
    assert!(backup::list(&s.loc.backups_dir).unwrap().is_empty());
}

#[test]
fn plan_atomique_tout_ou_rien() {
    let d = tempfile::tempdir().unwrap();
    let mut s = open(d.path());
    let plan = vec![
        Stmt { sql: "INSERT INTO account (name, currency, owner, type) VALUES ('A', 'EUR', 'commun', 'courant')".into(), params: vec![] },
        Stmt { sql: "INSERT INTO account (name, currency, owner, type) VALUES ('B', 'USD', 'commun', 'courant')".into(), params: vec![] },
    ];
    assert!(s.apply(&plan).is_err());
    let n: i64 = s.conn.query_row("SELECT COUNT(*) FROM account", [], |r| r.get(0)).unwrap();
    assert_eq!(n, 0, "aucune écriture partielle");
}

#[test]
fn reference_ref_dans_un_plan() {
    let d = tempfile::tempdir().unwrap();
    let mut s = open(d.path());
    let r = s
        .apply(&[
            Stmt { sql: "INSERT INTO account (name, currency, owner, type) VALUES ('A', 'CHF', 'A', 'courant')".into(), params: vec![] },
            Stmt {
                sql: "INSERT INTO balance_reference (account_id, ref_date, amount_minor) VALUES (?1, '2026-10-31', 123456)".into(),
                params: vec![json!({"$ref": 0})],
            },
        ])
        .unwrap();
    let acc: i64 = s.conn.query_row("SELECT account_id FROM balance_reference", [], |r| r.get(0)).unwrap();
    assert_eq!(acc, r.inserted_ids[0]);
}

#[test]
fn contraintes_devise_et_nature() {
    let d = tempfile::tempdir().unwrap();
    let mut s = open(d.path());
    let acc = insert_account(&mut s, "Courant CHF", "CHF");
    let courses: i64 = s.conn.query_row("SELECT id FROM rubrique WHERE ref='DEP.ALIM.COURSES'", [], |r| r.get(0)).unwrap();
    let ins = |cur: &str, nature: &str| Stmt {
        sql: "INSERT INTO movement (granularity, account_id, op_date, period_month, amount_minor, currency, nature, rubrique_id, created_at, updated_at)
              VALUES ('operation', ?1, '2026-11-02', '2026-11', -1250, ?2, ?3, ?4, 'x', 'x')".into(),
        params: vec![json!(acc), json!(cur), json!(nature), json!(courses)],
    };
    let e = s.apply(&[ins("EUR", "depense")]).unwrap_err().to_string();
    assert!(e.contains("devise"), "{e}");
    let e = s.apply(&[ins("CHF", "revenu_ordinaire")]).unwrap_err().to_string();
    assert!(e.contains("nature incompatible"), "{e}");
    s.apply(&[ins("CHF", "depense")]).unwrap();
    // un total synthétique ne peut pas porter de compte
    let e = s.apply(&[Stmt {
        sql: "INSERT INTO movement (granularity, account_id, period_month, amount_minor, currency, nature, rubrique_id, created_at, updated_at)
              VALUES ('total', ?1, '2026-11', -5000, 'CHF', 'depense', ?2, 'x', 'x')".into(),
        params: vec![json!(acc), json!(courses)],
    }]);
    assert!(e.is_err());
}

#[test]
fn query_refuse_les_ecritures() {
    let d = tempfile::tempdir().unwrap();
    let s = open(d.path());
    assert!(db::query(&s.conn, "DELETE FROM account", &[]).is_err());
    let rows = db::query(&s.conn, "SELECT code FROM nature WHERE code = ?1", &[json!("epargne")]).unwrap();
    assert_eq!(rows[0]["code"], json!("epargne"));
}

#[test]
fn persistance_apres_fermeture_et_reouverture() {
    let d = tempfile::tempdir().unwrap();
    {
        let mut s = open(d.path());
        insert_account(&mut s, "Livret", "EUR");
        s.on_close().unwrap();
    }
    let s = open(d.path());
    let n: i64 = s.conn.query_row("SELECT COUNT(*) FROM account WHERE name='Livret'", [], |r| r.get(0)).unwrap();
    assert_eq!(n, 1);
    let l = backup::list(&s.loc.backups_dir).unwrap();
    assert!(l.iter().any(|m| m.reason == Reason::Fermeture));
    assert!(l.iter().any(|m| m.reason == Reason::Demarrage));
}

#[test]
fn migration_ulterieure_precedee_d_une_sauvegarde_et_donnees_conservees() {
    let d = tempfile::tempdir().unwrap();
    {
        let mut s = open(d.path());
        insert_account(&mut s, "Courant", "EUR");
    }
    let mut migs = migrations::embedded();
    migs.push(Migration { version: 3, name: "0003_test", sql: "ALTER TABLE account ADD COLUMN iban_hint TEXT;" });
    let s = Store::open(Locations::new(d.path().to_path_buf(), None), "test", migs).unwrap();
    assert_eq!(migrations::current_version(&s.conn).unwrap(), 3);
    let n: i64 = s.conn.query_row("SELECT COUNT(*) FROM account", [], |r| r.get(0)).unwrap();
    assert_eq!(n, 1);
    let l = backup::list(&s.loc.backups_dir).unwrap();
    let avant = l.iter().find(|m| m.reason == Reason::AvantMigration).expect("sauvegarde avant migration");
    assert_eq!(avant.schema_version, 2);
}

#[test]
fn migration_en_echec_ne_modifie_rien() {
    let d = tempfile::tempdir().unwrap();
    {
        let mut s = open(d.path());
        insert_account(&mut s, "Courant", "EUR");
    }
    let mut migs = migrations::embedded();
    migs.push(Migration { version: 3, name: "0003_casse", sql: "ALTER TABLE account ADD COLUMN x TEXT; SELECT * FROM table_inexistante;" });
    assert!(Store::open(Locations::new(d.path().to_path_buf(), None), "test", migs).is_err());
    let s = open(d.path());
    assert_eq!(migrations::current_version(&s.conn).unwrap(), 2);
    let cols: i64 = s.conn.query_row("SELECT COUNT(*) FROM pragma_table_info('account') WHERE name='x'", [], |r| r.get(0)).unwrap();
    assert_eq!(cols, 0);
}

#[test]
fn migration_modifiee_detectee() {
    let d = tempfile::tempdir().unwrap();
    drop(open(d.path()));
    let mut migs = migrations::embedded();
    migs[1].sql = "-- modifiée";
    let e = Store::open(Locations::new(d.path().to_path_buf(), None), "test", migs).err().unwrap().to_string();
    assert!(e.contains("modifiée"), "{e}");
}

#[test]
fn base_plus_recente_ouverte_en_lecture_seule() {
    let d = tempfile::tempdir().unwrap();
    {
        let s = open(d.path());
        s.conn.execute("INSERT INTO schema_migrations VALUES (99, '0099_futur', 'x', 'x')", []).unwrap();
    }
    let mut s = open(d.path());
    assert!(s.read_only);
    assert!(s.apply(&[Stmt { sql: "DELETE FROM account".into(), params: vec![] }]).is_err());
}

#[test]
fn sauvegarde_recente_contient_les_dernieres_modifications_et_se_restaure() {
    let d = tempfile::tempdir().unwrap();
    let mut s = open(d.path());
    insert_account(&mut s, "Avant sauvegarde", "EUR");
    let m = s.backup(Reason::Manuelle).unwrap();
    assert_eq!(m.table_counts["account"], 1);
    insert_account(&mut s, "Après sauvegarde", "EUR");
    let preview = s.stage_restore(&m.file).unwrap();
    assert_eq!(preview.table_counts["account"], 1);
    // la base courante n'a pas bougé pendant la préparation
    let n: i64 = s.conn.query_row("SELECT COUNT(*) FROM account", [], |r| r.get(0)).unwrap();
    assert_eq!(n, 2);
    let safety = s.commit_restore(&preview).unwrap();
    assert_eq!(safety.reason, Reason::AvantRestauration);
    assert_eq!(safety.table_counts["account"], 2, "l'état courant est sauvegardé avant restauration");
    let names: Vec<String> = s.conn.prepare("SELECT name FROM account").unwrap()
        .query_map([], |r| r.get(0)).unwrap().map(|x| x.unwrap()).collect();
    assert_eq!(names, vec!["Avant sauvegarde".to_string()]);
    // et reste après réouverture
    drop(s);
    let s = open(d.path());
    let n: i64 = s.conn.query_row("SELECT COUNT(*) FROM account", [], |r| r.get(0)).unwrap();
    assert_eq!(n, 1);
}

#[test]
fn sauvegarde_alteree_refusee() {
    let d = tempfile::tempdir().unwrap();
    let mut s = open(d.path());
    let m = s.backup(Reason::Manuelle).unwrap();
    let p = s.loc.backups_dir.join(&m.file);
    let mut bytes = std::fs::read(&p).unwrap();
    let last = bytes.len() - 1;
    bytes[last] ^= 0xff;
    std::fs::write(&p, bytes).unwrap();
    assert!(s.stage_restore(&m.file).is_err());
}

#[test]
fn sauvegarde_automatique_seulement_si_changements() {
    let d = tempfile::tempdir().unwrap();
    let mut s = open(d.path());
    assert!(s.maybe_autobackup(std::time::Duration::from_secs(0)).unwrap().is_none());
    insert_account(&mut s, "X", "EUR");
    assert!(s.maybe_autobackup(std::time::Duration::from_secs(600)).unwrap().is_some(), "première sauvegarde");
    insert_account(&mut s, "Y", "EUR");
    assert!(s.maybe_autobackup(std::time::Duration::from_secs(600)).unwrap().is_none(), "moins de 10 min");
    assert!(s.maybe_autobackup(std::time::Duration::from_secs(0)).unwrap().is_some());
}

#[test]
fn nouveau_depart_sauvegarde_puis_vide() {
    let d = tempfile::tempdir().unwrap();
    let mut s = open(d.path());
    insert_account(&mut s, "X", "EUR");
    let m = s.fresh_start().unwrap();
    assert_eq!(m.table_counts["account"], 1);
    let n: i64 = s.conn.query_row("SELECT COUNT(*) FROM account", [], |r| r.get(0)).unwrap();
    assert_eq!(n, 0);
    assert_eq!(migrations::current_version(&s.conn).unwrap(), 2);
}

fn mk(file: &str, ts: &str, reason: Reason) -> Manifest {
    Manifest {
        file: file.into(), created_at: ts.into(), reason, app_version: "t".into(), schema_version: 2,
        sha256: String::new(), size_bytes: 0, table_counts: Default::default(),
    }
}

#[test]
fn rotation() {
    use chrono::{TimeZone, Utc};
    let now = Utc.with_ymd_and_hms(2026, 11, 19, 12, 0, 0).unwrap();
    let mut l = vec![];
    // 30 sauvegardes automatiques aujourd'hui, toutes les 10 minutes
    for i in 0..30 {
        let t = now - chrono::Duration::minutes(10 * i);
        l.push(mk(&format!("today-{i}"), &t.to_rfc3339(), Reason::Automatique));
    }
    // une par jour sur 40 jours
    for dd in 1..40 {
        let t = now - chrono::Duration::days(dd);
        l.push(mk(&format!("day-{dd}"), &t.to_rfc3339(), Reason::Automatique));
    }
    // une sauvegarde avant migration vieille de 60 jours, une de 120 jours
    l.push(mk("mig-60", &(now - chrono::Duration::days(60)).to_rfc3339(), Reason::AvantMigration));
    l.push(mk("mig-120", &(now - chrono::Duration::days(500)).to_rfc3339(), Reason::AvantMigration));
    let del = backup::rotation_to_delete(&l, now);
    for i in 0..10 { assert!(!del.contains(&format!("today-{i}")), "10 plus récentes gardées"); }
    assert!(del.contains(&"today-15".to_string()));
    for dd in 1..14 { assert!(!del.contains(&format!("day-{dd}")), "journalières gardées"); }
    assert!(!del.contains(&"mig-60".to_string()));
    assert!(del.contains(&"mig-120".to_string()));
    // au-delà de 14 jours : au plus une par semaine
    let kept_old: Vec<_> = (15..40).filter(|dd| !del.contains(&format!("day-{dd}"))).collect();
    assert!(kept_old.len() <= 5, "{kept_old:?}");
}
