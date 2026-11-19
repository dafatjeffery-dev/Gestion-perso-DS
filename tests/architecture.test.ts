// Séparation des couches (docs/ARCHITECTURE.md § 2) : le moteur ne dépend que du domaine,
// le domaine de rien, et l'interface ne parle jamais directement SQL.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..', 'src');
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(f) ? [p] : [];
  });
}
const imports = (p: string) => [...readFileSync(p, 'utf8').matchAll(/from '([^']+)'/g)].map((m) => m[1]!);

describe('séparation des couches', () => {
  it('engine n’importe que domain (ni storage, ni services, ni ui, ni React)', () => {
    for (const f of files(join(root, 'engine'))) {
      for (const i of imports(f)) {
        expect(i.startsWith('.') ? /\/(storage|services|ui)\//.test(i) || i.includes('../storage') || i.includes('../services') || i.includes('../ui') : !['decimal.js'].includes(i), `${f} importe ${i}`).toBe(false);
      }
    }
  });
  it('domain n’importe rien hors de domain', () => {
    for (const f of files(join(root, 'domain'))) for (const i of imports(f)) expect(i.startsWith('./'), `${f} importe ${i}`).toBe(true);
  });
  it('ui n’écrit pas de SQL', () => {
    for (const f of files(join(root, 'ui'))) {
      expect(/\b(INSERT|UPDATE|DELETE)\s+(INTO|FROM|\w+\s+SET)/.test(readFileSync(f, 'utf8')), f).toBe(false);
    }
  });
});
