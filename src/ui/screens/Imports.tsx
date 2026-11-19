import { useMemo, useState } from 'react';
import { formatDateFr, formatMonthFr } from '../../domain/dates';
import type { CoverageMode } from '../../domain/types';
import { analyze, emptyDecisions, type Decisions } from '../../import/analyze';
import { COLUMNS, FORMAT_VERSION, NOTICE_LINES, aiInstructions } from '../../import/format';
import { issueText, readCsv, readXlsx, type RawTable } from '../../import/read';
import { csvTemplate, xlsxTemplate } from '../../import/template';
import * as imports from '../../services/imports';
import * as mv from '../../services/movements';
import * as ref from '../../services/referentials';
import { Amount, Modal, Notice, errorText } from '../components/core';
import { RubriqueSelect } from '../components/pickers';
import { useData } from '../data';
import { copyText, saveFile, sha256OfBytes } from '../files';
import { useNav } from '../nav';

export function ImportsScreen() {
  const { snap, driver, reload } = useData();
  const nav = useNav();
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error' | 'info'; text: string } | null>(null);
  const [showNotice, setShowNotice] = useState(false);
  const [file, setFile] = useState<{ table: RawTable; sha: string } | null>(null);
  const [decisions, setDecisions] = useState<Decisions>(emptyDecisions());
  const [cancel, setCancel] = useState<imports.CancelAnalysis | null>(null);
  const previous = file ? snap.importBatches.find((b) => b.file_sha256 === file.sha && b.status === 'integre') : undefined;
  const preview = useMemo(() => (file ? analyze(snap, file.table, decisions, { previousSha: previous ? { sha: file.sha, date: previous.imported_at } : null }) : null), [snap, file, decisions, previous]);
  const acc = (id: number) => snap.accounts.find((a) => a.id === id);

  const onFile = async (f: File) => {
    setMsg(null);
    setDecisions(emptyDecisions());
    const buf = await f.arrayBuffer();
    const sha = await sha256OfBytes(buf);
    const isX = /\.xlsx$/i.test(f.name);
    const table = isX ? await readXlsx(f.name, buf) : readCsv(f.name, new TextDecoder('utf-8').decode(buf));
    setFile({ table, sha });
  };

  return (
    <div>
      <h1>Importer des opérations</h1>
      <p className="sub">Exportez vos relevés depuis vos banques, donnez-les à l’IA de votre choix avec le modèle et les consignes, puis chargez ici le fichier obtenu. DS Finances ne contacte aucune IA et ne lit pas les PDF.</p>

      <section className="card">
        <h2>1. Préparer le fichier</h2>
        <div className="actions">
          <button onClick={async () => { const n = await saveFile(`modele-import-ds-finances-${FORMAT_VERSION}.xlsx`, await xlsxTemplate(snap), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); if (n) setMsg({ kind: 'ok', text: `Modèle enregistré : ${n}` }); }}>Télécharger le modèle d’import (.xlsx)</button>
          <button onClick={async () => { const n = await saveFile(`modele-import-ds-finances-${FORMAT_VERSION}.csv`, csvTemplate(), 'text/csv'); if (n) setMsg({ kind: 'ok', text: `Modèle enregistré : ${n}` }); }}>Modèle CSV</button>
          <button onClick={async () => setMsg((await copyText(aiInstructions())) ? { kind: 'ok', text: 'Consignes copiées : collez-les dans la conversation avec votre IA.' } : { kind: 'error', text: 'Copie impossible : affichez la notice et copiez le texte.' })}>Copier les consignes de préparation pour l’IA</button>
          <button className="link-btn" onClick={() => setShowNotice(!showNotice)} aria-expanded={showNotice}>{showNotice ? 'Masquer la notice' : 'Lire la notice'}</button>
        </div>
        <p className="sub small">Le modèle contient vos comptes (référence, nom, devise), familles, rubriques et natures. Il ne contient ni solde, ni IBAN.</p>
        {showNotice && (
          <div className="notice">
            {NOTICE_LINES.map((l) => <p key={l}>{l}</p>)}
            <table className="table">
              <thead><tr><th>Colonne</th><th>Obligatoire</th><th>Contenu</th></tr></thead>
              <tbody>{COLUMNS.map((c) => <tr key={c.key}><td><code>{c.key}</code></td><td>{c.required ? 'oui' : 'non'}</td><td>{c.description}</td></tr>)}</tbody>
            </table>
            <h3>Consignes pour l’IA</h3>
            <pre className="pre">{aiInstructions()}</pre>
          </div>
        )}
      </section>

      <section className="card">
        <h2>2. Contrôler et intégrer</h2>
        <label className="button-like">Choisir le fichier (.xlsx ou .csv)
          <input type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden aria-label="Fichier à importer" onChange={async (e) => { const f = e.target.files?.[0]; if (f) await onFile(f); e.target.value = ''; }} />
        </label>
        {preview && file && (
          <>
            <ol className="steps">
              <li className="done">Lecture : « {preview.fileName} » ({preview.kind.toUpperCase()}, {preview.counts.total} ligne(s))</li>
              <li className={file.table.issues.some((i) => i.level === 'bloquant') ? 'ko' : 'done'}>Structure et version du format ({preview.formatVersion})</li>
              <li className={preview.rows.some((r) => r.issues.some((i) => i.level === 'bloquant' && !i.reason.startsWith('doublon') && i.column !== 'rubrique')) ? 'ko' : 'done'}>Lignes</li>
              <li className={preview.unknownRubriques.length ? 'ko' : 'done'}>Correspondances</li>
              <li className={preview.rows.some((r) => r.dup === 'doublon_possible' && decisions.keepDuplicate[r.rowNo] === undefined) || preview.coverageNeeded.some((c) => !decisions.coverage[c.key]) ? 'ko' : 'done'}>Doublons et conflits</li>
              <li className={preview.blocking.length ? '' : 'done'}>Récapitulatif et confirmation</li>
            </ol>

            {preview.blocking.length > 0 && (
              <Notice kind="error">
                <p><strong>{preview.blocking.length} erreur(s) bloquante(s) : rien ne sera écrit tant qu’elles ne sont pas corrigées ou tranchées ci-dessous.</strong></p>
                {preview.blocking.slice(0, 40).map((i, n) => <p key={n}>{issueText(i)}</p>)}
                {preview.blocking.length > 40 && <p>… et {preview.blocking.length - 40} autre(s).</p>}
              </Notice>
            )}

            {preview.unknownRubriques.length > 0 && (
              <div className="subsection">
                <h3>Correspondances : rubriques inconnues</h3>
                <p className="sub">Associez chaque valeur à une rubrique existante ou à « À classer ». Aucune rubrique n’est créée sans votre action.</p>
                {preview.unknownRubriques.map((u) => {
                  const fam = snap.families.find((x) => x.name.toLowerCase() === u.family.toLowerCase() && x.direction !== 'technique');
                  return (
                    <div key={u.key} className="row-between">
                      <span>« {u.raw || '(rubrique vide)'} »{u.family ? ` (famille « ${u.family} »)` : ''} — ligne(s) {u.rows.join(', ')}</span>
                      <span className="row">
                        <RubriqueSelect snap={snap} value={typeof decisions.rubriqueMap[u.key] === 'number' ? (decisions.rubriqueMap[u.key] as number) : null} onChange={(v) => setDecisions((d) => ({ ...d, rubriqueMap: { ...d.rubriqueMap, [u.key]: v ?? 'a_classer' } }))} includeTechnical ariaLabel={`Rubrique pour ${u.raw || 'vide'}`} allowAll="— choisir —" />
                        <button onClick={() => setDecisions((d) => ({ ...d, rubriqueMap: { ...d.rubriqueMap, [u.key]: 'a_classer' } }))}>À classer</button>
                        {fam && u.raw && (
                          <button onClick={async () => { try { const id = await ref.createRubrique(driver, snap, { family_id: fam.id, name: u.raw }); await reload(); setDecisions((d) => ({ ...d, rubriqueMap: { ...d.rubriqueMap, [u.key]: id } })); } catch (e) { setMsg({ kind: 'error', text: errorText(e) }); } }}>Créer « {u.raw} » dans {fam.name}</button>
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}

            {(preview.counts.certain > 0 || preview.counts.possible > 0) && (
              <div className="subsection">
                <h3>Doublons</h3>
                <table className="table">
                  <tbody>
                    {preview.rows.filter((r) => r.dup !== 'nouvelle').map((r) => (
                      <tr key={r.rowNo}>
                        <td>Ligne {r.rowNo}</td>
                        <td>{r.candidate?.label_original} · <Amount value={r.candidate?.amount_minor ?? null} currency={r.candidate?.currency ?? 'EUR'} /></td>
                        <td><span className={`tag ${r.dup === 'doublon_certain' ? 'n' : ''}`}>{r.dup === 'doublon_certain' ? 'doublon certain' : 'doublon possible'}</span> <span className="sub small">{r.dupReason}</span></td>
                        <td>
                          {r.dup === 'doublon_certain' ? (
                            <label className="check"><input type="checkbox" checked={decisions.keepDuplicate[r.rowNo] === true} onChange={(e) => setDecisions((d) => ({ ...d, keepDuplicate: { ...d.keepDuplicate, [r.rowNo]: e.target.checked } }))} /> importer quand même</label>
                          ) : (
                            <span className="row">
                              <label className="check"><input type="radio" name={`dup${r.rowNo}`} checked={decisions.keepDuplicate[r.rowNo] === true} onChange={() => setDecisions((d) => ({ ...d, keepDuplicate: { ...d.keepDuplicate, [r.rowNo]: true } }))} /> importer (opération distincte)</label>
                              <label className="check"><input type="radio" name={`dup${r.rowNo}`} checked={decisions.keepDuplicate[r.rowNo] === false} onChange={() => setDecisions((d) => ({ ...d, keepDuplicate: { ...d.keepDuplicate, [r.rowNo]: false } }))} /> ne pas importer</label>
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {preview.coverageNeeded.length > 0 && (
              <div className="subsection">
                <h3>Conflits avec des totaux mensuels</h3>
                {preview.coverageNeeded.map((c) => (
                  <div key={c.key} role="group" aria-label={`Couverture ${c.key}`}>
                    <p>« {snap.rubriques.find((r) => r.id === c.rubrique_id)?.name} » en {formatMonthFr(c.month)} : un total mensuel existe déjà ; {c.rows.length} opération(s) importée(s).</p>
                    {(Object.keys(mv.COVERAGE_LABEL) as CoverageMode[]).map((k) => (
                      <label key={k} className="check"><input type="radio" name={`cov${c.key}`} checked={decisions.coverage[c.key] === k} onChange={() => setDecisions((d) => ({ ...d, coverage: { ...d.coverage, [c.key]: k } }))} /> {mv.COVERAGE_LABEL[k]}</label>
                    ))}
                  </div>
                ))}
              </div>
            )}

            {preview.warnings.length > 0 && (
              <Notice kind="warn">
                <p><strong>{preview.warnings.length} avertissement(s) (non bloquants)</strong></p>
                {preview.warnings.slice(0, 20).map((i, n) => <p key={n}>{issueText(i)}</p>)}
              </Notice>
            )}

            <div className="subsection">
              <h3>Récapitulatif</h3>
              <ul>
                <li>{preview.counts.toImport} opération(s) à intégrer, {preview.counts.excluded} exclue(s) ({preview.counts.certain} doublon(s) certain(s), {preview.counts.possible} possible(s)), {preview.counts.flagged} signalée(s)</li>
                {preview.period && <li>Période couverte : du {formatDateFr(preview.period.from)} au {formatDateFr(preview.period.to)}</li>}
                <li>Comptes : {preview.accounts.map((a) => acc(a)?.name).join(', ') || '—'}</li>
                {preview.transfers.length > 0 && <li>{preview.transfers.length} transfert(s) reconnu(s) par leur référence</li>}
                {preview.uncertain.length > 0 && <li>{preview.uncertain.length} classement(s) incertain(s), marqués « à vérifier » (lignes {preview.uncertain.join(', ')})</li>}
              </ul>
              <button
                className="primary"
                disabled={preview.blocking.length > 0 || preview.counts.toImport === 0}
                onClick={async () => {
                  try {
                    const id = await imports.commitImport(driver, snap, preview, decisions, { sha256: file.sha });
                    await reload();
                    setFile(null);
                    setMsg({ kind: 'ok', text: `Lot n° ${id} intégré : ${preview.counts.toImport} opération(s).` });
                  } catch (e) {
                    setMsg({ kind: 'error', text: errorText(e) });
                  }
                }}
              >
                Confirmer l’intégration de {preview.counts.toImport} opération(s)
              </button>{' '}
              <button onClick={() => setFile(null)}>Abandonner cet import</button>
            </div>
          </>
        )}
        {msg && <Notice kind={msg.kind === 'info' ? 'info' : msg.kind}>{msg.text}</Notice>}
      </section>

      <section className="card">
        <h2>Historique des imports</h2>
        <table className="table">
          <thead><tr><th>Lot</th><th>Date</th><th>Fichier</th><th>Comptes</th><th>Période</th><th className="num">Importées</th><th className="num">Exclues</th><th className="num">Signalées</th><th>Format</th><th></th></tr></thead>
          <tbody>
            {[...snap.importBatches].reverse().map((b) => (
              <tr key={b.id}>
                <td>n° {b.id}</td>
                <td>{formatDateFr(b.imported_at.slice(0, 10))}</td>
                <td>{b.file_name}</td>
                <td>{(JSON.parse(b.account_ids_json) as number[]).map((a) => acc(a)?.name).join(', ')}</td>
                <td>{b.period_from ? `${formatDateFr(b.period_from)} – ${formatDateFr(b.period_to!)}` : '—'}</td>
                <td className="num">{b.rows_imported}</td>
                <td className="num">{b.rows_excluded}</td>
                <td className="num">{b.rows_flagged}</td>
                <td>{b.format_version}</td>
                <td className="actions small">
                  {b.status === 'annule' ? <span className="tag n">annulé</span> : (
                    <>
                      <button onClick={() => nav.go('operations', { batchId: b.id })}>Opérations du lot</button>
                      <button onClick={async () => { try { setCancel(await imports.analyzeCancel(driver, snap, b.id)); } catch (e) { setMsg({ kind: 'error', text: errorText(e) }); } }}>Annuler le lot…</button>
                    </>
                  )}
                </td>
              </tr>
            ))}
            {snap.importBatches.length === 0 && <tr><td colSpan={10} className="sub">Aucun import.</td></tr>}
          </tbody>
        </table>
      </section>
      {cancel && <CancelDialog a={cancel} onClose={() => setCancel(null)} onDone={(t) => setMsg({ kind: 'ok', text: t })} />}
    </div>
  );
}

function CancelDialog({ a, onClose, onDone }: { a: imports.CancelAnalysis; onClose: () => void; onDone: (t: string) => void }) {
  const { driver, snap, reload } = useData();
  const [keep, setKeep] = useState(true);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title={`Annuler le lot n° ${a.batchId}`} onClose={onClose}>
      {a.consequences.map((c) => <p key={c}>{c}</p>)}
      {a.modified.length > 0 && (
        <>
          <label className="check"><input type="radio" checked={keep} onChange={() => setKeep(true)} /> Conserver les {a.modified.length} opération(s) modifiée(s) depuis l’import</label>
          <label className="check"><input type="radio" checked={!keep} onChange={() => setKeep(false)} /> Les supprimer aussi</label>
        </>
      )}
      <p className="sub">Les opérations vont à la corbeille ; la provenance du lot reste consultable.</p>
      {error && <Notice kind="error">{error}</Notice>}
      <div className="actions">
        <button className="danger" onClick={async () => { try { const r = await imports.cancelBatch(driver, snap, a, { keepModified: keep }); await reload(); onDone(`Lot n° ${a.batchId} annulé : ${r.deleted} opération(s) à la corbeille${r.kept ? `, ${r.kept} conservée(s)` : ''}.`); onClose(); } catch (e) { setError(errorText(e)); } }}>Confirmer l’annulation</button>
        <button onClick={onClose}>Ne rien faire</button>
      </div>
    </Modal>
  );
}
