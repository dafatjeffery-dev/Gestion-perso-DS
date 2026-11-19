// Graphiques SVG écrits à la main : ils affichent les chiffres du moteur, sans recalcul.

import { useState } from 'react';
import { formatMonthFr } from '../../domain/dates';
import { formatMoney } from '../../domain/money';
import type { Currency } from '../../domain/types';
import type { Figure } from '../../engine/figure';
import type { ForecastPoint } from '../../engine/forecast';
import { useDetail } from './detail';

const short = (m: string) => formatMonthFr(m).replace(/^(\S{3,4})\S*/, '$1.').replace('mai.', 'mai');
const k = (v: number) => `${Math.round(v / 100000)} k`;

function niceTicks(min: number, max: number, n = 4): number[] {
  const span = Math.max(1, max - min);
  const raw = span / n;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((x) => x * mag).find((x) => x >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.floor(min / step) * step; v <= max + step / 2; v += step) out.push(v);
  return out;
}

export function ForecastChart({ points, currency, minMonth }: { points: ForecastPoint[]; currency: Currency; minMonth: string | null }) {
  const { show } = useDetail();
  const [hover, setHover] = useState<number | null>(null);
  const valid = points.filter((p) => p.liquidites.value !== null);
  if (valid.length === 0) return <p className="sub">Prévision indisponible : aucun compte n’a de solde constaté.</p>;
  const W = 640;
  const H = 230;
  const L = 52;
  const R = 12;
  const T = 14;
  const B = 28;
  const vals = points.flatMap((p) => [p.liquidites.value, p.reserve.value]).filter((v): v is number => v !== null);
  const ticks = niceTicks(Math.min(0, ...vals), Math.max(...vals));
  const lo = ticks[0]!;
  const hi = ticks[ticks.length - 1]!;
  const x = (i: number) => L + (points.length === 1 ? (W - L - R) / 2 : (i * (W - L - R)) / (points.length - 1));
  const y = (v: number) => T + ((hi - v) * (H - T - B)) / (hi - lo || 1);
  const path = (get: (p: ForecastPoint) => number | null) =>
    points.map((p, i) => ({ v: get(p), i })).filter((p) => p.v !== null).map((p, j) => `${j ? 'L' : 'M'}${x(p.i).toFixed(1)},${y(p.v!).toFixed(1)}`).join(' ');
  const step = Math.max(1, Math.ceil(points.length / 8));
  const hp = hover !== null ? points[hover]! : null;
  return (
    <div className="chart-wrap">
      <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Liquidités prévues en fin de mois" onMouseLeave={() => setHover(null)}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} className={t === 0 ? 'axis zero' : 'axis'} />
            <text x={L - 6} y={y(t) + 4} textAnchor="end" className="tick">{k(t)}</text>
          </g>
        ))}
        {points.map((p, i) => (i % step === 0 ? <text key={p.month} x={x(i)} y={H - 8} textAnchor="middle" className="tick">{short(p.month)}</text> : null))}
        <path d={path((p) => p.reserve.value)} className="series-2 dashed" />
        <path d={path((p) => p.liquidites.value)} className="series-1" />
        {hp && <line x1={x(hover!)} x2={x(hover!)} y1={T} y2={H - B} className="crosshair" />}
        {points.map((p, i) =>
          p.liquidites.value === null ? null : (
            <circle key={p.month} cx={x(i)} cy={y(p.liquidites.value)} r={p.month === minMonth ? 6 : 4} className={p.month === minMonth ? 'marker min' : 'marker'} />
          ),
        )}
        {points.map((p, i) => (
          <rect
            key={`h${p.month}`}
            x={x(i) - (W - L - R) / Math.max(1, points.length - 1) / 2}
            y={T}
            width={(W - L - R) / Math.max(1, points.length - 1)}
            height={H - T - B}
            fill="transparent"
            onMouseEnter={() => setHover(i)}
            onClick={() => show(p.liquidites)}
            style={{ cursor: 'pointer' }}
          >
            <title>{`${formatMonthFr(p.month)} : ${p.liquidites.value === null ? '—' : formatMoney(p.liquidites.value, currency)}`}</title>
          </rect>
        ))}
      </svg>
      {hp && (
        <div className="tooltip" style={{ left: `${(x(hover!) / W) * 100}%` }}>
          <strong>Fin {formatMonthFr(hp.month)}</strong>
          <div className="row-between"><span><i className="sw s1" />Liquidités prévues</span><span className="num">{hp.liquidites.value === null ? '—' : formatMoney(hp.liquidites.value, currency, { decimals: false })}</span></div>
          <div className="row-between"><span><i className="sw s2" />Réservé prévu</span><span className="num">{hp.reserve.value === null ? '—' : formatMoney(hp.reserve.value, currency, { decimals: false })}</span></div>
          <div className="row-between"><span>Marge</span><span className="num">{hp.marge.value === null ? '—' : formatMoney(hp.marge.value, currency, { decimals: false })}</span></div>
          <div className="sub small">Cliquer pour le détail</div>
        </div>
      )}
      <div className="legend">
        <span><i className="sw s1" />Liquidités prévues en fin de mois</span>
        <span><i className="sw s2 dashed" />Réservé prévu (réserve + fonds)</span>
      </div>
    </div>
  );
}

export interface DonutSliceView {
  key: string;
  name: string;
  value: number;
  share_e4: number;
  figure: Figure;
}

/** Anneau : 6 familles au plus, le reste regroupé dans « Autres » ; légende chiffrée visible. */
export function Donut({ slices, total, currency, centerLabel }: { slices: DonutSliceView[]; total: number; currency: Currency; centerLabel: string }) {
  const { show } = useDetail();
  const [hover, setHover] = useState<string | null>(null);
  const R = 70;
  const C = 2 * Math.PI * R;
  let offset = 0;
  const gap = slices.length > 1 ? 2 : 0;
  return (
    <div className="donut">
      <svg viewBox="0 0 200 200" role="img" aria-label="Répartition des dépenses par famille">
        <g transform="rotate(-90 100 100)">
          {slices.map((s, i) => {
            const len = (s.value / (total || 1)) * C;
            const el = (
              <circle
                key={s.key}
                cx="100"
                cy="100"
                r={R}
                fill="none"
                className={`slice c${(i % 6) + 1} ${s.key === 'autres' ? 'other' : ''} ${hover && hover !== s.key ? 'dim' : ''}`}
                strokeWidth={26}
                strokeDasharray={`${Math.max(0, len - gap)} ${C}`}
                strokeDashoffset={-offset}
                onMouseEnter={() => setHover(s.key)}
                onMouseLeave={() => setHover(null)}
                onClick={() => show(s.figure)}
                style={{ cursor: 'pointer' }}
              >
                <title>{`${s.name} : ${formatMoney(s.value, currency)} (${(s.share_e4 / 100).toFixed(0)} %)`}</title>
              </circle>
            );
            offset += len;
            return el;
          })}
        </g>
        <text x="100" y="98" textAnchor="middle" className="donut-total">{formatMoney(total, currency, { decimals: false })}</text>
        <text x="100" y="116" textAnchor="middle" className="tick">{centerLabel}</text>
      </svg>
      <ul className="legend-list">
        {slices.map((s, i) => (
          <li key={s.key}>
            <button type="button" className="link-btn plain" onClick={() => show(s.figure)} onMouseEnter={() => setHover(s.key)} onMouseLeave={() => setHover(null)}>
              <i className={`sw c${(i % 6) + 1} ${s.key === 'autres' ? 'other' : ''}`} />
              {s.name}
            </button>
            <span className="num">{formatMoney(s.value, currency, { decimals: false })} · {(s.share_e4 / 100).toFixed(0)} %</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Barres horizontales Prévu (fond) / Réel (trait) par famille. */
export function BudgetBars({ rows, currency }: { rows: { key: string; name: string; prevu: Figure; reel: Figure }[]; currency: Currency }) {
  const { show } = useDetail();
  const max = Math.max(1, ...rows.flatMap((r) => [r.prevu.value ?? 0, r.reel.value ?? 0]));
  return (
    <table className="table bars">
      <thead><tr><th>Famille</th><th className="num">Prévu</th><th className="num">Réel</th><th style={{ width: '38%' }}></th></tr></thead>
      <tbody>
        {rows.map((r) => {
          const over = r.reel.value !== null && r.prevu.value !== null && r.reel.value > r.prevu.value;
          return (
            <tr key={r.key}>
              <td>{r.name}</td>
              <td className="num"><button className="figure-btn" onClick={() => show(r.prevu)}>{r.prevu.value === null ? '—' : formatMoney(r.prevu.value, currency, { decimals: false })}</button></td>
              <td className="num"><button className="figure-btn" onClick={() => show(r.reel)}>{r.reel.value === null ? '—' : formatMoney(r.reel.value, currency, { decimals: false })}</button></td>
              <td>
                <div className="hbar" title={`Prévu ${formatMoney(r.prevu.value ?? 0, currency)} · Réel ${formatMoney(r.reel.value ?? 0, currency)}`}>
                  <span className="hbar-plan" style={{ width: `${((r.prevu.value ?? 0) / max) * 100}%` }} />
                  <span className={`hbar-real ${over ? 'over' : ''}`} style={{ width: `${(Math.max(0, r.reel.value ?? 0) / max) * 100}%` }} />
                </div>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
