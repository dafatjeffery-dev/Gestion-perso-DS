import { Fragment, useMemo, useState } from 'react';
import { addMonths, formatDateFr, formatMonthFr, monthOf } from '../../domain/dates';
import { formatMoney } from '../../domain/money';
import type { CoverageMode, Currency, Movement, NatureCode } from '../../domain/types';
import { annualView } from '../../engine/occurrences';
import { monthTracking, type FamilyTracking, type RubriqueTracking } from '../../engine/tracking';
import * as eng from '../../services/engagements';
import * as mv from '../../services/movements';
import { Amount, Field, FigureValue, Modal, MoneyInput, Notice, errorText } from '../components/core';
import { DraftBanner, useGuard, useProtectedForm } from '../components/guard';
import { useData } from '../data';
import { natureLabel, naturesFor } from '../labels';
import { useNav } from '../nav';
import { CoverageChoice } from './Operations';

const STATE_LABEL = { futur: 'mois futur', en_cours: 'mois en cours — réel partiel', ecoule: 'mois écoulé, non clôturé — chiffres provisoires', cloture: 'mois clôturé' } as const;

export function MonthlyScreen() {
  const { snap, ctx, real, driver, reload, today } = useData();
  const nav = useNav();
  const guard = useGuard();
  const [month, setMonth] = useState(nav.params.month ?? monthOf(today));
  const [showBudgets, setShowBudgets] = useState(false);
  const [hideUnused, setHideUnused] = useState(true);
  const [showSmoothed, setShowSmoothed] = useState(false);
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [totalFor, setTotalFor] = useState<number | null>(null);
  const [budgetFor, setBudgetFor] = useState<number | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const mt = useMemo(() => monthTracking(ctx, month, real), [ctx, month, real]);
  const smoothed = useMemo(() => {
    if (!showSmoothed) return new Map<number, number>();
    const m = new Map<number, number>();
    for (const r of snap.recurrences) {
      const a = annualView(ctx, r.id, month);
      if (a.currency !== ctx.base) continue;
      m.set(r.rubrique_id, (m.get(r.rubrique_id) ?? 0) + a.smoothed_minor);
    }
    return m;
  }, [showSmoothed, snap.recurrences, ctx, month]);

  const expectedMonth = mt.families.flatMap((f) => f.rubriques.flatMap((r) => [...r.expected, ...r.late]));
  const visibleRub = (r: RubriqueTracking) => !hideUnused || !r.unused;
  const sections: { title: string; fams: FamilyTracking[] }[] = [
    { title: 'Revenus', fams: mt.families.filter((f) => f.direction === 'revenu') },
    { title: 'Dépenses', fams: mt.families.filter((f) => f.direction === 'depense') },
  ];
  const toggle = (id: number) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  return (
    <div>
      <div className="screen-head">
        <h1>Suivi mensuel</h1>
        <div className="month-nav">
          <button aria-label="Mois précédent" onClick={() => setMonth(addMonths(month, -1))}>‹</button>
          <input type="month" aria-label="Mois" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} />
          <button aria-label="Mois suivant" onClick={() => setMonth(addMonths(month, 1))}>›</button>
          <button onClick={() => setMonth(addMonths(month, -12))}>− 1 an</button>
          <button onClick={() => setMonth(addMonths(month, 12))}>+ 1 an</button>
        </div>
      </div>
      <p className="sub">
        <strong>{formatMonthFr(month)}</strong> · {STATE_LABEL[mt.state]}{' '}
        {mt.state === 'ecoule' && (
          <button onClick={async () => { try { await eng.closeMonth(driver, snap, month, today); await reload(); setMsg(`${formatMonthFr(month)} clôturé : il compte désormais comme mois complet.`); } catch (e) { setMsg(errorText(e)); } }}>Clôturer le mois</button>
        )}
        {mt.state === 'cloture' && (
          <button onClick={async () => { await eng.reopenMonth(driver, snap, month); await reload(); }}>Rouvrir</button>
        )}
      </p>
      {msg && <Notice kind="ok">{msg}</Notice>}
      {mt.conflicts.length > 0 && (
        <Notice kind="error">
          {mt.conflicts.length} rubrique(s) ont à la fois des opérations et un total sans décision : leurs montants ne sont pas comptés tant que vous n’avez pas choisi (ouvrez « Total du mois »).
        </Notice>
      )}
      <div className="filterbar">
        <label className="check"><input type="checkbox" checked={hideUnused} onChange={(e) => setHideUnused(e.target.checked)} /> Masquer les rubriques inutilisées</label>
        <label className="check"><input type="checkbox" checked={showBudgets} onChange={(e) => setShowBudgets(e.target.checked)} /> Budgets initial et actualisé</label>
        <label className="check"><input type="checkbox" checked={showSmoothed} onChange={(e) => setShowSmoothed(e.target.checked)} /> Repère lissé (annuel / 12)</label>
      </div>
      {hideUnused && <p className="sub small">Une rubrique avec budget, opération, total ou échéance ce mois-ci n’est jamais masquée.</p>}

      <section className="card">
        <h2>Engagements du mois</h2>
        {expectedMonth.length === 0 && <p className="sub">Aucune échéance identifiée ce mois-ci.</p>}
        <table className="table">
          <tbody>
            {expectedMonth.map((e) => (
              <tr key={e.key}>
                <td>{formatDateFr(e.due_date)}</td>
                <td>{e.label}</td>
                <td className="num"><Amount value={e.amount_minor} currency={e.currency} /></td>
                <td>
                  <span className={`tag ${e.status === 'soldee' ? 'ok' : e.status === 'en_retard' ? '' : 'n'}`}>
                    {e.status === 'soldee' ? (e.gap ? `soldée (écart ${formatMoney(e.gap, e.currency, { signed: true })})` : 'soldée') : e.status === 'partielle' ? `partielle — reste ${formatMoney(e.remaining, e.currency)}` : e.status === 'en_retard' ? 'en retard' : 'à venir'}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {sections.map((sec) => (
        <section className="card" key={sec.title}>
          <h2>{sec.title}</h2>
          <table className="table tracking">
            <thead>
              <tr>
                <th>Famille / rubrique</th>
                {showBudgets && <th className="num">Budget initial</th>}
                {showBudgets && <th className="num">Budget actualisé</th>}
                {showSmoothed && <th className="num" title="Repère de pilotage, jamais additionné">Repère lissé</th>}
                <th className="num">Prévu</th>
                <th className="num">Réalisé</th>
                <th className="num">Reste attendu</th>
                <th className="num">Écart</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {sec.fams.map((f) => {
                const rubs = f.rubriques.filter(visibleRub);
                if (hideUnused && rubs.length === 0) return null;
                const isOpen = open.has(f.family_id);
                return (
                  <Fragment key={f.family_id}>
                    <tr className="family-row">
                      <td><button className="link-btn" aria-expanded={isOpen} onClick={() => toggle(f.family_id)}>{isOpen ? '▾' : '▸'} {f.name}</button></td>
                      {showBudgets && <td />}
                      {showBudgets && <td />}
                      {showSmoothed && <td />}
                      <td className="num"><FigureValue f={f.prevu} decimals={false} /></td>
                      <td className="num"><FigureValue f={f.reel} decimals={false} /></td>
                      <td className="num"><FigureValue f={f.reste} decimals={false} /></td>
                      <td className="num"><FigureValue f={f.ecart} decimals={false} signed /></td>
                      <td />
                    </tr>
                    {isOpen && rubs.map((r) => (
                      <tr key={r.rubrique_id} className="rub-row">
                        <td>
                          {snap.rubriques.find((x) => x.id === r.rubrique_id)!.name}
                          {r.budgetBelowExpected && <span className="tag" title={r.prevu.notes.join(' ')}>budget &lt; échéances</span>}
                          {r.state === 'en_cours' && snap.rubriques.find((x) => x.id === r.rubrique_id)!.estimation_method !== 'budget' && <div className="sub small">{r.estimation}</div>}
                        </td>
                        {showBudgets && <td className="num"><Amount value={r.budget?.initial ?? null} currency={r.budget?.currency ?? ctx.base} reason="aucun budget" decimals={false} /></td>}
                        {showBudgets && <td className="num"><Amount value={r.budget?.actualise ?? null} currency={r.budget?.currency ?? ctx.base} reason="pas d’actualisation" decimals={false} /></td>}
                        {showSmoothed && <td className="num sub"><Amount value={smoothed.has(r.rubrique_id) ? Math.abs(smoothed.get(r.rubrique_id)!) : null} currency={ctx.base} reason="aucune récurrence" decimals={false} /></td>}
                        <td className="num"><FigureValue f={r.prevu} decimals={false} /></td>
                        <td className="num"><FigureValue f={r.reel} decimals={false} /></td>
                        <td className="num"><FigureValue f={r.reste} decimals={false} /></td>
                        <td className="num"><FigureValue f={r.ecart} decimals={false} signed /></td>
                        <td className="actions small">
                          <button onClick={() => setTotalFor(r.rubrique_id)} title="Saisir un total mensuel sans détail">Total du mois</button>
                          <button onClick={() => setBudgetFor(r.rubrique_id)}>Budget</button>
                        </td>
                      </tr>
                    ))}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </section>
      ))}
      <p className="sub small">
        Prévu = échéances identifiées + enveloppe libre (budget − échéances). Reste attendu = enveloppe restante + échéances non soldées. Écart projeté (mois en cours) = réel + reste − budget. Cliquez un montant pour sa composition.
      </p>
      {totalFor !== null && <TotalsDialog rubriqueId={totalFor} month={month} onClose={() => guard.attempt(() => setTotalFor(null))} />}
      {budgetFor !== null && <BudgetDialog rubriqueId={budgetFor} month={month} onClose={() => guard.attempt(() => setBudgetFor(null))} />}
    </div>
  );
}

function TotalsDialog({ rubriqueId, month, onClose }: { rubriqueId: number; month: string; onClose: () => void }) {
  const { snap, driver, reload } = useData();
  const r = snap.rubriques.find((x) => x.id === rubriqueId)!;
  const totals = snap.movements.filter((m) => m.granularity === 'total' && m.rubrique_id === rubriqueId && m.period_month === month);
  const ops = snap.movements.filter((m) => m.granularity === 'operation' && m.rubrique_id === rubriqueId && m.period_month === month);
  const decision = snap.coverage.find((d) => d.rubrique_id === rubriqueId && d.period_month === month);
  const [undo, setUndo] = useState<{ group: string; message: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title={`Total du mois — ${r.name} — ${formatMonthFr(month)}`} onClose={onClose} wide>
      <p className="sub">{ops.length} opération(s) détaillée(s) ce mois-ci dans cette rubrique.{decision && ` Règle retenue : ${mv.COVERAGE_LABEL[decision.mode]}.`}</p>
      {undo && (
        <Notice kind="ok">
          {undo.message}{' '}
          <button onClick={async () => { try { await mv.undoGroup(driver, undo.group); await reload(); setUndo(null); } catch (e) { setError(errorText(e)); } }}>Annuler cette action</button>
        </Notice>
      )}
      {error && <Notice kind="error">{error}</Notice>}
      {totals.map((t) => <ExistingTotal key={t.id} t={t} onDone={(u) => setUndo(u)} />)}
      <NewTotal rubriqueId={rubriqueId} month={month} />
    </Modal>
  );
}

function ExistingTotal({ t, onDone }: { t: Movement; onDone: (u: { group: string; message: string }) => void }) {
  const { snap, driver, reload } = useData();
  const [amount, setAmount] = useState<number | null>(t.amount_minor);
  const [target, setTarget] = useState(addMonths(t.period_month, 1));
  const [conflict, setConflict] = useState<{ mode: 'deplacer' | 'dupliquer'; out: Extract<mv.MoveOutcome, { kind: 'conflit' }> } | null>(null);
  const [resolution, setResolution] = useState<mv.DestinationResolution | null>(null);
  const [coverage, setCoverage] = useState<CoverageMode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (mode: 'deplacer' | 'dupliquer') => {
    setError(null);
    try {
      const out = await mv.moveOrDuplicateTotal(driver, snap, t.id, target, mode, { resolution: resolution ?? undefined, coverage: coverage ?? undefined });
      if (out.kind === 'conflit') setConflict({ mode, out });
      else {
        setConflict(null);
        await reload();
        onDone({ group: out.group, message: out.message });
      }
    } catch (e) {
      setError(errorText(e));
    }
  };
  return (
    <div className="subsection">
      <div className="row-between">
        <strong>Total enregistré : <Amount value={t.amount_minor} currency={t.currency} /></strong>
        <span className="sub">{t.comment}</span>
      </div>
      <div className="grid3">
        <Field label="Modifier (corrige ce total)">
          <span className="row">
            <MoneyInput value={amount} onChange={setAmount} currency={t.currency} ariaLabel="Nouveau montant du total" />
            <button disabled={amount === null || amount === t.amount_minor} onClick={async () => { try { await mv.updateTotal(driver, snap, t.id, { amount_minor: amount! }); await reload(); } catch (e) { setError(errorText(e)); } }}>Corriger</button>
          </span>
        </Field>
        <Field label="Vers le mois" hint="Déplacer retire le total de ce mois ; dupliquer en crée une copie.">
          <input type="month" aria-label="Mois de destination" value={target} onChange={(e) => { setTarget(e.target.value); setConflict(null); setResolution(null); }} />
        </Field>
        <div className="actions" style={{ alignSelf: 'end' }}>
          <button onClick={() => run('deplacer')}>Déplacer</button>
          <button onClick={() => run('dupliquer')}>Dupliquer</button>
        </div>
      </div>
      {conflict && (
        <Notice kind="warn">
          <p>{conflict.out.message}</p>
          {conflict.out.needsResolution && (
            <div>
              <label className="check"><input type="radio" name={`res${t.id}`} checked={resolution === 'fusionner'} onChange={() => setResolution('fusionner')} /> Fusionner (additionner les deux totaux)</label>
              <label className="check"><input type="radio" name={`res${t.id}`} checked={resolution === 'remplacer'} onChange={() => setResolution('remplacer')} /> Remplacer (l’ancien total va à la corbeille)</label>
            </div>
          )}
          {conflict.out.needsCoverage && (
            <div>
              {(Object.keys(mv.COVERAGE_LABEL) as CoverageMode[]).map((k) => (
                <label key={k} className="check"><input type="radio" name={`cov${t.id}`} checked={coverage === k} onChange={() => setCoverage(k)} /> {mv.COVERAGE_LABEL[k]}</label>
              ))}
            </div>
          )}
          <div className="actions">
            <button className="primary" disabled={(conflict.out.needsResolution && !resolution) || (conflict.out.needsCoverage && !coverage)} onClick={() => run(conflict.mode)}>Confirmer</button>
            <button onClick={() => setConflict(null)}>Ne rien faire</button>
          </div>
        </Notice>
      )}
      {error && <Notice kind="error">{error}</Notice>}
    </div>
  );
}

function NewTotal({ rubriqueId, month }: { rubriqueId: number; month: string }) {
  const { snap, driver, reload, ctx } = useData();
  const fam = snap.families.find((f) => f.id === snap.rubriques.find((r) => r.id === rubriqueId)!.family_id)!;
  const natures = naturesFor(snap, rubriqueId).filter((n) => !['transfert', 'emprunt_recu', 'capital_credit'].includes(n));
  const [coverageErr, setCoverageErr] = useState<mv.CoverageRequired | null>(null);
  const [coverage, setCoverage] = useState<CoverageMode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const form = useProtectedForm(`total:${rubriqueId}:${month}`, 'Nouveau total mensuel', { magnitude: null as number | null, currency: ctx.base as Currency, nature: (natures[0] ?? 'depense') as NatureCode, comment: '' }, async (v) => {
    setError(null);
    if (v.magnitude === null) {
      setError('Montant : à renseigner');
      return false;
    }
    const signed = fam.direction === 'depense' && v.nature !== 'remboursement_depense' ? -Math.abs(v.magnitude) : Math.abs(v.magnitude);
    try {
      await mv.createTotal(driver, snap, { rubrique_id: rubriqueId, period_month: month, amount_minor: signed, currency: v.currency, nature: v.nature, comment: v.comment }, { coverage: coverage ?? undefined });
      await reload();
      setSaved(true);
      return true;
    } catch (e) {
      if (e instanceof mv.CoverageRequired) setCoverageErr(e);
      else setError(errorText(e));
      return false;
    }
  });
  const v = form.values;
  return (
    <form className="subsection" onSubmit={async (e) => { e.preventDefault(); if (await form.save()) form.setValues({ ...v, magnitude: null, comment: '' }); }}>
      <h3>Saisir un total</h3>
      <DraftBanner offer={form.draftOffer} onRestore={form.restoreDraft} onIgnore={form.ignoreDraft} />
      <Notice>{mv.TOTAL_NOTICE}</Notice>
      <div className="grid3">
        <Field label={fam.direction === 'depense' ? 'Montant dépensé' : 'Montant reçu'}>
          <MoneyInput value={v.magnitude} onChange={(x) => form.set({ magnitude: x })} currency={v.currency} ariaLabel="Montant du total" />
        </Field>
        <Field label="Devise">
          <select value={v.currency} onChange={(e) => form.set({ currency: e.target.value as Currency })}><option>EUR</option><option>CHF</option></select>
        </Field>
        <Field label="Nature">
          <select value={v.nature} onChange={(e) => form.set({ nature: e.target.value as NatureCode })}>
            {natures.map((n) => <option key={n} value={n}>{natureLabel(snap, n)}</option>)}
          </select>
        </Field>
      </div>
      <Field label="Commentaire"><input value={v.comment} onChange={(e) => form.set({ comment: e.target.value })} /></Field>
      {coverageErr && <CoverageChoice err={coverageErr} value={coverage} onChange={setCoverage} />}
      {error && <Notice kind="error">{error}</Notice>}
      {saved && !form.dirty && <Notice kind="ok">Total enregistré.</Notice>}
      <div className="actions"><button type="submit" className="primary">Enregistrer le total</button></div>
    </form>
  );
}

function BudgetDialog({ rubriqueId, month, onClose }: { rubriqueId: number; month: string; onClose: () => void }) {
  const { snap, driver, reload, ctx } = useData();
  const r = snap.rubriques.find((x) => x.id === rubriqueId)!;
  const bm = snap.budgetMonths.find((b) => b.rubrique_id === rubriqueId && b.period_month === month);
  const plan = snap.budgetPlans.find((p) => p.rubrique_id === rubriqueId && p.valid_from_month <= month && (p.valid_to_month === null || p.valid_to_month >= month));
  const [error, setError] = useState<string | null>(null);
  const form = useProtectedForm(`budget:${rubriqueId}:${month}`, `Budget « ${r.name} »`, { planAmount: plan?.monthly_minor ?? null, planFrom: month, actualise: bm?.actualise_minor ?? null }, async (v) => {
    setError(null);
    try {
      if (v.planAmount !== (plan?.monthly_minor ?? null) || v.planFrom !== month) {
        await eng.setBudgetPlan(driver, snap, { rubrique_id: rubriqueId, from_month: v.planFrom, monthly_minor: v.planAmount });
      }
      const fresh = await (await import('../../storage/snapshot')).loadSnapshot(driver);
      if (v.actualise !== (bm?.actualise_minor ?? null)) {
        await eng.setMonthBudget(driver, fresh, { rubrique_id: rubriqueId, month, actualise_minor: v.actualise });
      }
      await reload();
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    }
  });
  const v = form.values;
  return (
    <Modal title={`Budget — ${r.name}`} onClose={onClose}>
      <DraftBanner offer={form.draftOffer} onRestore={form.restoreDraft} onIgnore={form.ignoreDraft} />
      <form onSubmit={async (e) => { e.preventDefault(); if (await form.save()) onClose(); }}>
        <h3>Budget mensuel habituel</h3>
        <div className="grid2">
          <Field label="Montant par mois" hint="Vide = pas de budget">
            <MoneyInput value={v.planAmount} onChange={(x) => form.set({ planAmount: x === null ? null : Math.abs(x) })} currency={ctx.base} allowEmpty ariaLabel="Budget mensuel" />
          </Field>
          <Field label="À partir de" hint="Le budget précédent reste valable avant cette date">
            <input type="month" value={v.planFrom} onChange={(e) => form.set({ planFrom: e.target.value })} />
          </Field>
        </div>
        <h3>{formatMonthFr(month)} uniquement</h3>
        <p className="sub">Budget initial du mois : {bm ? formatMoney(bm.initial_minor, bm.currency) : plan ? `${formatMoney(plan.monthly_minor, plan.currency)} (sera figé à la première modification)` : '—'}</p>
        <Field label="Budget actualisé" hint="Révision explicite pour ce mois ; le budget initial est conservé">
          <MoneyInput value={v.actualise} onChange={(x) => form.set({ actualise: x === null ? null : Math.abs(x) })} currency={ctx.base} allowEmpty ariaLabel="Budget actualisé" />
        </Field>
        {error && <Notice kind="error">{error}</Notice>}
        <div className="actions">
          <button type="submit" className="primary">Enregistrer</button>
          <button type="button" onClick={onClose}>Annuler</button>
        </div>
      </form>
    </Modal>
  );
}
