import { useState } from 'react';
import { formatDateFr } from '../../domain/dates';
import { formatMoney } from '../../domain/money';
import type { Currency, Fund, LoanFrequency } from '../../domain/types';
import { fundState, situation } from '../../engine/funds';
import * as eng from '../../services/engagements';
import * as funds from '../../services/funds';
import { Amount, Field, FigureValue, Modal, MoneyInput, Notice, errorText } from '../components/core';
import { DraftBanner, useGuard, useProtectedForm } from '../components/guard';
import { AccountSelect, RubriqueSelect } from '../components/pickers';
import { useData } from '../data';
import { defaultNature } from '../labels';

export function FundsScreen() {
  const { snap, ctx } = useData();
  const guard = useGuard();
  const [edit, setEdit] = useState<{ fund: Fund | null; kind: 'reserve' | 'projet' } | null>(null);
  const [alloc, setAlloc] = useState<Fund | null>(null);
  const [payment, setPayment] = useState<Fund | null>(null);
  const s = situation(ctx);
  const reserve = snap.funds.find((f) => f.kind === 'reserve');
  const projects = snap.funds.filter((f) => f.kind === 'projet');
  const card = (f: Fund) => {
    const st = fundState(ctx, f);
    const planned = snap.scheduled.filter((x) => x.fund_id === f.id && x.status === 'prevue');
    return (
      <article key={f.id} className="account-card" aria-label={`${f.kind === 'reserve' ? 'Réserve' : 'Projet'} ${f.name}`}>
        <div className="row-between">
          <div className="account-name">{f.name}</div>
          {f.status !== 'actif' && <span className="tag n">{f.status === 'termine' ? 'terminé' : 'archivé'}</span>}
        </div>
        <div className="account-balance"><Amount value={st.reserved} currency={f.currency} /></div>
        <div className="sub">
          {f.kind === 'reserve' ? 'Montant affecté' : 'Réservé'}{f.target_minor ? ` sur un objectif de ${formatMoney(f.target_minor, f.currency, { decimals: false })} (${Math.round((st.progress_e4 ?? 0) / 100)} %)` : ''}
          {f.target_date ? ` · échéance ${formatDateFr(f.target_date)}` : ''}
        </div>
        {f.target_minor ? <div className="bar"><i style={{ width: `${Math.min(100, Math.max(0, (st.progress_e4 ?? 0) / 100))}%` }} /></div> : null}
        {st.consumed > 0 && <div className="sub">Déjà payé sur ce fonds : {formatMoney(st.consumed, f.currency)}</div>}
        {planned.length > 0 && <div className="sub">Paiements prévus : {planned.map((p) => `${formatDateFr(p.due_date)} ${formatMoney(-p.amount_minor, p.currency)}`).join(', ')}</div>}
        {snap.fundPlans.filter((p) => p.fund_id === f.id).map((p) => <div key={p.id} className="sub">Versements prévus : {formatMoney(p.amount_minor, f.currency)} ({p.frequency}) depuis le {formatDateFr(p.start_date)}</div>)}
        <div className="actions small">
          <button onClick={() => setAlloc(f)}>Affecter / libérer</button>
          {f.kind === 'projet' && <button onClick={() => setPayment(f)}>Paiement prévu</button>}
          <button onClick={() => setEdit({ fund: f, kind: f.kind })}>Modifier</button>
        </div>
      </article>
    );
  };
  return (
    <div>
      <div className="screen-head">
        <h1>Réserve, fonds et projets</h1>
        <div className="actions">
          {!reserve && <button onClick={() => setEdit({ fund: null, kind: 'reserve' })}>Définir la réserve de sécurité</button>}
          <button className="primary" onClick={() => setEdit({ fund: null, kind: 'projet' })}>Nouveau projet</button>
        </div>
      </div>
      <div className="kpis">
        <div className="kpi"><div className="l">Liquidités totales</div><div className="v"><FigureValue f={s.liquidites} decimals={false} /></div></div>
        <div className="kpi"><div className="l">Réservé (réserve + fonds)</div><div className="v"><FigureValue f={s.reserve} decimals={false} /></div></div>
        <div className="kpi"><div className="l">Non affecté</div><div className="v"><FigureValue f={s.nonAffecte} decimals={false} /></div><div className="d">= liquidités − réservé</div></div>
      </div>
      <p className="sub">Un paiement de projet (rattaché depuis la fiche de l’opération) consomme la réservation : il diminue les liquidités et le réservé du même montant, sans être compté deux fois.</p>
      <div className="cards">{[...(reserve ? [reserve] : []), ...projects].map(card)}</div>
      {edit && <FundForm fund={edit.fund} kind={edit.kind} onClose={() => setEdit(null)} requestClose={() => guard.attempt(() => setEdit(null))} />}
      {alloc && <AllocForm fund={alloc} onClose={() => setAlloc(null)} requestClose={() => guard.attempt(() => setAlloc(null))} />}
      {payment && <PaymentForm fund={payment} onClose={() => setPayment(null)} requestClose={() => guard.attempt(() => setPayment(null))} />}
    </div>
  );
}

function FundForm({ fund, kind, onClose, requestClose }: { fund: Fund | null; kind: 'reserve' | 'projet'; onClose: () => void; requestClose: () => void }) {
  const { driver, snap, reload, today } = useData();
  const [error, setError] = useState<string | null>(null);
  const plan = fund ? snap.fundPlans.find((p) => p.fund_id === fund.id) : undefined;
  const form = useProtectedForm(`fonds:${fund?.id ?? kind}`, kind === 'reserve' ? 'Réserve de sécurité' : 'Projet', {
    name: fund?.name ?? (kind === 'reserve' ? 'Réserve de sécurité' : ''), target: fund?.target_minor ?? null as number | null, currency: (fund?.currency ?? 'EUR') as Currency, target_date: fund?.target_date ?? '',
    plan: plan?.amount_minor ?? null as number | null, plan_freq: (plan?.frequency ?? 'mensuelle') as LoanFrequency, plan_start: plan?.start_date ?? today,
  }, async (v) => {
    setError(null);
    try {
      const id = await funds.saveFund(driver, snap, { kind, name: v.name, target_minor: v.target, currency: v.currency, target_date: v.target_date || null }, fund?.id ?? null);
      if ((v.plan ?? null) !== (plan?.amount_minor ?? null) || v.plan_freq !== plan?.frequency || v.plan_start !== plan?.start_date) {
        const fresh = await (await import('../../storage/snapshot')).loadSnapshot(driver);
        await funds.setFundPlan(driver, fresh, { fund_id: id, amount_minor: v.plan, frequency: v.plan_freq, start_date: v.plan_start });
      }
      await reload();
      return true;
    } catch (e) { setError(errorText(e)); return false; }
  });
  const v = form.values;
  return (
    <Modal title={fund ? `Modifier « ${fund.name} »` : kind === 'reserve' ? 'Réserve de sécurité' : 'Nouveau projet'} onClose={requestClose}>
      <DraftBanner offer={form.draftOffer} onRestore={form.restoreDraft} onIgnore={form.ignoreDraft} />
      <form onSubmit={async (e) => { e.preventDefault(); if (await form.save()) onClose(); }}>
        <div className="grid2">
          <Field label="Nom"><input value={v.name} onChange={(e) => form.set({ name: e.target.value })} /></Field>
          <Field label={kind === 'reserve' ? 'Montant cible' : 'Objectif'}><MoneyInput value={v.target} onChange={(x) => form.set({ target: x === null ? null : Math.abs(x) })} currency={v.currency} allowEmpty ariaLabel="Objectif" /></Field>
          <Field label="Devise"><select value={v.currency} onChange={(e) => form.set({ currency: e.target.value as Currency })}><option>EUR</option><option>CHF</option></select></Field>
          {kind === 'projet' && <Field label="Échéance"><input type="date" value={v.target_date} onChange={(e) => form.set({ target_date: e.target.value })} /></Field>}
        </div>
        <h3>Versements prévus (réservations futures)</h3>
        <div className="grid3">
          <Field label="Montant"><MoneyInput value={v.plan} onChange={(x) => form.set({ plan: x === null ? null : Math.abs(x) })} currency={v.currency} allowEmpty ariaLabel="Versement prévu" /></Field>
          <Field label="Fréquence"><select value={v.plan_freq} onChange={(e) => form.set({ plan_freq: e.target.value as LoanFrequency })}><option value="mensuelle">Mensuelle</option><option value="trimestrielle">Trimestrielle</option><option value="annuelle">Annuelle</option></select></Field>
          <Field label="À partir du"><input type="date" value={v.plan_start} onChange={(e) => form.set({ plan_start: e.target.value })} /></Field>
        </div>
        {error && <Notice kind="error">{error}</Notice>}
        <div className="actions"><button type="submit" className="primary">Enregistrer</button><button type="button" onClick={requestClose}>Annuler</button></div>
      </form>
    </Modal>
  );
}

function AllocForm({ fund, onClose, requestClose }: { fund: Fund; onClose: () => void; requestClose: () => void }) {
  const { driver, snap, reload, today } = useData();
  const [error, setError] = useState<string | null>(null);
  const form = useProtectedForm(`affectation:${fund.id}`, `Affectation « ${fund.name} »`, { amount: null as number | null, date: today, note: '' }, async (v) => {
    if (v.amount === null) { setError('Montant : positif pour affecter, négatif pour libérer'); return false; }
    try { await funds.allocate(driver, snap, { fund_id: fund.id, date: v.date, amount_minor: v.amount, note: v.note }, today); await reload(); return true; } catch (e) { setError(errorText(e)); return false; }
  });
  return (
    <Modal title={`Affecter ou libérer — ${fund.name}`} onClose={requestClose}>
      <p className="sub">L’argent reste sur vos comptes : affecter le réserve pour ce fonds, libérer le rend disponible (non affecté).</p>
      <form onSubmit={async (e) => { e.preventDefault(); if (await form.save()) onClose(); }}>
        <div className="grid2">
          <Field label="Montant (négatif = libérer)"><MoneyInput value={form.values.amount} onChange={(x) => form.set({ amount: x })} currency={fund.currency} ariaLabel="Montant à affecter" /></Field>
          <Field label="Date"><input type="date" value={form.values.date} onChange={(e) => form.set({ date: e.target.value })} /></Field>
        </div>
        <Field label="Note"><input value={form.values.note} onChange={(e) => form.set({ note: e.target.value })} /></Field>
        {error && <Notice kind="error">{error}</Notice>}
        <div className="actions"><button type="submit" className="primary">Enregistrer</button><button type="button" onClick={requestClose}>Annuler</button></div>
      </form>
    </Modal>
  );
}

function PaymentForm({ fund, onClose, requestClose }: { fund: Fund; onClose: () => void; requestClose: () => void }) {
  const { driver, snap, reload, today } = useData();
  const [error, setError] = useState<string | null>(null);
  const form = useProtectedForm(`paiement-prevu:${fund.id}`, `Paiement prévu « ${fund.name} »`, { label: fund.name, amount: null as number | null, date: fund.target_date ?? today, rubrique_id: null as number | null, account: null as number | null }, async (v) => {
    if (v.amount === null || !v.rubrique_id) { setError('Montant et rubrique : à renseigner'); return false; }
    try {
      await eng.createScheduled(driver, snap, { label: v.label, due_date: v.date, amount_minor: -Math.abs(v.amount), currency: fund.currency, nature: defaultNature(snap, v.rubrique_id, -1), rubrique_id: v.rubrique_id, planned_account_id: v.account, fund_id: fund.id });
      await reload();
      return true;
    } catch (e) { setError(errorText(e)); return false; }
  });
  const v = form.values;
  return (
    <Modal title={`Paiement prévu — ${fund.name}`} onClose={requestClose}>
      <p className="sub">Apparaît dans la prévision de trésorerie à sa date ; une fois payé, rattachez l’opération au projet pour consommer la réservation.</p>
      <form onSubmit={async (e) => { e.preventDefault(); if (await form.save()) onClose(); }}>
        <div className="grid2">
          <Field label="Libellé"><input value={v.label} onChange={(e) => form.set({ label: e.target.value })} /></Field>
          <Field label="Date"><input type="date" value={v.date} onChange={(e) => form.set({ date: e.target.value })} /></Field>
          <Field label="Montant"><MoneyInput value={v.amount} onChange={(x) => form.set({ amount: x })} currency={fund.currency} ariaLabel="Montant du paiement prévu" /></Field>
          <Field label="Rubrique de la dépense"><RubriqueSelect snap={snap} value={v.rubrique_id} onChange={(x) => form.set({ rubrique_id: x })} /></Field>
          <Field label="Compte prévu"><AccountSelect snap={snap} value={v.account} onChange={(x) => form.set({ account: x })} currency={fund.currency} allowAll="Compte par défaut" /></Field>
        </div>
        {error && <Notice kind="error">{error}</Notice>}
        <div className="actions"><button type="submit" className="primary">Enregistrer</button><button type="button" onClick={requestClose}>Annuler</button></div>
      </form>
    </Modal>
  );
}
