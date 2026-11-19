import { useMemo, useState } from 'react';
import { addMonths, formatDateFr, formatMonthFr, monthsBetween } from '../../domain/dates';
import type { Owner } from '../../domain/types';
import { expenseDonut, flows, periodLabel, periodLines, scopeInfo, type Scope } from '../../engine/analysis';
import { checks } from '../../engine/checks';
import { fig, sumFig, type Figure } from '../../engine/figure';
import { forecast } from '../../engine/forecast';
import { fundState, situation } from '../../engine/funds';
import { monthTracking } from '../../engine/tracking';
import { BudgetBars, Donut, ForecastChart, type DonutSliceView } from '../components/charts';
import { Amount, FigureValue, Notice } from '../components/core';
import { useData } from '../data';
import { useNav } from '../nav';

const MAX_PERIOD_MONTHS = 24;

export function OverviewScreen() {
  const { ctx, real, snap, today } = useData();
  const nav = useNav();
  const [from, setFrom] = useState(ctx.currentMonth);
  const [to, setTo] = useState(ctx.currentMonth);
  const [scopeKey, setScopeKey] = useState('foyer');
  const [more, setMore] = useState(false);
  const [allChecks, setAllChecks] = useState(false);

  const s = useMemo(() => situation(ctx), [ctx]);
  const fc = useMemo(() => forecast(ctx, { real }), [ctx, real]);
  const items = useMemo(() => checks(ctx, real), [ctx, real]);

  const scope: Scope = scopeKey === 'foyer' ? { kind: 'foyer' } : scopeKey.startsWith('acc:') ? { kind: 'compte', account_id: Number(scopeKey.slice(4)) } : { kind: 'personne', owner: scopeKey.slice(4) as Owner };
  const info = scopeInfo(ctx, scope);
  const periodOk = from <= to && monthsBetween(from, to) < MAX_PERIOD_MONTHS;
  const period = { from, to };
  const analysis = useMemo(() => {
    if (!periodOk) return null;
    const lines = periodLines(ctx, period, scope, real);
    const fl = flows(ctx, lines);
    const donut = expenseDonut(ctx, lines);
    let budget: { key: string; name: string; prevu: Figure; reel: Figure }[] = [];
    if (info.budgetComparable) {
      const months: string[] = [];
      for (let m = from; m <= to; m = addMonths(m, 1)) months.push(m);
      const tracks = months.map((m) => monthTracking(ctx, m, real));
      budget = tracks[0]!.families
        .filter((f) => f.direction === 'depense')
        .map((f) => {
          const per = tracks.map((t) => t.families.find((x) => x.family_id === f.family_id)!);
          return {
            key: String(f.family_id),
            name: f.name,
            prevu: sumFig(`ov.prevu.${f.family_id}`, `Prévu — ${f.name}`, 'Somme des prévus mensuels de la famille sur la période', ctx.base, per.map((x, i) => ({ ...x.prevu, label: formatMonthFr(months[i]!) }))),
            reel: sumFig(`ov.reel.${f.family_id}`, `Réel — ${f.name}`, 'Somme des réels mensuels de la famille sur la période', ctx.base, per.map((x, i) => ({ ...x.reel, label: formatMonthFr(months[i]!) }))),
          };
        })
        .filter((r) => (r.prevu.value ?? 1) !== 0 || (r.reel.value ?? 1) !== 0);
    }
    return { lines, fl, donut, budget };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx, real, from, to, scopeKey, periodOk]);

  const donutSlices: DonutSliceView[] = useMemo(() => {
    if (!analysis) return [];
    const sl = analysis.donut.slices;
    const top = sl.slice(0, 5);
    const rest = sl.slice(5);
    const out: DonutSliceView[] = top.map((x) => ({ key: String(x.family_id), name: x.name, value: x.value, share_e4: x.share_e4, figure: fig(`anneau.${x.family_id}`, x.name, 'Dépense nette de la famille sur la période', x.value, ctx.base) }));
    if (rest.length) {
      const v = rest.reduce((a, b) => a + b.value, 0);
      out.push({ key: 'autres', name: `Autres (${rest.length})`, value: v, share_e4: rest.reduce((a, b) => a + b.share_e4, 0), figure: sumFig('anneau.autres', 'Autres familles', 'Familles regroupées au-delà des cinq premières', ctx.base, rest.map((x) => fig(`anneau.${x.family_id}`, x.name, 'Dépense nette', x.value, ctx.base))) });
    }
    return out;
  }, [analysis, ctx.base]);

  const projects = snap.funds.filter((f) => f.kind === 'projet' && f.status === 'actif');
  const refDates = snap.balanceRefs.length ? snap.balanceRefs.map((b) => b.ref_date).sort() : [];
  const shown = allChecks ? items : items.slice(0, 5);

  return (
    <div>
      <h1>Vue d’ensemble</h1>
      <p className="sub">{snap.household.name} · {formatDateFr(today)}</p>

      <section className="zone" aria-labelledby="z1">
        <div className="zone-head">
          <h2 id="z1">Situation et prévision</h2>
          <span className="sub small">Foyer entier · euros · prévision : {fc.hypothesisLabel}</span>
        </div>
        <h3>Situation actuelle</h3>
        <div className="kpis">
          <div className="kpi">
            <div className="l">Liquidités totales</div>
            <div className="v"><FigureValue f={s.liquidites} decimals={false} /></div>
            <div className="d">{refDates.length ? `soldes constatés du ${formatDateFr(refDates[0]!)} au ${formatDateFr(refDates[refDates.length - 1]!)}` : 'aucun solde constaté'}</div>
          </div>
          <div className="kpi accent">
            <div className="l">Non affecté</div>
            <div className="v"><FigureValue f={s.nonAffecte} decimals={false} /></div>
            <div className="d">= liquidités − réservé (<Amount value={s.reserve.value} currency={ctx.base} decimals={false} />)</div>
          </div>
          <div className="kpi">
            <div className="l">Réserve de sécurité</div>
            <div className="v">{s.reserveFund ? <Amount value={s.reserveFund.reserved} currency={s.reserveFund.fund.currency} decimals={false} /> : <span className="absent">—</span>}</div>
            <div className="d">{s.reserveFund ? `affecté${s.reserveFund.fund.target_minor ? ` · cible ${Math.round((s.reserveFund.progress_e4 ?? 0) / 100)} %` : ''}` : 'non définie'}</div>
          </div>
        </div>
        <div className="row2">
          <div>
            <h3>Perspectives — liquidités prévues en fin de mois</h3>
            <ForecastChart points={fc.points} currency={ctx.base} minMonth={fc.minimumMonth} />
          </div>
          <div className="stack">
            <div className="kpi">
              <div className="l">Minimum des soldes prévus en fin de mois</div>
              <div className="v"><FigureValue f={fc.minimum} decimals={false} /></div>
              <div className="d">{fc.minimumMonth ? `fin ${formatMonthFr(fc.minimumMonth)} · horizon ${fc.points.length} mois` : ''}</div>
            </div>
            <div className="kpi">
              <div className="l">Marge après réserve et fonds</div>
              <div className="v"><FigureValue f={fc.marge} decimals={false} /></div>
              <div className="d">{fc.margeMonth ? `fin ${formatMonthFr(fc.margeMonth)}` : ''}</div>
            </div>
            {fc.warnings.map((w) => <p key={w} className="sub small">{w}</p>)}
          </div>
        </div>
      </section>

      <section className="zone" aria-labelledby="z2">
        <div className="zone-head">
          <h2 id="z2">Analyse de la période</h2>
          <div className="filters" role="group" aria-label="Filtres d’analyse">
            <label className="chip-input">Du <input type="month" aria-label="Début de période" value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} /></label>
            <label className="chip-input">au <input type="month" aria-label="Fin de période" value={to} onChange={(e) => e.target.value && setTo(e.target.value)} /></label>
            <select aria-label="Périmètre" value={scopeKey} onChange={(e) => setScopeKey(e.target.value)}>
              <option value="foyer">Foyer</option>
              <optgroup label="Personne">
                {snap.persons.map((p) => <option key={p.role} value={`own:${p.role}`}>{p.display_name}</option>)}
                <option value="own:commun">Comptes communs</option>
              </optgroup>
              <optgroup label="Compte">
                {snap.accounts.map((a) => <option key={a.id} value={`acc:${a.id}`}>{a.name}</option>)}
              </optgroup>
            </select>
            <button className="link-btn" onClick={() => setMore(!more)} aria-expanded={more}>{more ? 'Moins d’options ▴' : 'Plus d’options ▾'}</button>
          </div>
        </div>
        {more && (
          <div className="filters secondary">
            <button onClick={() => { setFrom(addMonths(ctx.currentMonth, -1)); setTo(addMonths(ctx.currentMonth, -1)); }}>Mois précédent</button>
            <button onClick={() => { setFrom(addMonths(ctx.currentMonth, -2)); setTo(ctx.currentMonth); }}>3 derniers mois</button>
            <button onClick={() => { setFrom(`${ctx.currentMonth.slice(0, 4)}-01`); setTo(ctx.currentMonth); }}>Depuis janvier</button>
          </div>
        )}
        {!periodOk && <Notice kind="warn">{from > to ? 'Le début de période est après la fin.' : `Période limitée à ${MAX_PERIOD_MONTHS} mois pour l’analyse : réduisez la sélection.`}</Notice>}
        {info.exclusions.length > 0 && <Notice>Périmètre {info.label} : sont exclus {info.exclusions.join(' ; ')}.</Notice>}
        {analysis && (
          <div className="grid-analysis">
            <div>
              <h3>Budget et réel — dépenses · {periodLabel(period)}</h3>
              {info.budgetComparable ? (
                analysis.budget.length ? <BudgetBars rows={analysis.budget} currency={ctx.base} /> : <p className="sub">Aucun budget, échéance ni dépense sur la période.</p>
              ) : (
                <p className="sub">Comparaison au budget indisponible : les budgets sont familiaux et ne se comparent pas à un {scope.kind === 'compte' ? 'compte isolé' : 'périmètre partiel'}.</p>
              )}
            </div>
            <div>
              <h3>Répartition des dépenses</h3>
              {analysis.donut.missing && <Notice kind="warn">Certaines lignes n’ont pas de taux EUR/CHF : elles manquent dans l’anneau.</Notice>}
              {donutSlices.length ? (
                <Donut slices={donutSlices} total={analysis.donut.denominator.value ?? 0} currency={ctx.base} centerLabel="dépenses nettes" />
              ) : (
                <p className="sub">Aucune dépense sur la période.</p>
              )}
              <p className="sub small">Pourcentages de la somme des familles en dépense nette ({analysis.donut.denominator.value === null ? '—' : <Amount value={analysis.donut.denominator.value} currency={ctx.base} decimals={false} />}).{analysis.donut.netPositive.length ? ` Présentées à part (remboursements supérieurs aux dépenses) : ${analysis.donut.netPositive.map((x) => x.name).join(', ')}.` : ''}</p>
            </div>
            <div>
              <h3>Entrées et sorties</h3>
              <table className="table">
                <tbody>
                  {(['revenu_structurel', 'revenu_exceptionnel', 'consommation', 'a_classer', 'capital', 'emprunt', 'epargne'] as const).map((c) => {
                    const f = analysis.fl.byCategory[c]!;
                    if (f.value === 0 && ['a_classer', 'emprunt', 'revenu_exceptionnel'].includes(c)) return null;
                    return <tr key={c}><td>{f.label}</td><td className="num"><FigureValue f={f} decimals={false} /></td></tr>;
                  })}
                  <tr className="total"><td><strong>{analysis.fl.figure.label}</strong></td><td className="num"><strong><FigureValue f={analysis.fl.figure} decimals={false} /></strong></td></tr>
                </tbody>
              </table>
              <p className="sub small">Transferts internes : neutres, non listés ({analysis.fl.transfersCount}).</p>
            </div>
          </div>
        )}
      </section>

      <div className="row2">
        <section className="zone" aria-labelledby="z3">
          <div className="zone-head"><h2 id="z3">À vérifier</h2>{items.length > 5 && <button className="link-btn" onClick={() => setAllChecks(!allChecks)}>{allChecks ? 'Réduire' : `Voir tout (${items.length})`}</button>}</div>
          {items.length === 0 && <p className="sub">Rien à vérifier.</p>}
          <ul className="list">
            {shown.map((i, n) => (
              <li key={n}>
                <button className="link-btn plain" onClick={() => nav.go(i.target.screen, { month: i.target.month, accountId: i.target.accountId, batchId: i.target.batchId })}>{i.text}</button>
                <span className={`tag ${i.severity === 'important' ? '' : 'n'}`}>{i.severity === 'important' ? 'important' : 'info'}</span>
              </li>
            ))}
          </ul>
        </section>
        <section className="zone" aria-labelledby="z4">
          <div className="zone-head"><h2 id="z4">Projets</h2><button className="link-btn" onClick={() => nav.go('funds')}>Tous</button></div>
          {projects.length === 0 && <p className="sub">Aucun projet.</p>}
          {projects.map((p) => {
            const st = fundState(ctx, p);
            return (
              <div key={p.id} className="proj">
                <div className="row-between"><span>{p.name}{p.target_date ? ` · ${formatMonthFr(p.target_date.slice(0, 7))}` : ''}</span><span className="num"><Amount value={st.reserved} currency={p.currency} decimals={false} />{p.target_minor ? <> / <Amount value={p.target_minor} currency={p.currency} decimals={false} /></> : null}</span></div>
                {p.target_minor ? <div className="bar"><i style={{ width: `${Math.min(100, Math.max(0, (st.progress_e4 ?? 0) / 100))}%` }} /></div> : null}
              </div>
            );
          })}
          <p className="sub small">Montant réservé / objectif. Un paiement de projet consomme la réservation.</p>
        </section>
      </div>
    </div>
  );
}
