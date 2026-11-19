// Adaptateur de l'application Mac : délègue au backend Rust (src-tauri/store).

import { invoke } from '@tauri-apps/api/core';
import type { ApplyResult, BackupManifest, Driver, Row, SqlParam, StorageInfo, Stmt } from './driver';

interface RustStatus {
  locations: { data_dir: string; database: string; backups_dir: string; drafts: string };
  read_only: boolean;
  dirty: boolean;
  last_backup: BackupManifest | null;
  now: string;
}

export class TauriDriver implements Driver {
  query(sql: string, params: SqlParam[] = []): Promise<Row[]> {
    return invoke<Row[]>('db_query', { sql, params });
  }
  apply(plan: Stmt[]): Promise<ApplyResult> {
    return invoke<ApplyResult>('db_apply', { plan });
  }
  async info(): Promise<StorageInfo> {
    const s = await invoke<RustStatus>('store_status');
    return {
      kind: 'mac',
      locationLabel: `Données enregistrées sur ce Mac : ${s.locations.database}`,
      databasePath: s.locations.database,
      backupsPath: s.locations.backups_dir,
      readOnly: s.read_only,
      lastBackup: s.last_backup,
    };
  }
  backupNow(): Promise<BackupManifest> {
    return invoke<BackupManifest>('backup_now');
  }
  listBackups(): Promise<BackupManifest[]> {
    return invoke<BackupManifest[]>('list_backups');
  }
  readDrafts(): Promise<string> {
    return invoke<string>('read_drafts');
  }
  writeDrafts(content: string): Promise<void> {
    return invoke<void>('write_drafts', { content });
  }
}

export const isTauri = (): boolean => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
