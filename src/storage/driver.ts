// Interface unique de stockage, implémentée par l'adaptateur Tauri (application Mac)
// et par l'adaptateur sql.js (aperçu navigateur et tests). Voir docs/ARCHITECTURE.md § 2.

export type SqlParam = string | number | null | { $ref: number };

export interface Stmt {
  sql: string;
  params: SqlParam[];
}

export interface ApplyResult {
  inserted_ids: number[];
  changes: number[];
}

export type Row = Record<string, string | number | null>;

export interface BackupManifest {
  file: string;
  created_at: string;
  reason: string;
  app_version: string;
  schema_version: number;
  sha256: string;
  size_bytes: number;
  table_counts: Record<string, number>;
}

export interface StorageInfo {
  /** 'mac' : application native ; 'navigateur' : aperçu, données dans ce navigateur ; 'memoire' : tests. */
  kind: 'mac' | 'navigateur' | 'memoire';
  /** Phrase exacte à afficher à l'utilisateur sur l'emplacement des données. */
  locationLabel: string;
  databasePath: string | null;
  backupsPath: string | null;
  readOnly: boolean;
  lastBackup: BackupManifest | null;
}

export interface Driver {
  query(sql: string, params?: SqlParam[]): Promise<Row[]>;
  /** Exécute le plan en une transaction : tout ou rien. */
  apply(plan: Stmt[]): Promise<ApplyResult>;
  info(): Promise<StorageInfo>;
  backupNow(): Promise<BackupManifest | null>;
  listBackups(): Promise<BackupManifest[]>;
  readDrafts(): Promise<string>;
  writeDrafts(content: string): Promise<void>;
  /** Application Mac : restauration d'une sauvegarde en deux temps, nouveau départ. */
  stageRestore?(file: string): Promise<RestorePreview>;
  commitRestore?(): Promise<BackupManifest>;
  freshStart?(): Promise<BackupManifest>;
  /** Aperçu navigateur : copie de la base et restauration depuis un fichier. */
  exportDatabase?(): Uint8Array;
  restoreDatabase?(bytes: Uint8Array): Promise<void>;
}

export interface RestorePreview {
  backup_file: string;
  created_at: string;
  schema_version_before: number;
  schema_version_after: number;
  table_counts: Record<string, number>;
}
