// Démarrage de l'adaptateur d'aperçu navigateur : sql.js + persistance IndexedDB.

import initSqlJs from 'sql.js';
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url';
import { fromRecord } from './migrations';
import { SqlJsDriver, type Persistence } from './sqljsDriver';

const files = import.meta.glob('../../migrations/*.sql', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

const DB_NAME = 'ds-finances-apercu';
const KEY = 'base';

function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('fichiers');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export const indexedDbPersistence: Persistence = {
  label: 'IndexedDB',
  async load() {
    const db = await idb();
    return new Promise((resolve, reject) => {
      const r = db.transaction('fichiers').objectStore('fichiers').get(KEY);
      r.onsuccess = () => resolve((r.result as Uint8Array | undefined) ?? null);
      r.onerror = () => reject(r.error);
    });
  },
  async save(bytes) {
    const db = await idb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('fichiers', 'readwrite');
      tx.objectStore('fichiers').put(bytes, KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },
};

export async function createBrowserDriver(): Promise<SqlJsDriver> {
  const SQL = await initSqlJs({ locateFile: () => wasmUrl });
  return SqlJsDriver.create(SQL, fromRecord(files), indexedDbPersistence);
}
