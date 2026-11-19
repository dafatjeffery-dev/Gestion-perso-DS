import { useMemo, useState } from 'react';
import { formatDateFr } from '../../domain/dates';
import { formatMoney } from '../../domain/money';
import type { Asset, Currency, ScenarioParams } from '../../domain/types';
import { assetValue, netWorth, projections, roundThousands } from '../../engine/wealth';
import { latestReference } from '../../engine/balances';
import * as ref from '../../services/referentials';
import * as wealth from '../../services/wealth';
import { Field, FigureValue, Modal, MoneyInput, Notice, errorText } from '../components/core';
import { useData } from '../data';

const kEur = (minor: number) => `${formatMoney(roundThousands(minor), 'EUR', { decimals: false })}`;
const PARAMS: [keyof ScenarioParams, string, boolean][] = [
  ['inflation', 'Inflation annuelle', true],
  ['return_default', 'Rendement des placements', true],
  ['real_estate', 'Évolution de l’immobilier', true],
  ['income_growth', 'Évolution des revenus', true],
  ['eur_chf', 'Taux EUR/CHF (CHF pour 1 €)', false],
];

export function WealthScreen() {
  const { ctx, snap, today } = useData();
  const [constant, setConstant] = useState(true);
  const [valueFor, setValueFor] = useState<{ kind: 'asset'; a: Asset } | { kind: 'inv'; id: number } | null>(null);
  const [newAsset, setNewAsset] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nw = useMemo(() => netWorth(ctx), [ctx]);
  const proj = useMemo(() => projections(ctx), [ctx]);
  const pick = (y: { nominal: number; real: number }) => (constant ? y.real : y.nominal);
  const years = proj.scenarios[1]!.years;
  const W = 640, H = 220, L = 60, R = 12, T = 12, B = 26;
  const all = proj.scenarios.flatMap((s) => s.years.map(pick));
  const lo = Math.min(0, ...all), hi = Math.max(1, ...all);
  const x = (i: number) => L + (i * (W - L - R)) / Math.max(1, years.length - 1);
  const y = (v: number) => T + ((hi - v) * (H - T - B)) / (hi - lo || 1);
  const [pru, cen, fav] = proj.scenarios;
  const band = `${fav!.years.map((v, i) => `${i ? 'L' : 'M'}${x(i)},${y(pick(v))}`).join(' ')} ${[...pru!.years].reverse().map((v, j) => `L${x(pru!.years.length - 1 - j)},${y(pick(v))}`).join(' ')} Z`;
  const line = cen!.years.map((v, i) => `${i ? 'L' : 'M'}${x(i)},${y(pick(v))}`).join(' ');
  const step = Math.max(1, Math.ceil(years.length / 6));
  const milestones = years.filter((_, i) => i % 5 === 0 || i === years.length - 1);

  return (
    <div>
      <h1>Patrimoine et projection</h1>
      <section className="card">
        <div className="row-between">
          <h2>Patrimoine net au {formatDateFr(today)}</h2>
          <span className="kpi-inline"><FigureValue f={nw} decimals={false} /></span>
        </div>
        <table className="table">
          <tbody>
            {nw.components.map((c) => (
              <tr key={c.key}><td>{c.label}</td><td className="num"><FigureValue f={c} decimals={false} /></td></tr>
            ))}
          </tbody>
        </table>
        <p className="sub small">Valeurs déclarées datées (cliquez pour voir la date de chaque valeur). Le capital restant dû vient des échéanciers des crédits.</p>
      </section>

      <section className="card">
        <div className="row-between"><h2>Investissements et biens</h2><button onClick={() => setNewAsset(true)}>Nouveau bien</button></div>
        <table className="table">
          <thead><tr><th>Élément</th><th className="num">Dernière valeur déclarée</th><th>Date</th><th></th></tr></thead>
          <tbody>
            {snap.accounts.filter((a) => a.type === 'investissement').map((a) => {
              const r = latestReference(ctx, a.id, today);
              return <tr key={`i${a.id}`}><td>{a.name} <span className="sub small">placement</span></td><td className="num">{r ? formatMoney(r.amount_minor, a.currency) : '—'}</td><td>{r ? formatDateFr(r.ref_date) : '—'}</td><td><button onClick={() => setValueFor({ kind: 'inv', id: a.id })}>Déclarer une valeur</button></td></tr>;
            })}
            {snap.assets.map((a) => {
              const v = assetValue(ctx, a.id, today);
              return <tr key={`a${a.id}`}><td>{a.name} <span className="sub small">{a.kind === 'immobilier' ? 'immobilier' : 'bien'}{a.ownership_pct_e2 < 10000 ? `, quote-part ${a.ownership_pct_e2 / 100} %` : ''}</span></td><td className="num">{v.value === null ? '—' : formatMoney(v.value, a.currency)}</td><td>{v.date ? formatDateFr(v.date) : '—'}</td><td><button onClick={() => setValueFor({ kind: 'asset', a })}>Déclarer une valeur</button></td></tr>;
            })}
          </tbody>
        </table>
        <p className="sub small">Les comptes d’investissement se créent dans Comptes (type « Investissement ») ; leur valeur est une valeur déclarée datée.</p>
      </section>

      <section className="card">
        <div className="row-between">
          <h2>Projection jusqu’en {proj.inputs.endYear} — trois scénarios</h2>
          <label className="check"><input type="checkbox" checked={constant} onChange={(e) => setConstant(e.target.checked)} /> euros constants {constant ? `(${proj.inputs.startYear})` : ''}</label>
        </div>
        {proj.inputs.missing.length > 0 && <Notice kind="warn">Données manquantes : {proj.inputs.missing.join(' ; ')}.</Notice>}
        <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Projection du patrimoine net : fourchette prudent – favorable et scénario central">
          {[lo, (lo + hi) / 2, hi].map((t) => <g key={t}><line x1={L} x2={W - R} y1={y(t)} y2={y(t)} className="axis" /><text x={L - 6} y={y(t) + 4} textAnchor="end" className="tick">{(t / 100_000_000).toFixed(1).replace('.', ',')} M€</text></g>)}
          <path d={band} className="band" />
          <path d={line} className="series-1" />
          {years.map((v, i) => (i % step === 0 || i === years.length - 1 ? <text key={v.year} x={x(i)} y={H - 6} textAnchor="middle" className="tick">{v.year}</text> : null))}
        </svg>
        <div className="legend"><span><i className="sw band-sw" />Fourchette prudent – favorable</span><span><i className="sw s1" />Scénario central</span></div>
        <table className="table">
          <thead><tr><th>Année</th><th className="num">Prudent</th><th className="num">Central</th><th className="num">Favorable</th></tr></thead>
          <tbody>
            {milestones.map((m) => {
              const i = years.indexOf(m);
              return <tr key={m.year}><td>{m.year}</td>{proj.scenarios.map((s) => <td key={s.kind} className="num">{kEur(pick(s.years[i]!))}</td>)}</tr>;
            })}
          </tbody>
        </table>
        <p className="sub small">Arrondis au millier d’euros : ce sont des ordres de grandeur. Épargne annuelle = revenus structurels − dépenses prévues − capital remboursé ; placements au rendement du scénario ; biens à l’évolution immobilière ; dettes selon les échéanciers ; CHF au taux du scénario.</p>
        <h3>Hypothèses</h3>
        <ScenarioTable onError={setError} />
        {error && <Notice kind="error">{error}</Notice>}
      </section>
      {valueFor && <ValueDialog target={valueFor} onClose={() => setValueFor(null)} />}
      {newAsset && <AssetDialog onClose={() => setNewAsset(false)} />}
    </div>
  );
}

function ScenarioTable({ onError }: { onError: (e: string | null) => void }) {
  const { snap, driver, reload } = useData();
  const parsed = Object.fromEntries(snap.scenarios.map((s) => [s.kind, JSON.parse(s.params_json) as ScenarioParams]));
  const [draft, setDraft] = useState<Record<string, Record<string, string>>>(() => Object.fromEntries(Object.entries(parsed).map(([k, p]) => [k, Object.fromEntries(PARAMS.map(([key, , pct]) => [key, pct ? String(+(p[key] * 100).toFixed(2)).replace('.', ',') : String(p[key]).replace('.', ',')]))])));
  return (
    <table className="table">
      <thead><tr><th></th><th>Prudent</th><th>Central</th><th>Favorable</th></tr></thead>
      <tbody>
        {PARAMS.map(([key, label, pct]) => (
          <tr key={key}>
            <td>{label}{pct ? ' (%)' : ''}</td>
            {(['prudent', 'central', 'favorable'] as const).map((k) => (
              <td key={k}><input aria-label={`${label} — ${k}`} value={draft[k]![key]} onChange={(e) => setDraft({ ...draft, [k]: { ...draft[k]!, [key]: e.target.value } })} style={{ width: 80 }} /></td>
            ))}
          </tr>
        ))}
        <tr><td></td><td colSpan={3}>
          <button onClick={async () => {
            onError(null);
            try {
              for (const k of ['prudent', 'central', 'favorable'] as const) {
                const p = Object.fromEntries(PARAMS.map(([key, , pct]) => [key, Number(draft[k]![key]!.replace(',', '.')) / (pct ? 100 : 1)])) as unknown as ScenarioParams;
                await wealth.setScenario(driver, snap, k, p);
              }
              await reload();
            } catch (e) { onError(errorText(e)); }
          }}>Enregistrer les hypothèses</button>
        </td></tr>
      </tbody>
    </table>
  );
}

function ValueDialog({ target, onClose }: { target: { kind: 'asset'; a: Asset } | { kind: 'inv'; id: number }; onClose: () => void }) {
  const { driver, snap, reload, today } = useData();
  const currency: Currency = target.kind === 'asset' ? target.a.currency : snap.accounts.find((a) => a.id === target.id)!.currency;
  const [date, setDate] = useState(today);
  const [value, setValue] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title="Déclarer une valeur" onClose={onClose}>
      <div className="grid2">
        <Field label="Date"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label="Valeur"><MoneyInput value={value} onChange={setValue} currency={currency} ariaLabel="Valeur déclarée" /></Field>
      </div>
      {error && <Notice kind="error">{error}</Notice>}
      <div className="actions"><button className="primary" onClick={async () => {
        if (value === null) return setError('Valeur : à renseigner');
        try {
          if (target.kind === 'asset') await wealth.setAssetValue(driver, snap, { asset_id: target.a.id, date, value_minor: Math.abs(value) });
          else await ref.setBalanceReference(driver, snap, { account_id: target.id, ref_date: date, amount_minor: value, source: 'releve', note: 'valeur déclarée' });
          await reload(); onClose();
        } catch (e) { setError(errorText(e)); }
      }}>Enregistrer</button><button onClick={onClose}>Annuler</button></div>
    </Modal>
  );
}

function AssetDialog({ onClose }: { onClose: () => void }) {
  const { driver, snap, reload } = useData();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<Asset['kind']>('immobilier');
  const [currency, setCurrency] = useState<Currency>('EUR');
  const [pct, setPct] = useState('100');
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title="Nouveau bien" onClose={onClose}>
      <div className="grid2">
        <Field label="Nom"><input value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Type"><select value={kind} onChange={(e) => setKind(e.target.value as Asset['kind'])}><option value="immobilier">Immobilier</option><option value="autre">Autre bien</option></select></Field>
        <Field label="Devise"><select value={currency} onChange={(e) => setCurrency(e.target.value as Currency)}><option>EUR</option><option>CHF</option></select></Field>
        <Field label="Quote-part du foyer (%)"><input value={pct} onChange={(e) => setPct(e.target.value)} /></Field>
      </div>
      {error && <Notice kind="error">{error}</Notice>}
      <div className="actions"><button className="primary" onClick={async () => {
        try { await wealth.saveAsset(driver, snap, { name, kind, currency, ownership_pct_e2: Math.round(Number(pct.replace(',', '.')) * 100) }); await reload(); onClose(); } catch (e) { setError(errorText(e)); }
      }}>Enregistrer</button><button onClick={onClose}>Annuler</button></div>
    </Modal>
  );
}
