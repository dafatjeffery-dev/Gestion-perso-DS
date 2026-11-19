import { useMemo, useState } from 'react';
import { formatDateFr } from '../../domain/dates';
import { formatMoney } from '../../domain/money';
import type { Currency, Loan, LoanFrequency } from '../../domain/types';
import { THEORETICAL_LIMITS, amortize, crdAt, installmentsOf, type VirtualInstallment } from '../../engine/loans';
import { expectedBetween } from '../../engine/occurrences';
import * as loans from '../../services/loans';
import { ValidationError } from '../../services/plan';
import { Amount, Field, Modal, MoneyInput, Notice, errorText } from '../components/core';
import { DraftBanner, useGuard, useProtectedForm } from '../components/guard';
import { AccountSelect } from '../components/pickers';
import { useData } from '../data';

const FREQ: Record<LoanFrequency, string> = { mensuelle: 'Mensuelle', trimestrielle: 'Trimestrielle', semestrielle: 'Semestrielle', annuelle: 'Annuelle' };
const pctToE6 = (s: string): number | null => {
  const t = s.trim().replace(',', '.');
  if (t === '') return null;
  if (!/^\d+(\.\d{1,4})?$/.test(t)) return NaN;
  return Math.round(Number(t) * 10_000);
};
const e6ToPct = (v: number | null) => (v === null ? '' : (v / 10_000).toString().replace('.', ','));

export function LoansScreen() {
  const { snap, ctx, today } = useData();
  const guard = useGuard();
  const [edit, setEdit] = useState<Loan | 'new' | null>(null);
  const [view, setView] = useState<Loan | null>(null);
  const active = snap.loans.filter((l) => l.status === 'actif');
  const archived = snap.loans.filter((l) => l.status !== 'actif');
  const card = (l: Loan) => {
    const crd = crdAt(ctx, l, today);
    const next = expectedBetween(ctx, today, '2100-12-31').find((e) => e.loan_id === l.id);
    return (
      <article key={l.id} className="account-card" aria-label={`Crédit ${l.label}`}>
        <div className="row-between">
          <div>
            <div className="account-name">{l.label}</div>
            <div className="sub">{l.lender ? `${l.lender} · ` : ''}{loans.describeLoan(l)}{l.status !== 'actif' ? ` · ${l.status === 'solde' ? 'soldé' : 'archivé'}` : ''}</div>
          </div>
          <span className="tag n">{l.currency}</span>
        </div>
        <div className="account-balance"><Amount value={crd.minor} currency={l.currency} reason={crd.source} /></div>
        <div className="sub">Capital restant dû au {formatDateFr(today)} — {crd.source}</div>
        {next && <div className="sub">Prochaine échéance : {formatDateFr(next.due_date)}, {formatMoney(-next.amount_minor, next.currency)}</div>}
        <div className="actions small">
          <button onClick={() => setView(l)}>Tableau d’amortissement</button>
          <button onClick={() => setEdit(l)}>Modifier la fiche</button>
        </div>
      </article>
    );
  };
  return (
    <div>
      <div className="screen-head">
        <h1>Crédits</h1>
        <button className="primary" onClick={() => setEdit('new')}>Nouveau crédit</button>
      </div>
      <p className="sub">Intérêts, assurance et frais sont des dépenses (famille Crédits). Le capital remboursé est une sortie de trésorerie, pas une consommation. Le capital restant dû entre dans le patrimoine net.</p>
      <div className="cards">{active.map(card)}</div>
      {archived.length > 0 && (
        <section className="card">
          <h2>Crédits archivés ou soldés</h2>
          <div className="cards">{archived.map(card)}</div>
        </section>
      )}
      {edit && <LoanForm loan={edit === 'new' ? null : edit} onClose={() => setEdit(null)} requestClose={() => guard.attempt(() => setEdit(null))} />}
      {view && <ScheduleView loan={view} onClose={() => setView(null)} />}
    </div>
  );
}

function ScheduleView({ loan, onClose }: { loan: Loan; onClose: () => void }) {
  const { ctx, driver, snap, reload, today } = useData();
  const [error, setError] = useState<string | null>(null);
  const rows = installmentsOf(ctx, loan);
  const states = useMemo(() => new Map(expectedBetween(ctx, '1900-01-01', '2200-12-31').filter((e) => e.loan_id === loan.id).map((e) => [e.seq, e])), [ctx, loan.id]);
  return (
    <Modal title={`Tableau d’amortissement — ${loan.label}`} onClose={onClose} wide>
      {loan.mode !== 'bancaire' && <Notice>{loan.mode === 'theorique' ? THEORETICAL_LIMITS : 'Mode simplifié : échéances estimées à partir de la mensualité et du capital restant dû renseignés.'}</Notice>}
      <div className="actions">
        {loan.status === 'actif' ? (
          <>
            <button onClick={async () => { try { await loans.archiveLoan(driver, snap, loan.id); await reload(); onClose(); } catch (e) { setError(errorText(e)); } }}>Archiver</button>
            <button onClick={async () => { try { await loans.archiveLoan(driver, snap, loan.id, 'solde'); await reload(); onClose(); } catch (e) { setError(errorText(e)); } }}>Marquer soldé</button>
          </>
        ) : (
          <button className="primary" onClick={async () => { try { await loans.reactivateLoan(driver, snap, loan.id); await reload(); onClose(); } catch (e) { setError(errorText(e)); } }}>Réactiver</button>
        )}
        <span className="sub">{loan.status === 'actif' ? 'Archiver retire les échéances futures des prévisions ; rien n’est supprimé.' : 'Réactiver remet les échéances dans les prévisions, sans recréer aucun paiement passé.'}</span>
      </div>
      {error && <Notice kind="error">{error}</Notice>}
      <table className="table">
        <thead><tr><th>N°</th><th>Date</th><th className="num">Capital</th><th className="num">Intérêts</th><th className="num">Assurance</th><th className="num">Frais</th><th className="num">Total</th><th className="num">Restant dû</th><th>État</th></tr></thead>
        <tbody>
          {rows.map((r: VirtualInstallment) => {
            const st = states.get(r.seq);
            return (
              <tr key={r.seq} className={r.due_date <= today ? 'past' : ''}>
                <td>{r.seq}</td>
                <td>{formatDateFr(r.due_date)}</td>
                <td className="num">{r.unventilated ? <span className="sub">non ventilée</span> : formatMoney(r.principal_minor, loan.currency)}</td>
                <td className="num">{r.unventilated ? '' : formatMoney(r.interest_minor, loan.currency)}</td>
                <td className="num">{formatMoney(r.insurance_minor, loan.currency)}</td>
                <td className="num">{formatMoney(r.fees_minor, loan.currency)}</td>
                <td className="num">{formatMoney(r.total_minor, loan.currency)}</td>
                <td className="num">{formatMoney(r.crd_after_minor, loan.currency)}</td>
                <td>{st ? (st.status === 'soldee' ? 'payée' : st.status === 'en_retard' ? 'non rapprochée' : st.status === 'incluse' ? 'réputée payée' : st.status === 'partielle' ? 'partielle' : '') : ''}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Modal>
  );
}

interface LoanValues {
  label: string;
  lender: string;
  currency: Currency;
  mode: Loan['mode'];
  frequency: LoanFrequency;
  first_due_date: string;
  principal: number | null;
  rate: string;
  periods: number | null;
  insurance_mode: Loan['insurance_mode'];
  insurance_amount: number | null;
  insurance_rate: string;
  fees: number | null;
  fees_initial: number | null;
  simple_installment: number | null;
  simple_crd: number | null;
  simple_crd_date: string;
  schedule_text: string;
  payment_account_id: number | null;
  recurrence_id: number | null;
}

function LoanForm({ loan, onClose, requestClose }: { loan: Loan | null; onClose: () => void; requestClose: () => void }) {
  const { driver, snap, reload, today } = useData();
  const [errors, setErrors] = useState<string[]>([]);
  const initial: LoanValues = loan
    ? {
        label: loan.label, lender: loan.lender, currency: loan.currency, mode: loan.mode, frequency: loan.frequency, first_due_date: loan.first_due_date,
        principal: loan.principal_minor, rate: e6ToPct(loan.annual_rate_e6), periods: loan.periods, insurance_mode: loan.insurance_mode,
        insurance_amount: loan.insurance_mode === 'montant_fixe' ? loan.insurance_value : null, insurance_rate: loan.insurance_mode.startsWith('pct') ? e6ToPct(loan.insurance_value) : '',
        fees: loan.fees_per_installment_minor || null, fees_initial: loan.fees_initial_minor || null, simple_installment: loan.simple_installment_minor, simple_crd: loan.simple_crd_minor, simple_crd_date: loan.simple_crd_date ?? today,
        schedule_text: loan.mode === 'bancaire' ? snap.installments.filter((i) => i.loan_id === loan.id).map((i) => [i.due_date, i.principal_minor, i.interest_minor, i.insurance_minor, i.fees_minor, i.crd_after_minor].map((x, k) => (k === 0 ? x : (Number(x) / 100).toFixed(2).replace('.', ','))).join(';')).join('\n') : '',
        payment_account_id: loan.payment_account_id, recurrence_id: loan.recurrence_id,
      }
    : { label: '', lender: '', currency: 'EUR', mode: 'theorique', frequency: 'mensuelle', first_due_date: today, principal: null, rate: '', periods: 240, insurance_mode: 'aucune', insurance_amount: null, insurance_rate: '', fees: null, fees_initial: null, simple_installment: null, simple_crd: null, simple_crd_date: today, schedule_text: '', payment_account_id: null, recurrence_id: null };

  const toInput = (v: LoanValues): loans.LoanInput | string[] => {
    const errs: string[] = [];
    const rate = pctToE6(v.rate);
    if (Number.isNaN(rate)) errs.push('Taux : nombre en %, ex. 1,85');
    const insRate = pctToE6(v.insurance_rate);
    let bank: loans.ParsedSchedule | null = null;
    if (v.mode === 'bancaire') {
      bank = loans.parseBankSchedule(v.schedule_text);
      errs.push(...bank.errors);
    }
    if (errs.length) return errs;
    return {
      label: v.label, lender: v.lender, currency: v.currency, mode: v.mode, frequency: v.frequency, first_due_date: bank?.rows[0]?.due_date ?? v.first_due_date,
      principal_minor: v.principal, annual_rate_e6: rate, periods: v.periods,
      insurance_mode: v.insurance_mode, insurance_value: v.insurance_mode === 'montant_fixe' ? v.insurance_amount : v.insurance_mode === 'aucune' ? null : insRate,
      fees_per_installment_minor: v.fees ?? 0, fees_initial_minor: v.fees_initial ?? 0,
      simple_installment_minor: v.simple_installment, simple_crd_minor: v.simple_crd, simple_crd_date: v.simple_crd_date,
      payment_account_id: v.payment_account_id, recurrence_id: v.recurrence_id, bankSchedule: bank?.rows,
    };
  };

  const form = useProtectedForm<LoanValues>(`credit:${loan?.id ?? 'nouveau'}`, loan ? `Crédit « ${loan.label} »` : 'Nouveau crédit', initial, async (v) => {
    setErrors([]);
    const input = toInput(v);
    if (Array.isArray(input)) { setErrors(input); return false; }
    try {
      await loans.saveLoan(driver, snap, input, loan?.id ?? null);
      await reload();
      return true;
    } catch (e) {
      setErrors(e instanceof ValidationError ? e.errors.map((x) => x.message) : [errorText(e)]);
      return false;
    }
  });
  const v = form.values;
  const preview = useMemo(() => {
    if (v.mode !== 'theorique') return null;
    const rate = pctToE6(v.rate);
    if (!v.principal || rate === null || Number.isNaN(rate) || !v.periods) return null;
    const rows = amortize(0, { principal_minor: v.principal, annual_rate_e6: rate, periods: v.periods, frequency: v.frequency, first_due_date: v.first_due_date, insurance_mode: v.insurance_mode, insurance_value: v.insurance_mode === 'montant_fixe' ? v.insurance_amount : pctToE6(v.insurance_rate), fees_per_installment_minor: v.fees ?? 0 });
    const first = rows.find((r) => r.seq === 1);
    return first ? { first, interest: rows.reduce((s, r) => s + r.interest_minor, 0) } : null;
  }, [v]);
  const recs = snap.recurrences.filter((r) => !snap.loans.some((l) => l.recurrence_id === r.id && l.id !== loan?.id));
  return (
    <Modal title={loan ? `Fiche — ${loan.label}` : 'Nouveau crédit'} onClose={requestClose} wide>
      <DraftBanner offer={form.draftOffer} onRestore={form.restoreDraft} onIgnore={form.ignoreDraft} />
      <form onSubmit={async (e) => { e.preventDefault(); if (await form.save()) onClose(); }}>
        <div className="grid3">
          <Field label="Nom"><input value={v.label} onChange={(e) => form.set({ label: e.target.value })} /></Field>
          <Field label="Prêteur"><input value={v.lender} onChange={(e) => form.set({ lender: e.target.value })} /></Field>
          <Field label="Devise"><select value={v.currency} onChange={(e) => form.set({ currency: e.target.value as Currency })}><option>EUR</option><option>CHF</option></select></Field>
        </div>
        <div className="tabs" role="tablist" aria-label="Mode de saisie">
          {([['simplifie', 'Simplifié'], ['bancaire', 'Échéancier de la banque'], ['theorique', 'Calcul théorique']] as const).map(([k, l]) => (
            <button type="button" key={k} role="tab" aria-selected={v.mode === k} className={v.mode === k ? 'tab on' : 'tab'} onClick={() => form.set({ mode: k })}>{l}</button>
          ))}
        </div>
        {v.mode === 'simplifie' && (
          <>
            <p className="sub">Mensualité et capital restant dû connus. Avec le taux, la part d’intérêts est estimée ; sans taux, les échéances restent « non ventilées » et le capital restant dû ne baisse qu’avec vos mises à jour.</p>
            <div className="grid3">
              <Field label="Mensualité hors assurance"><MoneyInput value={v.simple_installment} onChange={(x) => form.set({ simple_installment: x === null ? null : Math.abs(x) })} currency={v.currency} ariaLabel="Mensualité" /></Field>
              <Field label="Capital restant dû"><MoneyInput value={v.simple_crd} onChange={(x) => form.set({ simple_crd: x === null ? null : Math.abs(x) })} currency={v.currency} ariaLabel="Capital restant dû" /></Field>
              <Field label="au"><input type="date" value={v.simple_crd_date} onChange={(e) => form.set({ simple_crd_date: e.target.value })} /></Field>
              <Field label="Taux nominal annuel (%) — facultatif"><input value={v.rate} onChange={(e) => form.set({ rate: e.target.value })} placeholder="1,85" /></Field>
              <Field label="Date d’une échéance (jour de prélèvement)"><input type="date" value={v.first_due_date} onChange={(e) => form.set({ first_due_date: e.target.value })} /></Field>
              <Field label="Fréquence"><select value={v.frequency} onChange={(e) => form.set({ frequency: e.target.value as LoanFrequency })}>{Object.entries(FREQ).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
            </div>
          </>
        )}
        {v.mode === 'bancaire' && (
          <>
            <p className="sub">Collez l’échéancier (une ligne par échéance) : date ; capital ; intérêts ; assurance ; frais ; capital restant dû. Les valeurs sont conservées telles quelles.</p>
            <textarea aria-label="Échéancier de la banque" rows={8} value={v.schedule_text} onChange={(e) => form.set({ schedule_text: e.target.value })} style={{ width: '100%', fontFamily: 'ui-monospace, monospace', fontSize: 12 }} />
          </>
        )}
        {v.mode === 'theorique' && (
          <>
            <Notice>{THEORETICAL_LIMITS}</Notice>
            <div className="grid3">
              <Field label="Capital emprunté"><MoneyInput value={v.principal} onChange={(x) => form.set({ principal: x === null ? null : Math.abs(x) })} currency={v.currency} ariaLabel="Capital emprunté" /></Field>
              <Field label="Taux nominal annuel (%)"><input aria-label="Taux nominal" value={v.rate} onChange={(e) => form.set({ rate: e.target.value })} placeholder="1,85" /></Field>
              <Field label="Nombre d’échéances"><input type="number" min={1} value={v.periods ?? ''} onChange={(e) => form.set({ periods: e.target.value ? Number(e.target.value) : null })} /></Field>
              <Field label="Première échéance"><input type="date" value={v.first_due_date} onChange={(e) => form.set({ first_due_date: e.target.value })} /></Field>
              <Field label="Fréquence"><select value={v.frequency} onChange={(e) => form.set({ frequency: e.target.value as LoanFrequency })}>{Object.entries(FREQ).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
              <Field label="Frais de dossier"><MoneyInput value={v.fees_initial} onChange={(x) => form.set({ fees_initial: x === null ? null : Math.abs(x) })} currency={v.currency} allowEmpty ariaLabel="Frais de dossier" /></Field>
            </div>
          </>
        )}
        {v.mode !== 'bancaire' && (
          <div className="grid3">
            <Field label="Assurance">
              <select value={v.insurance_mode} onChange={(e) => form.set({ insurance_mode: e.target.value as Loan['insurance_mode'] })}>
                <option value="aucune">Aucune</option>
                <option value="montant_fixe">Montant fixe par échéance</option>
                <option value="pct_capital_initial">% du capital initial par an</option>
                <option value="pct_crd">% du capital restant dû par an</option>
              </select>
            </Field>
            {v.insurance_mode === 'montant_fixe' && <Field label="Montant par échéance"><MoneyInput value={v.insurance_amount} onChange={(x) => form.set({ insurance_amount: x === null ? null : Math.abs(x) })} currency={v.currency} ariaLabel="Assurance" /></Field>}
            {v.insurance_mode.startsWith('pct') && <Field label="Taux d’assurance annuel (%)"><input value={v.insurance_rate} onChange={(e) => form.set({ insurance_rate: e.target.value })} placeholder="0,30" /></Field>}
            <Field label="Frais par échéance"><MoneyInput value={v.fees} onChange={(x) => form.set({ fees: x === null ? null : Math.abs(x) })} currency={v.currency} allowEmpty ariaLabel="Frais par échéance" /></Field>
          </div>
        )}
        {preview && (
          <p className="sub">Première échéance : {formatMoney(preview.first.total_minor, v.currency)} dont {formatMoney(preview.first.interest_minor, v.currency)} d’intérêts. Coût total des intérêts : {formatMoney(preview.interest, v.currency)}.</p>
        )}
        <h3>Associations (enregistrées avec la fiche)</h3>
        <div className="grid2">
          <Field label="Compte de prélèvement"><AccountSelect snap={snap} value={v.payment_account_id} onChange={(x) => form.set({ payment_account_id: x })} currency={v.currency} allowAll="Compte par défaut" ariaLabel="Compte de prélèvement" /></Field>
          <Field label="Récurrence déjà saisie pour ce crédit" hint="Ses occurrences seront remplacées par les échéances du crédit, jamais additionnées.">
            <select value={v.recurrence_id ?? ''} onChange={(e) => form.set({ recurrence_id: e.target.value ? Number(e.target.value) : null })}>
              <option value="">Aucune</option>
              {recs.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
            </select>
          </Field>
        </div>
        {errors.map((m) => <Notice key={m} kind="error">{m}</Notice>)}
        <div className="actions"><button type="submit" className="primary">Enregistrer la fiche</button><button type="button" onClick={requestClose}>Annuler</button></div>
      </form>
    </Modal>
  );
}
