// Exécution des mêmes fichiers `migrations/*.sql` que le Rust, pour l'adaptateur sql.js.
// La somme de contrôle est identique (SHA-256 du texte, fins de ligne normalisées).

export interface MigrationFile {
  version: number;
  name: string;
  sql: string;
}

export function parseMigrationName(path: string): { version: number; name: string } {
  const file = path.split('/').pop()!.replace(/\.sql$/, '');
  const m = /^(\d{4})_/.exec(file);
  if (!m) throw new Error(`nom de migration invalide : ${path}`);
  return { version: Number(m[1]), name: file };
}

export function fromRecord(files: Record<string, string>): MigrationFile[] {
  return Object.entries(files)
    .map(([path, sql]) => ({ ...parseMigrationName(path), sql }))
    .sort((a, b) => a.version - b.version);
}

export async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text.replace(/\r\n/g, '\n'));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
