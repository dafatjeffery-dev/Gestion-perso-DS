import { useEffect, useState } from 'react';
import { formatDateFr } from '../../domain/dates';
import type { Direction } from '../../domain/types';
import { formatRate } from '../../engine/fx';
import * as ref from '../../services/referentials';
import type { BackupManifest, RestorePreview, Row } from '../../storage/driver';
import { formatMoney } from '../../domain/money';
import { checkFullExport, exportFull, importFull, type FullExport } from '../../export/full';
import { readableTables, toCsv, toXlsx } from '../../export/readable';
import { restoreMovement } from '../../services/movements';
import { fetchEcbRates, ECB_HOST } from '../../services/ecb';
import { saveFile } from '../files';
import { Field, Notice, errorText } from '../components/core';
import { DraftBanner, useProtectedForm } from '../components/guard';
import { useData } from '../data';

const REASONS: Record<string, string> = {
  demarrage: 'démarrage', 'avant-migration': 'avant migration', 'avant-restauration': 'avant restauration',
  'avant-nouveau-depart': 'avant nouveau départ', automatique: 'automatique', fermeture: 'fermeture', manuelle: 'manuelle',
};

const fmtTs = (iso: string) => {
  const d = new Date(iso);
  return `${formatDateFr(iso.slice(0, 10))} ${d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`;
};

type Tab = 'foyer' | 'rubriques' | 'taux' | 'donnees';

export function SettingsScreen() {
  const [tab, setTab] = useState<Tab>('foyer');
  return (
    <div>
      <h1>Paramètres</h1>
      <div className="tabs" role="tablist">
        {([['foyer', 'Foyer et personnes'], ['rubriques', 'Familles et rubriques'], ['taux', 'Taux de change'], ['donnees', 'Données et sauvegardes']] as const).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'tab on' : 'tab'} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>
      {tab === 'foyer' && <HouseholdForm />}
      {tab === 'rubriques' && <Rubriques />}
      {tab === 'taux' && <Rates />}
      {tab === 'donnees' && <DataSection />}
    </div>
  );
}

function HouseholdForm() {
  const { driver, snap, reload } = useData();
  const [msg, setMsg] = useState<string | null>(null);
  const [A, B] = [snap.persons.find((p) => p.role === 'A')!, snap.persons.find((p) => p.role === 'B')!];
  const form = useProtectedForm('foyer', 'Foyer et personnes', {
    name: snap.household.name, horizon: snap.household.forecast_horizon_months, age: snap.household.ref_balance_max_age_days,
    a: A.display_name, aRet: A.retirement_date ?? '', b: B.display_name, bRet: B.retirement_date ?? '',
  }, async (v) => {
    try {
      await ref.updateHousehold(driver, snap, { name: v.name, forecast_horizon_months: v.horizon, ref_balance_max_age_days: v.age });
      await ref.updatePerson(driver, snap, A.id, { display_name: v.a, retirement_date: v.aRet || null });
      await ref.updatePerson(driver, snap, B.id, { display_name: v.b, retirement_date: v.bRet || null });
      await reload();
      setMsg('Enregistré.');
      return true;
    } catch (e) { setMsg(errorText(e)); return false; }
  });
  const v = form.values;
  return (
    <section className="card">
      <DraftBanner offer={form.draftOffer} onRestore={form.restoreDraft} onIgnore={form.ignoreDraft} />
      <form onSubmit={async (e) => { e.preventDefault(); await form.save(); }}>
        <div className="grid3">
          <Field label="Nom du foyer"><input value={v.name} onChange={(e) => form.set({ name: e.target.value })} /></Field>
          <Field label="Horizon de prévision (mois)"><input type="number" min={1} max={120} value={v.horizon} onChange={(e) => form.set({ horizon: Number(e.target.value) })} /></Field>
          <Field label="Solde constaté « ancien » après (jours)"><input type="number" min={1} value={v.age} onChange={(e) => form.set({ age: Number(e.target.value) })} /></Field>
          <Field label="Personne A"><input value={v.a} onChange={(e) => form.set({ a: e.target.value })} /></Field>
          <Field label="Retraite prévue (A)"><input type="date" value={v.aRet} onChange={(e) => form.set({ aRet: e.target.value })} /></Field>
          <span />
          <Field label="Personne B"><input value={v.b} onChange={(e) => form.set({ b: e.target.value })} /></Field>
          <Field label="Retraite prévue (B)"><input type="date" value={v.bRet} onChange={(e) => form.set({ bRet: e.target.value })} /></Field>
        </div>
        {msg && <Notice>{msg}</Notice>}
        <div className="actions"><button className="primary" type="submit" disabled={!form.dirty}>Enregistrer</button>{form.dirty && <button type="button" onClick={form.discard}>Abandonner</button>}</div>
      </form>
    </section>
  );
}

function Rubriques() {
  const { driver, snap, reload } = useData();
  const [error, setError] = useState<string | null>(null);
  const [newRub, setNewRub] = useState<Record<number, string>>({});
  const [newFam, setNewFam] = useState<{ name: string; direction: Direction }>({ name: '', direction: 'depense' });
  const act = async (fn: () => Promise<unknown>) => { setError(null); try { await fn(); await reload(); } catch (e) { setError(errorText(e)); } };
  return (
    <section className="card">
      <p className="sub">
        « Disponible » : proposée pour de nouvelles saisies. « Affichée » : visible dans les listes. Ni l’un ni l’autre ne retire une récurrence active des prévisions ni un montant des totaux.
      </p>
      {error && <Notice kind="error">{error}</Notice>}
      {[...snap.families].sort((a, b) => a.sort_order - b.sort_order).map((f) => (
        <div key={f.id} className="subsection">
          <div className="row-between">
            <strong>{f.name} <span className="sub">({f.direction === 'revenu' ? 'revenus' : f.direction === 'depense' ? 'dépenses' : 'technique'}{f.is_system ? ', système' : ''})</span></strong>
            <label className="check"><input type="checkbox" checked={!!f.visible} onChange={(e) => act(() => ref.updateFamily(driver, snap, f.id, { visible: e.target.checked }))} /> affichée</label>
          </div>
          <table className="table">
            <tbody>
              {snap.rubriques.filter((r) => r.family_id === f.id).map((r) => (
                <tr key={r.id}>
                  <td>{r.name} <span className="sub small">{r.ref}</span></td>
                  <td><label className="check"><input type="checkbox" checked={!!r.available_for_entry} onChange={(e) => act(() => ref.updateRubrique(driver, snap, r.id, { available_for_entry: e.target.checked }))} /> disponible</label></td>
                  <td><label className="check"><input type="checkbox" checked={!!r.visible} onChange={(e) => act(() => ref.updateRubrique(driver, snap, r.id, { visible: e.target.checked }))} /> affichée</label></td>
                  <td>
                    <select aria-label={`Estimation ${r.name}`} value={r.estimation_method} onChange={(e) => act(() => ref.updateRubrique(driver, snap, r.id, { estimation_method: e.target.value as 'budget' }))}>
                      <option value="budget">reste = budget</option>
                      <option value="prorata">reste au prorata</option>
                      <option value="moyenne">reste = moyenne {r.estimation_n} mois</option>
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {f.direction !== 'technique' && (
            <form className="row" onSubmit={(e) => { e.preventDefault(); const n = newRub[f.id]; if (n) void act(async () => { await ref.createRubrique(driver, snap, { family_id: f.id, name: n }); setNewRub({ ...newRub, [f.id]: '' }); }); }}>
              <input aria-label={`Nouvelle rubrique dans ${f.name}`} placeholder="Nouvelle rubrique" value={newRub[f.id] ?? ''} onChange={(e) => setNewRub({ ...newRub, [f.id]: e.target.value })} />
              <button type="submit">Ajouter</button>
            </form>
          )}
        </div>
      ))}
      <form className="subsection row" onSubmit={(e) => { e.preventDefault(); void act(async () => { await ref.createFamily(driver, snap, newFam); setNewFam({ ...newFam, name: '' }); }); }}>
        <input aria-label="Nouvelle famille" placeholder="Nouvelle famille" value={newFam.name} onChange={(e) => setNewFam({ ...newFam, name: e.target.value })} />
        <select aria-label="Sens de la famille" value={newFam.direction} onChange={(e) => setNewFam({ ...newFam, direction: e.target.value as Direction })}>
          <option value="depense">Dépenses</option>
          <option value="revenu">Revenus</option>
        </select>
        <button type="submit">Créer la famille</button>
      </form>
    </section>
  );
}

function Rates() {
  const { driver, snap, reload, today } = useData();
  const [date, setDate] = useState(today);
  const [rate, setRate] = useState('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error' | 'warn'; text: string } | null>(null);
  const [csv, setCsv] = useState<ref.RateCsvReport | null>(null);
  const rates = [...snap.fxRates].sort((a, b) => (a.rate_date < b.rate_date ? 1 : -1));
  return (
    <section className="card">
      <p className="sub">Taux = nombre de CHF pour 1 €. La récupération auprès de la BCE est la seule connexion réseau de l’application ; elle n’a lieu que sur votre demande. Réel : taux du jour de l’opération ; soldes : taux de la date du solde ; prévisions : taux d’hypothèse. Modifier un ancien taux recalcule les vues consolidées, jamais les montants d’origine.</p>
      <form className="row" onSubmit={async (e) => {
        e.preventDefault();
        try { const n = await ref.setFxRate(driver, snap, { rate_date: date, eur_chf: rate }); await reload(); setMsg({ kind: 'ok', text: n.message }); setRate(''); } catch (er) { setMsg({ kind: 'error', text: errorText(er) }); }
      }}>
        <input type="date" aria-label="Date du taux" value={date} onChange={(e) => setDate(e.target.value)} />
        <input aria-label="Taux EUR/CHF" placeholder="0,9412" value={rate} onChange={(e) => setRate(e.target.value)} />
        <button type="submit" className="primary">Enregistrer le taux</button>
        <button type="button" onClick={async () => {
          if (!confirm(`Récupérer les taux EUR/CHF des 90 derniers jours auprès de la BCE (${ECB_HOST}) ? Seules des dates sont envoyées.`)) return;
          try { const from = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10); const n = await fetchEcbRates(driver, snap, from, today); await reload(); setMsg({ kind: 'ok', text: `${n} taux récupéré(s) auprès de la BCE.` }); } catch (er) { setMsg({ kind: 'error', text: `Récupération impossible : ${errorText(er)}. Saisissez ou importez les taux.` }); }
        }}>Récupérer les taux (BCE)…</button>
        <label className="button-like">Importer un CSV (date;taux)
          <input type="file" accept=".csv,text/csv" hidden onChange={async (e) => { const f = e.target.files?.[0]; if (f) setCsv(ref.readRateCsv(snap, await f.text())); e.target.value = ''; }} />
        </label>
      </form>
      {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}
      {csv && (
        <Notice kind={csv.errors.length ? 'error' : 'ok'}>
          {csv.errors.length ? <>Fichier refusé, aucune écriture :{csv.errors.map((er) => <p key={er.line}>{er.message}</p>)}</> : (
            <>
              <p>{csv.rows.filter((r) => r.status === 'nouveau').length} nouveau(x), {csv.rows.filter((r) => r.status === 'modifie').length} modifié(s), {csv.rows.filter((r) => r.status === 'identique').length} identique(s).</p>
              <button className="primary" onClick={async () => { try { const n = await ref.applyRateCsv(driver, snap, csv); await reload(); setCsv(null); setMsg({ kind: 'ok', text: `${n} taux enregistré(s).` }); } catch (er) { setMsg({ kind: 'error', text: errorText(er) }); } }}>Confirmer l’import</button>
              <button onClick={() => setCsv(null)}>Annuler</button>
            </>
          )}
        </Notice>
      )}
      <table className="table">
        <thead><tr><th>Date</th><th className="num">CHF pour 1 €</th><th>Source</th><th></th></tr></thead>
        <tbody>
          {rates.slice(0, 60).map((r) => (
            <tr key={r.rate_date}>
              <td>{formatDateFr(r.rate_date)}</td>
              <td className="num">{formatRate(r.eur_chf_e6)}</td>
              <td>{r.source === 'bce' ? 'BCE' : r.source === 'csv' ? 'import CSV' : 'saisie'}</td>
              <td><button onClick={async () => { const n = await ref.deleteFxRate(driver, snap, r.rate_date); await reload(); setMsg({ kind: 'warn', text: n.message }); }}>Supprimer</button></td>
            </tr>
          ))}
          {rates.length === 0 && <tr><td className="sub" colSpan={4}>Aucun taux : les montants en CHF ne peuvent pas être consolidés en euros.</td></tr>}
        </tbody>
      </table>
    </section>
  );
}

function DataSection() {
  const { driver, info, reload, snap, today } = useData();
  const [backups, setBackups] = useState<BackupManifest[]>([]);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error' | 'warn'; text: string } | null>(null);
  const [staged, setStaged] = useState<RestorePreview | null>(null);
  const [freshFile, setFreshFile] = useState<{ data: FullExport; counts: Record<string, number> } | null>(null);
  const [trash, setTrash] = useState<Row[]>([]);
  const [journal, setJournal] = useState<Row[]>([]);
  useEffect(() => { void driver.listBackups().then(setBackups); }, [driver, info]);
  useEffect(() => {
    void driver.query('SELECT id, granularity, op_date, period_month, amount_minor, currency, label_simple, label_original, deleted_at FROM movement WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT 50').then(setTrash);
    void driver.query('SELECT ts, actor, summary, entity FROM audit_log ORDER BY id DESC LIMIT 50').then(setJournal);
  }, [driver, snap]);
  const stamp = today.replace(/-/g, '');
  const act = async (fn: () => Promise<unknown>) => { setMsg(null); try { await fn(); } catch (e) { setMsg({ kind: 'error', text: errorText(e) }); } };
  const safetyDownload = async () => {
    if (driver.exportDatabase) await saveFile(`ds-finances-sauvegarde-${stamp}.sqlite`, driver.exportDatabase(), 'application/vnd.sqlite3');
  };
  return (
    <>
      <section className="card">
        <h2>Emplacement des données et sauvegardes</h2>
        <p data-testid="storage-location">{info.locationLabel}</p>
        {info.readOnly && <p className="alert">Base ouverte en lecture seule : elle a été écrite par une version plus récente de l’application.</p>}
        {info.kind === 'mac' ? (
          <>
            <p>Dossier des sauvegardes : <code>{info.backupsPath}</code></p>
            <p>Dernière sauvegarde : {info.lastBackup ? `${fmtTs(info.lastBackup.created_at)} (${REASONS[info.lastBackup.reason] ?? info.lastBackup.reason})` : 'aucune pour l’instant'}</p>
            <p className="sub">Automatiques : au démarrage, avant migration, restauration ou nouveau départ, au plus toutes les 10 minutes après des modifications, et à la fermeture. Conservées : les 10 plus récentes, une par jour sur 14 jours, une par semaine sur 8 semaines, une par mois sur 12 mois.</p>
            <button onClick={() => act(async () => { const m = await driver.backupNow(); setMsg(m ? { kind: 'ok', text: `Sauvegarde créée : ${m.file}` } : null); await reload(); })}>Sauvegarder maintenant</button>
            <table className="table">
              <thead><tr><th>Date</th><th>Motif</th><th>Schéma</th><th className="num">Opérations</th><th></th></tr></thead>
              <tbody>{backups.map((b) => (
                <tr key={b.file}><td>{fmtTs(b.created_at)}</td><td>{REASONS[b.reason] ?? b.reason}</td><td>{b.schema_version}</td><td className="num">{b.table_counts.movement ?? '—'}</td>
                  <td><button onClick={() => act(async () => setStaged(await driver.stageRestore!(b.file)))}>Restaurer…</button></td></tr>
              ))}</tbody>
            </table>
          </>
        ) : (
          <>
            <p className="sub">En aperçu navigateur, il n’y a pas de sauvegarde automatique : téléchargez une copie de la base.</p>
            <div className="actions">
              <button onClick={() => act(safetyDownload)}>Télécharger une sauvegarde (.sqlite)</button>
              <label className="button-like">Restaurer depuis un fichier .sqlite…
                <input type="file" accept=".sqlite,.db" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void act(async () => {
                  if (!confirm('Restaurer ce fichier ? Une copie de l’état actuel sera d’abord téléchargée.')) return;
                  await safetyDownload();
                  await driver.restoreDatabase!(new Uint8Array(await f.arrayBuffer()));
                  await reload();
                  setMsg({ kind: 'ok', text: `Base restaurée depuis « ${f.name} ».` });
                }); }} />
              </label>
            </div>
          </>
        )}
        {staged && (
          <Notice kind="warn">
            <p>Restaurer la sauvegarde du {fmtTs(staged.created_at)} ? Elle a été vérifiée sur une copie isolée{staged.schema_version_before !== staged.schema_version_after ? ` et migrée du schéma ${staged.schema_version_before} au ${staged.schema_version_after}` : ''}.</p>
            <p>Contenu : {staged.table_counts.movement ?? 0} opération(s) et total(aux), {staged.table_counts.account ?? 0} compte(s), {staged.table_counts.import_batch ?? 0} lot(s) d’import, {staged.table_counts.recurrence ?? 0} récurrence(s).</p>
            <p>L’état actuel sera sauvegardé juste avant (« avant restauration »).</p>
            <button className="primary" onClick={() => act(async () => { await driver.commitRestore!(); setStaged(null); await reload(); setMsg({ kind: 'ok', text: 'Sauvegarde restaurée.' }); })}>Restaurer</button>
            <button onClick={() => setStaged(null)}>Annuler</button>
          </Notice>
        )}
        {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}
      </section>

      <section className="card">
        <h2>Exports</h2>
        <div className="actions">
          <button onClick={() => act(async () => { await saveFile(`ds-finances-export-complet-${stamp}.json`, JSON.stringify(await exportFull(driver)), 'application/json'); })}>Export complet (JSON, réimportable)</button>
          <button onClick={() => act(async () => { await saveFile(`ds-finances-${stamp}.xlsx`, await toXlsx(readableTables(snap, today)), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); })}>Exports lisibles (XLSX)</button>
          {readableTables(snap, today).map((t) => (
            <button key={t.name} onClick={() => act(async () => { await saveFile(`ds-finances-${t.name.toLowerCase()}-${stamp}.csv`, toCsv(t), 'text/csv'); })}>{t.name} (CSV)</button>
          ))}
        </div>
        <p className="sub small">L’export complet contient toutes les tables (brouillons exceptés). Les exports lisibles contiennent les opérations, les totaux mensuels, les budgets et les échéanciers des crédits ; ils ne contiennent pas les lignes calculées (écarts de change, ventilation des paiements de crédit, prévisions).</p>
        <h3>Nouveau départ à partir d’un export complet</h3>
        <p className="sub">Remplace toutes les données par celles de l’export, après une sauvegarde de l’état actuel.</p>
        <label className="button-like">Choisir un export complet (.json)…
          <input type="file" accept=".json,application/json" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void act(async () => {
            const data = JSON.parse(await f.text()) as FullExport;
            const c = await checkFullExport(driver, data);
            if (!c.ok) throw new Error(c.errors.join(' '));
            setFreshFile({ data, counts: c.counts });
          }); }} />
        </label>
        {freshFile && (
          <Notice kind="warn">
            <p>Export du {fmtTs(freshFile.data.exported_at)} : {freshFile.counts.movement} mouvement(s), {freshFile.counts.account} compte(s). Toutes les données actuelles seront remplacées (une sauvegarde est faite avant).</p>
            <button className="danger" onClick={() => act(async () => {
              if (driver.freshStart) await driver.freshStart();
              else await safetyDownload();
              await importFull(driver, freshFile.data);
              setFreshFile(null);
              await reload();
              setMsg({ kind: 'ok', text: 'Données remplacées par l’export.' });
            })}>Remplacer les données</button>
            <button onClick={() => setFreshFile(null)}>Annuler</button>
          </Notice>
        )}
      </section>

      <section className="card">
        <h2>Corbeille</h2>
        {trash.length === 0 && <p className="sub">Vide.</p>}
        <table className="table"><tbody>{trash.map((m) => (
          <tr key={String(m.id)}><td>{m.granularity === 'total' ? `Total ${String(m.period_month)}` : formatDateFr(String(m.op_date))}</td><td>{String(m.label_simple ?? m.label_original ?? '')}</td>
            <td className="num">{formatMoney(Number(m.amount_minor), m.currency as 'EUR')}</td>
            <td><button onClick={() => act(async () => { await restoreMovement(driver, Number(m.id)); await reload(); })}>Restaurer</button></td></tr>
        ))}</tbody></table>
      </section>

      <section className="card">
        <h2>Journal des modifications (50 dernières)</h2>
        <table className="table"><tbody>{journal.map((j, i) => (
          <tr key={i}><td className="nowrap">{fmtTs(String(j.ts))}</td><td>{String(j.actor)}</td><td>{String(j.summary)}</td></tr>
        ))}</tbody></table>
      </section>
    </>
  );
}
