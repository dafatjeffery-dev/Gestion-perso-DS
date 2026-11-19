import { useEffect, useState } from 'react';
import { formatDateFr } from '../../domain/dates';
import type { BackupManifest } from '../../storage/driver';
import { useData } from '../data';

const REASONS: Record<string, string> = {
  demarrage: 'démarrage', 'avant-migration': 'avant migration', 'avant-restauration': 'avant restauration',
  'avant-nouveau-depart': 'avant nouveau départ', automatique: 'automatique', fermeture: 'fermeture', manuelle: 'manuelle',
};

const fmtTs = (iso: string) => {
  const d = new Date(iso);
  return `${formatDateFr(iso.slice(0, 10))} ${d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`;
};

export function SettingsScreen() {
  const { driver, info, reload } = useData();
  const [backups, setBackups] = useState<BackupManifest[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    void driver.listBackups().then(setBackups);
  }, [driver, info]);

  return (
    <div>
      <h1>Paramètres</h1>
      <section className="card">
        <h2>Données et sauvegardes</h2>
        <p data-testid="storage-location">{info.locationLabel}</p>
        {info.readOnly && <p className="alert">Base ouverte en lecture seule : elle a été écrite par une version plus récente de l’application.</p>}
        {info.kind === 'mac' ? (
          <>
            <p>Dossier des sauvegardes : <code>{info.backupsPath}</code></p>
            <p>
              Dernière sauvegarde :{' '}
              {info.lastBackup ? `${fmtTs(info.lastBackup.created_at)} (${REASONS[info.lastBackup.reason] ?? info.lastBackup.reason})` : 'aucune pour l’instant'}
            </p>
            <button
              onClick={async () => {
                const m = await driver.backupNow();
                setMsg(m ? `Sauvegarde créée : ${m.file}` : null);
                await reload();
              }}
            >
              Sauvegarder maintenant
            </button>
            {msg && <p className="ok">{msg}</p>}
            <table className="table">
              <thead><tr><th>Date</th><th>Motif</th><th>Schéma</th></tr></thead>
              <tbody>
                {backups.map((b) => (
                  <tr key={b.file}><td>{fmtTs(b.created_at)}</td><td>{REASONS[b.reason] ?? b.reason}</td><td>{b.schema_version}</td></tr>
                ))}
              </tbody>
            </table>
          </>
        ) : (
          <p className="sub">En aperçu navigateur, les sauvegardes automatiques de l’application Mac ne s’appliquent pas.</p>
        )}
      </section>
    </div>
  );
}
