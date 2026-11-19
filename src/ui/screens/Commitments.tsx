import { useMemo, useState } from 'react';
import { addMonths, formatDateFr, monthOf, lastDay } from '../../domain/dates';
import { formatMoney } from '../../domain/money';
import type { Currency, Frequency, NatureCode, Recurrence, RecurrenceVersion } from '../../domain/types';
import { annualView, expectedBetween, versionsOf } from '../../engine/occurrences';
import * as eng from '../../services/engagements';
import { ValidationError } from '../../services/plan';
import { Amount, Field, Modal, MoneyInput, Notice, errorText } from '../components/core';
import { DraftBanner, useGuard, useProtectedForm } from '../components/guard';
import { AccountSelect, RubriqueSelect } from '../components/pickers';
import { useData } from '../data';
import { FREQUENCY, defaultNature, natureLabel, naturesFor, rubriqueLabel } from '../labels';

const MONTHS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];

function describe(v: RecurrenceVersion): string {
  const f = v.frequency === 'mensuelle' && v.interval_months > 1 ? `tous les ${v.interval_months} mois` : FREQUENCY[v.frequency].toLowerCase();
  const months = v.frequency === 'personnalisee' ? ` (${MONTHS.filter((_, i) => (v.months_mask ?? 0) & (1 << i)).join(', ')})` : '';
  return `${f}${months}, le ${v.day_of_month === 31 ? 'dernier jour' : v.day_of_month}`;
}

export function CommitmentsScreen() {
  const { snap, ctx, today } = useData();
  const guard = useGuard();
  const [form, setForm] = useState<{ kind: 'new' } | { kind: 'corriger'; v: RecurrenceVersion } | { kind: 'evoluer'; r: Recurrence } | { kind: 'arreter'; r: Recurrence } | { kind: 'echeance' } | null>(null);
  const [history, setHistory] = useState<Set<number>>(new Set());
  const active = snap.recurrences.filter((r) => !r.end_date || r.end_date >= today);
  const stopped = snap.recurrences.filter((r) => r.end_date && r.end_date < today);
  const upcoming = useMemo(() => expectedBetween(ctx, `${addMonths(monthOf(today), -3)}-01`, lastDay(addMonths(monthOf(today), 12))).filter((e) => e.kind === 'echeance'), [ctx, today]);
  const close = () => guard.attempt(() => setForm(null));

  const row = (r: Recurrence) => {
    const vs = versionsOf(ctx, r.id);
    const cur = vs.find((v) => v.valid_from <= today && (!v.valid_to || v.valid_to >= today)) ?? vs[vs.length - 1];
    const next = expectedBetween(ctx, today, lastDay(addMonths(monthOf(today), 24))).find((e) => e.recurrence_id === r.id);
    const a = annualView(ctx, r.id, monthOf(today));
    const carried = snap.loans.find((l) => l.recurrence_id === r.id);
    return (
      <tr key={r.id}>
        <td>
          <strong>{r.label}</strong>
          <div className="sub small">{rubriqueLabel(snap, r.rubrique_id)}{r.planned_account_id ? ` · ${snap.accounts.find((x) => x.id === r.planned_account_id)?.name}` : ''}</div>
          {carried && <div className="sub small">Portée par le crédit « {carried.label} » : ses échéances remplacent cette récurrence.</div>}
        </td>
        <td>{cur ? <><Amount value={cur.amount_minor} currency={cur.currency} /> <span className="sub">{describe(cur)}</span></> : '—'}</td>
        <td>{next ? formatDateFr(next.due_date) : r.end_date ? `arrêtée au ${formatDateFr(r.end_date)}` : '—'}</td>
        <td className="num" title="Somme des 12 prochains mois ; repère lissé = annuel / 12, jamais additionné"><Amount value={a.annual_minor} currency={a.currency} decimals={false} /><div className="sub small">lissé {formatMoney(a.smoothed_minor, a.currency, { decimals: false })}/mois</div></td>
        <td className="actions small">
          {cur && <button title={eng.RECURRENCE_ACTIONS.corriger} onClick={() => setForm({ kind: 'corriger', v: cur })}>Corriger</button>}
          <button title={eng.RECURRENCE_ACTIONS.evoluer} onClick={() => setForm({ kind: 'evoluer', r })}>Faire évoluer</button>
          <button title={eng.RECURRENCE_ACTIONS.arreter} onClick={() => setForm({ kind: 'arreter', r })}>{r.end_date ? 'Date de fin' : 'Arrêter'}</button>
          <button onClick={() => setHistory((s) => { const n = new Set(s); if (n.has(r.id)) n.delete(r.id); else n.add(r.id); return n; })}>Versions ({vs.length})</button>
          {history.has(r.id) && (
            <ul className="versions">
              {vs.map((v) => (
                <li key={v.id}>du {formatDateFr(v.valid_from)}{v.valid_to ? ` au ${formatDateFr(v.valid_to)}` : ''} : {formatMoney(v.amount_minor, v.currency)}, {describe(v)} {v.change_kind === 'evolution' ? '(évolution)' : ''}</li>
              ))}
            </ul>
          )}
        </td>
      </tr>
    );
  };

  return (
    <div>
      <div className="screen-head">
        <h1>Engagements</h1>
        <div className="actions">
          <button onClick={() => setForm({ kind: 'echeance' })}>Nouvelle échéance ponctuelle</button>
          <button className="primary" onClick={() => setForm({ kind: 'new' })}>Nouvelle récurrence</button>
        </div>
      </div>
      <p className="sub">Une récurrence active reste prise en compte dans les prévisions jusqu’à son arrêt explicite, même si sa rubrique est masquée.</p>
      <section className="card">
        <h2>Récurrences actives ({active.length})</h2>
        <table className="table">
          <thead><tr><th>Libellé</th><th>Montant en vigueur</th><th>Prochaine</th><th className="num">Sur 12 mois</th><th></th></tr></thead>
          <tbody>{active.map(row)}</tbody>
        </table>
      </section>
      <section className="card">
        <h2>Échéances ponctuelles</h2>
        <table className="table">
          <tbody>
            {upcoming.map((e) => (
              <tr key={e.key}>
                <td>{formatDateFr(e.due_date)}</td>
                <td>{e.label}<div className="sub small">{rubriqueLabel(snap, e.rubrique_id)}</div></td>
                <td className="num"><Amount value={e.amount_minor} currency={e.currency} /></td>
                <td><span className={`tag ${e.status === 'soldee' ? 'ok' : e.status === 'en_retard' ? '' : 'n'}`}>{e.status === 'soldee' ? 'soldée' : e.status === 'partielle' ? `reste ${formatMoney(e.remaining, e.currency)}` : e.status === 'en_retard' ? 'en retard' : 'à venir'}</span></td>
                <td>{e.status !== 'soldee' && <CancelScheduled id={e.scheduled_item_id!} />}</td>
              </tr>
            ))}
            {upcoming.length === 0 && <tr><td className="sub">Aucune échéance ponctuelle.</td></tr>}
          </tbody>
        </table>
      </section>
      {stopped.length > 0 && (
        <section className="card">
          <h2>Historique — récurrences arrêtées ({stopped.length})</h2>
          <table className="table"><tbody>{stopped.map(row)}</tbody></table>
        </section>
      )}
      {form?.kind === 'new' && <RecurrenceForm onClose={() => setForm(null)} requestClose={close} />}
      {form?.kind === 'corriger' && <VersionForm mode="corriger" version={form.v} onClose={() => setForm(null)} requestClose={close} />}
      {form?.kind === 'evoluer' && <VersionForm mode="evoluer" recurrence={form.r} version={versionsOf(ctx, form.r.id).slice(-1)[0]!} onClose={() => setForm(null)} requestClose={close} />}
      {form?.kind === 'arreter' && <StopForm r={form.r} onClose={() => setForm(null)} requestClose={close} />}
      {form?.kind === 'echeance' && <ScheduledForm onClose={() => setForm(null)} requestClose={close} />}
    </div>
  );
}

function CancelScheduled({ id }: { id: number }) {
  const { driver, snap, reload } = useData();
  return <button onClick={async () => { await eng.updateScheduled(driver, snap, id, { status: 'annulee' }); await reload(); }}>Annuler l’échéance</button>;
}

interface RecValues {
  label: string;
  rubrique_id: number | null;
  nature: NatureCode | null;
  magnitude: number | null;
  sens: 'sortie' | 'entree';
  currency: Currency;
  frequency: Frequency;
  interval_months: number;
  day_of_month: number;
  months_mask: number;
  start_date: string;
  end_date: string;
  planned_account_id: number | null;
}

function FrequencyFields({ v, set }: { v: Pick<RecValues, 'frequency' | 'interval_months' | 'day_of_month' | 'months_mask'>; set: (p: Partial<RecValues>) => void }) {
  return (
    <>
      <div className="grid3">
        <Field label="Fréquence">
          <select value={v.frequency} onChange={(e) => set({ frequency: e.target.value as Frequency })}>
            {Object.entries(FREQUENCY).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </Field>
        {v.frequency === 'mensuelle' && (
          <Field label="Tous les … mois"><input type="number" min={1} max={120} value={v.interval_months} onChange={(e) => set({ interval_months: Number(e.target.value) })} /></Field>
        )}
        <Field label="Jour du mois" hint="31 = dernier jour du mois"><input type="number" min={1} max={31} value={v.day_of_month} onChange={(e) => set({ day_of_month: Number(e.target.value) })} /></Field>
      </div>
      {v.frequency === 'personnalisee' && (
        <div className="months-mask" role="group" aria-label="Mois concernés">
          {MONTHS.map((m, i) => (
            <label key={m} className="check"><input type="checkbox" checked={!!(v.months_mask & (1 << i))} onChange={(e) => set({ months_mask: e.target.checked ? v.months_mask | (1 << i) : v.months_mask & ~(1 << i) })} /> {m}</label>
          ))}
        </div>
      )}
    </>
  );
}

function RecurrenceForm({ onClose, requestClose }: { onClose: () => void; requestClose: () => void }) {
  const { driver, snap, reload, today } = useData();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const form = useProtectedForm<RecValues>('recurrence:nouvelle', 'Nouvelle récurrence', { label: '', rubrique_id: null, nature: null, magnitude: null, sens: 'sortie', currency: 'EUR', frequency: 'mensuelle', interval_months: 1, day_of_month: Number(today.slice(8, 10)), months_mask: 0, start_date: today, end_date: '', planned_account_id: null }, async (v) => {
    setErrors({});
    if (!v.rubrique_id || v.magnitude === null) {
      setErrors({ general: 'Rubrique et montant : à renseigner' });
      return false;
    }
    try {
      const amount = v.sens === 'sortie' ? -Math.abs(v.magnitude) : Math.abs(v.magnitude);
      await eng.createRecurrence(driver, snap, { label: v.label, rubrique_id: v.rubrique_id, nature: v.nature ?? defaultNature(snap, v.rubrique_id, amount), amount_minor: amount, currency: v.currency, frequency: v.frequency, interval_months: v.interval_months, day_of_month: v.day_of_month, months_mask: v.frequency === 'personnalisee' ? v.months_mask : null, start_date: v.start_date, end_date: v.end_date || null, planned_account_id: v.planned_account_id });
      await reload();
      return true;
    } catch (e) {
      if (e instanceof ValidationError) setErrors(Object.fromEntries(e.errors.map((x) => [x.field, x.message])));
      else setErrors({ general: errorText(e) });
      return false;
    }
  });
  const v = form.values;
  const fam = v.rubrique_id ? snap.families.find((f) => f.id === snap.rubriques.find((r) => r.id === v.rubrique_id)!.family_id) : null;
  return (
    <Modal title="Nouvelle récurrence" onClose={requestClose} wide>
      <DraftBanner offer={form.draftOffer} onRestore={form.restoreDraft} onIgnore={form.ignoreDraft} />
      <form onSubmit={async (e) => { e.preventDefault(); if (await form.save()) onClose(); }}>
        <div className="grid2">
          <Field label="Libellé" error={errors.label}><input value={v.label} onChange={(e) => form.set({ label: e.target.value })} placeholder="Salaire, abonnement, loyer…" /></Field>
          <Field label="Rubrique" error={errors.rubrique_id}>
            <RubriqueSelect snap={snap} value={v.rubrique_id} onChange={(x) => { const f = x ? snap.families.find((ff) => ff.id === snap.rubriques.find((r) => r.id === x)!.family_id) : null; form.set({ rubrique_id: x, nature: x ? naturesFor(snap, x)[0]! : null, sens: f?.direction === 'revenu' ? 'entree' : 'sortie' }); }} />
          </Field>
        </div>
        <div className="grid3">
          <Field label={v.sens === 'entree' ? 'Montant reçu' : 'Montant payé'} error={errors.amount_minor}><MoneyInput value={v.magnitude} onChange={(x) => form.set({ magnitude: x })} currency={v.currency} ariaLabel="Montant de la récurrence" /></Field>
          <Field label="Devise" error={errors.currency}><select value={v.currency} onChange={(e) => form.set({ currency: e.target.value as Currency })}><option>EUR</option><option>CHF</option></select></Field>
          <Field label="Nature">
            <select value={v.nature ?? ''} onChange={(e) => form.set({ nature: e.target.value as NatureCode })}>
              {(v.rubrique_id ? naturesFor(snap, v.rubrique_id) : []).map((n) => <option key={n} value={n}>{natureLabel(snap, n)}</option>)}
            </select>
          </Field>
        </div>
        {fam?.direction === 'depense' && (
          <label className="check"><input type="checkbox" checked={v.sens === 'entree'} onChange={(e) => form.set({ sens: e.target.checked ? 'entree' : 'sortie' })} /> C’est une entrée (remboursement)</label>
        )}
        <FrequencyFields v={v} set={form.set} />
        <div className="grid3">
          <Field label="Début" error={errors.start_date}><input type="date" value={v.start_date} onChange={(e) => form.set({ start_date: e.target.value })} /></Field>
          <Field label="Fin (facultative)" error={errors.end_date} hint="Vide = sans fin connue"><input type="date" value={v.end_date} onChange={(e) => form.set({ end_date: e.target.value })} /></Field>
          <Field label="Compte prévu" error={errors.planned_account_id}><AccountSelect snap={snap} value={v.planned_account_id} onChange={(x) => form.set({ planned_account_id: x })} currency={v.currency} allowAll="Compte par défaut" /></Field>
        </div>
        {errors.general && <Notice kind="error">{errors.general}</Notice>}
        {errors.months_mask && <Notice kind="error">{errors.months_mask}</Notice>}
        <div className="actions"><button type="submit" className="primary">Enregistrer</button><button type="button" onClick={requestClose}>Annuler</button></div>
      </form>
    </Modal>
  );
}

function VersionForm({ mode, version, recurrence, onClose, requestClose }: { mode: 'corriger' | 'evoluer'; version: RecurrenceVersion; recurrence?: Recurrence; onClose: () => void; requestClose: () => void }) {
  const { driver, snap, reload, today } = useData();
  const rec = recurrence ?? snap.recurrences.find((r) => r.id === version.recurrence_id)!;
  const [error, setError] = useState<string | null>(null);
  const sign = Math.sign(version.amount_minor) || -1;
  const form = useProtectedForm(`version:${mode}:${version.id}`, mode === 'corriger' ? `Correction de « ${rec.label} »` : `Évolution de « ${rec.label} »`, { magnitude: Math.abs(version.amount_minor) as number | null, currency: version.currency, frequency: version.frequency, interval_months: version.interval_months, day_of_month: version.day_of_month, months_mask: version.months_mask ?? 0, from: mode === 'evoluer' ? `${addMonths(monthOf(today), 1)}-01` : version.valid_from }, async (v) => {
    setError(null);
    if (v.magnitude === null) { setError('Montant : à renseigner'); return false; }
    const patch = { amount_minor: sign * Math.abs(v.magnitude), currency: v.currency, frequency: v.frequency, interval_months: v.interval_months, day_of_month: v.day_of_month, months_mask: v.frequency === 'personnalisee' ? v.months_mask : null };
    try {
      if (mode === 'corriger') await eng.correctVersion(driver, snap, version.id, { ...patch, valid_from: v.from });
      else await eng.evolveRecurrence(driver, snap, rec.id, v.from, patch);
      await reload();
      return true;
    } catch (e) { setError(errorText(e)); return false; }
  });
  const v = form.values;
  return (
    <Modal title={`${mode === 'corriger' ? 'Corriger' : 'Faire évoluer'} « ${rec.label} »`} onClose={requestClose}>
      <Notice>{mode === 'corriger' ? eng.RECURRENCE_ACTIONS.corriger : eng.RECURRENCE_ACTIONS.evoluer}</Notice>
      <DraftBanner offer={form.draftOffer} onRestore={form.restoreDraft} onIgnore={form.ignoreDraft} />
      <form onSubmit={async (e) => { e.preventDefault(); if (await form.save()) onClose(); }}>
        <div className="grid2">
          <Field label="Montant"><MoneyInput value={v.magnitude} onChange={(x) => form.set({ magnitude: x })} currency={v.currency} ariaLabel="Montant" /></Field>
          <Field label={mode === 'corriger' ? 'Valable depuis' : 'Nouvelle version à partir du'}><input type="date" value={v.from} onChange={(e) => form.set({ from: e.target.value })} /></Field>
        </div>
        <FrequencyFields v={v} set={(p) => form.set(p as Partial<typeof v>)} />
        {error && <Notice kind="error">{error}</Notice>}
        <div className="actions"><button type="submit" className="primary">Enregistrer</button><button type="button" onClick={requestClose}>Annuler</button></div>
      </form>
    </Modal>
  );
}

function StopForm({ r, onClose, requestClose }: { r: Recurrence; onClose: () => void; requestClose: () => void }) {
  const { driver, snap, reload, today } = useData();
  const [error, setError] = useState<string | null>(null);
  const form = useProtectedForm(`arret:${r.id}`, `Arrêt de « ${r.label} »`, { end_date: r.end_date ?? today }, async (v) => {
    try { await eng.stopRecurrence(driver, snap, r.id, v.end_date || null); await reload(); return true; } catch (e) { setError(errorText(e)); return false; }
  });
  return (
    <Modal title={`Arrêter « ${r.label} »`} onClose={requestClose}>
      <Notice>{eng.RECURRENCE_ACTIONS.arreter}</Notice>
      <form onSubmit={async (e) => { e.preventDefault(); if (await form.save()) onClose(); }}>
        <Field label="Dernière date possible" hint="Vide = relancer sans fin"><input type="date" value={form.values.end_date} onChange={(e) => form.set({ end_date: e.target.value })} /></Field>
        {error && <Notice kind="error">{error}</Notice>}
        <div className="actions"><button type="submit" className="primary">Enregistrer</button><button type="button" onClick={requestClose}>Annuler</button></div>
      </form>
    </Modal>
  );
}

function ScheduledForm({ onClose, requestClose }: { onClose: () => void; requestClose: () => void }) {
  const { driver, snap, reload, today } = useData();
  const [error, setError] = useState<string | null>(null);
  const form = useProtectedForm('echeance:nouvelle', 'Nouvelle échéance', { label: '', due_date: today, magnitude: null as number | null, currency: 'EUR' as Currency, rubrique_id: null as number | null, planned_account_id: null as number | null }, async (v) => {
    setError(null);
    if (!v.rubrique_id || v.magnitude === null) { setError('Rubrique et montant : à renseigner'); return false; }
    const fam = snap.families.find((f) => f.id === snap.rubriques.find((r) => r.id === v.rubrique_id)!.family_id)!;
    const amount = fam.direction === 'revenu' ? Math.abs(v.magnitude) : -Math.abs(v.magnitude);
    try {
      await eng.createScheduled(driver, snap, { label: v.label, due_date: v.due_date, amount_minor: amount, currency: v.currency, rubrique_id: v.rubrique_id, nature: defaultNature(snap, v.rubrique_id, amount), planned_account_id: v.planned_account_id });
      await reload();
      return true;
    } catch (e) { setError(errorText(e)); return false; }
  });
  const v = form.values;
  return (
    <Modal title="Nouvelle échéance ponctuelle" onClose={requestClose}>
      <p className="sub">Une facture attendue, un paiement prévu : elle est incluse dans le budget de sa rubrique et soldée par le paiement que vous lui rapprochez.</p>
      <DraftBanner offer={form.draftOffer} onRestore={form.restoreDraft} onIgnore={form.ignoreDraft} />
      <form onSubmit={async (e) => { e.preventDefault(); if (await form.save()) onClose(); }}>
        <div className="grid2">
          <Field label="Libellé"><input value={v.label} onChange={(e) => form.set({ label: e.target.value })} /></Field>
          <Field label="Date"><input type="date" value={v.due_date} onChange={(e) => form.set({ due_date: e.target.value })} /></Field>
          <Field label="Montant"><MoneyInput value={v.magnitude} onChange={(x) => form.set({ magnitude: x })} currency={v.currency} ariaLabel="Montant de l’échéance" /></Field>
          <Field label="Devise"><select value={v.currency} onChange={(e) => form.set({ currency: e.target.value as Currency })}><option>EUR</option><option>CHF</option></select></Field>
          <Field label="Rubrique"><RubriqueSelect snap={snap} value={v.rubrique_id} onChange={(x) => form.set({ rubrique_id: x })} /></Field>
          <Field label="Compte prévu"><AccountSelect snap={snap} value={v.planned_account_id} onChange={(x) => form.set({ planned_account_id: x })} allowAll="Compte par défaut" /></Field>
        </div>
        {error && <Notice kind="error">{error}</Notice>}
        <div className="actions"><button type="submit" className="primary">Enregistrer</button><button type="button" onClick={requestClose}>Annuler</button></div>
      </form>
    </Modal>
  );
}
