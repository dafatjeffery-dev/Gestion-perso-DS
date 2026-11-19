import { useMemo, useState } from 'react';
import { addMonths, formatDateFr, monthOf } from '../../domain/dates';
import { formatMoney } from '../../domain/money';
import type { CoverageMode, Movement, NatureCode } from '../../domain/types';
import { suggestTargets } from '../../engine/reconcile';
import * as eng from '../../services/engagements';
import * as mv from '../../services/movements';
import { ValidationError } from '../../services/plan';
import { createTransfer } from '../../services/transfers';
import { Amount, DateFr, Field, Modal, MoneyInput, Notice, errorText } from '../components/core';
import { DraftBanner, useGuard, useProtectedForm } from '../components/guard';
import { AccountSelect, RubriqueSelect } from '../components/pickers';
import { useData } from '../data';
import { defaultNature, natureLabel, naturesFor, rubriqueLabel } from '../labels';
import { useNav } from '../nav';
import { BulkBar, useSelection } from './Selection';

export interface OpFilters {
  accountId: number | null;
  from: string;
  to: string;
  rubriqueId: number | null;
  text: string;
  batchId: number | null;
  status: '' | 'a_verifier';
}

export function filterOperations(movements: Movement[], f: OpFilters): Movement[] {
  const t = f.text.trim().toLowerCase();
  return movements
    .filter((m) => m.granularity === 'operation')
    .filter((m) => (f.accountId ? m.account_id === f.accountId : true))
    .filter((m) => m.period_month >= f.from && m.period_month <= f.to)
    .filter((m) => (f.rubriqueId ? m.rubrique_id === f.rubriqueId : true))
    .filter((m) => (f.batchId ? m.import_batch_id === f.batchId : true))
    .filter((m) => (f.status ? m.classification === f.status : true))
    .filter((m) => !t || `${m.label_original ?? ''} ${m.label_simple ?? ''} ${m.comment}`.toLowerCase().includes(t))
    .sort((a, b) => (a.op_date! < b.op_date! ? 1 : a.op_date! > b.op_date! ? -1 : b.id - a.id));
}

export function OperationsScreen() {
  const { snap, today } = useData();
  const nav = useNav();
  const guard = useGuard();
  const [filters, setFilters] = useState<OpFilters>({
    accountId: nav.params.accountId ?? null,
    from: addMonths(monthOf(today), -2),
    to: monthOf(today),
    rubriqueId: null,
    text: '',
    batchId: nav.params.batchId ?? null,
    status: '',
  });
  const [edit, setEdit] = useState<Movement | 'new' | null>(null);
  const [transfer, setTransfer] = useState(false);
  const list = useMemo(() => filterOperations(snap.movements, filters), [snap.movements, filters]);
  const sel = useSelection(list);
  const set = (p: Partial<OpFilters>) => setFilters((f) => ({ ...f, ...p }));
  const acc = (id: number | null) => snap.accounts.find((a) => a.id === id);

  return (
    <div>
      <div className="screen-head">
        <h1>Opérations</h1>
        <div className="actions">
          <button onClick={() => nav.go('imports')}>Importer des opérations</button>
          <button onClick={() => setTransfer(true)}>Nouveau transfert</button>
          <button className="primary" onClick={() => setEdit('new')}>Nouvelle opération</button>
        </div>
      </div>
      <div className="filterbar" role="search">
        <AccountSelect snap={snap} value={filters.accountId} onChange={(v) => set({ accountId: v })} includeArchived allowAll="Tous les comptes" ariaLabel="Filtre compte" />
        <label>
          Du <input type="month" aria-label="Mois de début" value={filters.from} onChange={(e) => e.target.value && set({ from: e.target.value })} />
        </label>
        <label>
          au <input type="month" aria-label="Mois de fin" value={filters.to} onChange={(e) => e.target.value && set({ to: e.target.value })} />
        </label>
        <RubriqueSelect snap={snap} value={filters.rubriqueId} onChange={(v) => set({ rubriqueId: v })} includeTechnical allowAll="Toutes les rubriques" ariaLabel="Filtre rubrique" />
        <select aria-label="Filtre statut" value={filters.status} onChange={(e) => set({ status: e.target.value as OpFilters['status'] })}>
          <option value="">Tous les statuts</option>
          <option value="a_verifier">À vérifier</option>
        </select>
        {filters.batchId && (
          <span className="chip">
            Lot d’import n° {filters.batchId} <button className="icon" aria-label="Retirer le filtre de lot" onClick={() => set({ batchId: null })}>×</button>
          </span>
        )}
        <input type="search" placeholder="Rechercher un libellé" aria-label="Recherche" value={filters.text} onChange={(e) => set({ text: e.target.value })} />
      </div>
      {filters.from > filters.to && <Notice kind="warn">Le mois de début est après le mois de fin : aucune opération ne peut correspondre.</Notice>}
      <BulkBar sel={sel} filteredCount={list.length} />
      <table className="table ops">
        <thead>
          <tr>
            <th><input type="checkbox" aria-label="Tout sélectionner (page filtrée)" checked={sel.allSelected} onChange={() => sel.toggleAll()} /></th>
            <th>Date</th>
            <th>Compte</th>
            <th>Libellé</th>
            <th>Rubrique</th>
            <th className="num">Montant</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {list.map((m) => {
            const a = acc(m.account_id);
            const reconciled = snap.reconciliations.some((r) => r.movement_id === m.id);
            return (
              <tr key={m.id} className={sel.has(m.id) ? 'selected' : ''}>
                <td><input type="checkbox" aria-label={`Sélectionner ${m.label_simple ?? m.label_original ?? m.id}`} checked={sel.has(m.id)} onChange={() => sel.toggle(m.id)} /></td>
                <td><DateFr d={m.op_date} /></td>
                <td>{a?.name}</td>
                <td>
                  <button className="link-btn" onClick={() => setEdit(m)}>{m.label_simple || m.label_original || '(sans libellé)'}</button>
                  {m.label_simple && m.label_original && <div className="sub small">{m.label_original}</div>}
                </td>
                <td>{rubriqueLabel(snap, m.rubrique_id)}</td>
                <td className="num"><Amount value={m.amount_minor} currency={m.currency} /></td>
                <td className="tags">
                  {m.classification === 'a_verifier' && <span className="tag">à vérifier</span>}
                  {m.transfer_id && <span className="tag n">transfert</span>}
                  {reconciled && <span className="tag ok">rapprochée</span>}
                  {m.import_batch_id && <span className="tag n" title={`Lot d’import n° ${m.import_batch_id}`}>import</span>}
                </td>
              </tr>
            );
          })}
          {list.length === 0 && (
            <tr><td colSpan={7} className="sub">Aucune opération pour ces filtres.</td></tr>
          )}
        </tbody>
      </table>
      {edit && <OperationForm op={edit === 'new' ? null : edit} defaultAccount={filters.accountId} onClose={() => setEdit(null)} requestClose={() => guard.attempt(() => setEdit(null))} />}
      {transfer && <TransferForm onClose={() => setTransfer(false)} requestClose={() => guard.attempt(() => setTransfer(false))} />}
    </div>
  );
}

interface OpValues {
  account_id: number | null;
  op_date: string;
  amount_minor: number | null;
  rubrique_id: number | null;
  nature: NatureCode | null;
  label_simple: string;
  comment: string;
  classification: 'a_verifier' | 'confirme';
}

export function CoverageChoice({ err, value, onChange }: { err: mv.CoverageRequired; value: CoverageMode | null; onChange: (m: CoverageMode) => void }) {
  return (
    <div className="notice warn" role="group" aria-label="Choix de couverture">
      <p>{err.message}</p>
      {(Object.keys(mv.COVERAGE_LABEL) as CoverageMode[]).map((k) => (
        <label key={k} className="check">
          <input type="radio" name="coverage" checked={value === k} onChange={() => onChange(k)} /> {mv.COVERAGE_LABEL[k]}
        </label>
      ))}
    </div>
  );
}

function OperationForm({ op, defaultAccount, onClose, requestClose }: { op: Movement | null; defaultAccount: number | null; onClose: () => void; requestClose: () => void }) {
  const { driver, snap, reload, today, ctx } = useData();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [general, setGeneral] = useState<string | null>(null);
  const [coverageErr, setCoverageErr] = useState<mv.CoverageRequired | null>(null);
  const [coverage, setCoverage] = useState<CoverageMode | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<mv.Dependencies | null>(null);
  const initial: OpValues = op
    ? { account_id: op.account_id, op_date: op.op_date!, amount_minor: op.amount_minor, rubrique_id: op.rubrique_id, nature: op.nature, label_simple: op.label_simple ?? '', comment: op.comment, classification: op.classification }
    : { account_id: defaultAccount, op_date: today, amount_minor: null, rubrique_id: null, nature: null, label_simple: '', comment: '', classification: 'confirme' };
  const form = useProtectedForm<OpValues>(`operation:${op?.id ?? 'nouvelle'}`, op ? 'Opération' : 'Nouvelle opération', initial, async (v) => {
    setErrors({});
    setGeneral(null);
    const missing: Record<string, string> = {};
    if (!v.account_id) missing.account_id = 'Compte : à choisir';
    if (v.amount_minor === null) missing.amount_minor = 'Montant : à renseigner (ex. -42,10)';
    if (!v.rubrique_id) missing.rubrique_id = 'Rubrique : à choisir';
    if (Object.keys(missing).length) {
      setErrors(missing);
      return false;
    }
    const nature = v.nature && naturesFor(snap, v.rubrique_id!).includes(v.nature) ? v.nature : defaultNature(snap, v.rubrique_id!, v.amount_minor);
    try {
      if (op) await mv.updateOperation(driver, snap, op.id, { account_id: v.account_id!, op_date: v.op_date, amount_minor: v.amount_minor!, rubrique_id: v.rubrique_id!, nature, label_simple: v.label_simple || null, comment: v.comment, classification: v.classification }, { coverage: coverage ?? undefined });
      else await mv.createOperation(driver, snap, { account_id: v.account_id!, op_date: v.op_date, amount_minor: v.amount_minor!, rubrique_id: v.rubrique_id!, nature, label_simple: v.label_simple || null, comment: v.comment, classification: v.classification }, { coverage: coverage ?? undefined });
      await reload();
      return true;
    } catch (e) {
      if (e instanceof mv.CoverageRequired) setCoverageErr(e);
      else if (e instanceof ValidationError) setErrors(Object.fromEntries(e.errors.map((x) => [x.field, x.message])));
      else setGeneral(errorText(e));
      return false;
    }
  });
  const v = form.values;
  const account = snap.accounts.find((a) => a.id === v.account_id);
  const natures = v.rubrique_id ? naturesFor(snap, v.rubrique_id) : [];
  const recs = op ? snap.reconciliations.filter((r) => r.movement_id === op.id) : [];
  const suggestions = op && !form.dirty ? suggestTargets(ctx, op) : [];
  const refAfter = account && snap.balanceRefs.filter((b) => b.account_id === account.id && b.ref_date >= v.op_date).sort((a, b) => (a.ref_date < b.ref_date ? -1 : 1))[0];

  return (
    <Modal title={op ? 'Opération' : 'Nouvelle opération'} onClose={requestClose} wide>
      <DraftBanner offer={form.draftOffer} onRestore={form.restoreDraft} onIgnore={form.ignoreDraft} />
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (await form.save()) onClose();
        }}
      >
        {op?.label_original && (
          <p className="sub">Libellé bancaire original (jamais réécrit) : <code>{op.label_original}</code></p>
        )}
        <div className="grid3">
          <Field label="Compte" error={errors.account_id}>
            <AccountSelect snap={snap} value={v.account_id} onChange={(x) => form.set({ account_id: x })} />
          </Field>
          <Field label="Date" error={errors.op_date}>
            <input type="date" value={v.op_date} onChange={(e) => form.set({ op_date: e.target.value })} />
          </Field>
          <Field label="Montant (négatif = sortie)" error={errors.amount_minor}>
            <MoneyInput value={v.amount_minor} onChange={(x) => form.set({ amount_minor: x })} currency={account?.currency ?? ''} ariaLabel="Montant" />
          </Field>
        </div>
        <div className="grid2">
          <Field label="Rubrique" error={errors.rubrique_id}>
            <RubriqueSelect snap={snap} value={v.rubrique_id} onChange={(x) => form.set({ rubrique_id: x, nature: x ? defaultNature(snap, x, v.amount_minor) : null })} includeTechnical />
          </Field>
          <Field label="Nature financière" error={errors.nature} hint="Indépendante du sens bancaire">
            <select value={v.nature ?? ''} onChange={(e) => form.set({ nature: e.target.value as NatureCode })} disabled={natures.length <= 1}>
              {natures.map((n) => (
                <option key={n} value={n}>{natureLabel(snap, n)}</option>
              ))}
            </select>
          </Field>
        </div>
        <div className="grid2">
          <Field label="Libellé simplifié">
            <input value={v.label_simple} onChange={(e) => form.set({ label_simple: e.target.value })} />
          </Field>
          <Field label="Commentaire">
            <input value={v.comment} onChange={(e) => form.set({ comment: e.target.value })} />
          </Field>
        </div>
        <label className="check">
          <input type="checkbox" checked={v.classification === 'a_verifier'} onChange={(e) => form.set({ classification: e.target.checked ? 'a_verifier' : 'confirme' })} /> Classement à vérifier
        </label>
        {refAfter && <Notice kind="warn">Opération antérieure ou égale au solde constaté du {formatDateFr(refAfter.ref_date)} : ce solde l’inclut déjà, elle ne le modifie pas.</Notice>}
        {coverageErr && <CoverageChoice err={coverageErr} value={coverage} onChange={setCoverage} />}
        {general && <Notice kind="error">{general}</Notice>}
        {Object.entries(errors).filter(([k]) => !['account_id', 'op_date', 'amount_minor', 'rubrique_id', 'nature'].includes(k)).map(([k, m]) => <Notice key={k} kind="error">{m}</Notice>)}
        <div className="actions">
          <button type="submit" className="primary">Enregistrer</button>
          <button type="button" onClick={requestClose}>Annuler</button>
          {op && (
            <button type="button" className="danger" onClick={async () => {
              const r = await mv.deleteMovements(driver, snap, [op.id], { confirmed: false });
              if ('deps' in r) setConfirmDelete(r.deps);
            }}>Supprimer…</button>
          )}
        </div>
      </form>
      {confirmDelete && op && (
        <Notice kind="warn">
          <p>Mettre à la corbeille {confirmDelete.movements.length + confirmDelete.transferPartners.length} opération(s) ?</p>
          {confirmDelete.consequences.map((c) => <p key={c}>{c}</p>)}
          <div className="actions">
            <button className="danger" onClick={async () => {
              try {
                await mv.deleteMovements(driver, snap, [op.id], { confirmed: true });
                form.discard();
                await reload();
                onClose();
              } catch (e) {
                setGeneral(errorText(e));
              }
            }}>Confirmer la suppression</button>
            <button onClick={() => setConfirmDelete(null)}>Annuler</button>
          </div>
        </Notice>
      )}
      {op && (
        <section className="subsection">
          <h3>Rapprochement</h3>
          {recs.length === 0 && <p className="sub">Ce paiement n’est rapproché d’aucune échéance.</p>}
          {recs.map((r) => (
            <div key={r.id} className="row-between">
              <span>
                Affecté : {formatMoney(r.allocated_minor, op.currency)} {r.closes_target ? '(échéance soldée avec écart)' : ''} —{' '}
                {r.target_kind === 'occurrence' ? `${snap.recurrences.find((x) => x.id === r.recurrence_id)?.label} du ${formatDateFr(r.occurrence_date!)}` : r.target_kind === 'echeance' ? snap.scheduled.find((x) => x.id === r.scheduled_item_id)?.label : `crédit, échéance ${r.installment_seq}`}
              </span>
              <button onClick={async () => { await eng.unreconcile(driver, snap, r.id); await reload(); }}>Annuler le rapprochement</button>
            </div>
          ))}
          {suggestions.length > 0 && (
            <>
              <p className="sub">Échéances possibles (même rubrique) — un paiement ne solde que l’échéance que vous choisissez :</p>
              {suggestions.map((s) => (
                <div key={s.expected.key} className="row-between">
                  <span>
                    {s.expected.label} — {formatDateFr(s.expected.due_date)} — reste {formatMoney(s.expected.remaining, s.expected.currency)} <span className="sub">({s.reasons.join(', ')})</span>
                  </span>
                  <span className="actions small">
                    <button onClick={async () => { try { await eng.reconcile(driver, snap, { movement_id: op.id, target_key: s.expected.key }, today); await reload(); } catch (e) { setGeneral(errorText(e)); } }}>Rapprocher</button>
                    {Math.abs(op.amount_minor) !== s.expected.remaining && (
                      <button onClick={async () => { try { await eng.reconcile(driver, snap, { movement_id: op.id, target_key: s.expected.key, closes_target: true }, today); await reload(); } catch (e) { setGeneral(errorText(e)); } }}>Solder avec l’écart</button>
                    )}
                  </span>
                </div>
              ))}
            </>
          )}
          {form.dirty && <p className="sub">Enregistrez d’abord les modifications pour rapprocher.</p>}
        </section>
      )}
    </Modal>
  );
}

function TransferForm({ onClose, requestClose }: { onClose: () => void; requestClose: () => void }) {
  const { driver, snap, reload, today } = useData();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const form = useProtectedForm(
    'transfert:nouveau',
    'Nouveau transfert',
    { from: null as number | null, to: null as number | null, date: today, out_minor: null as number | null, in_minor: null as number | null, fee_minor: null as number | null, reference: '' },
    async (v) => {
      setErrors({});
      try {
        if (!v.from || !v.to || v.out_minor === null) {
          setErrors({ general: 'Comptes et montant débité : à renseigner' });
          return false;
        }
        await createTransfer(driver, snap, { from_account_id: v.from, to_account_id: v.to, date: v.date, out_minor: Math.abs(v.out_minor), in_minor: v.in_minor === null ? undefined : Math.abs(v.in_minor), fee: v.fee_minor ? { amount_minor: Math.abs(v.fee_minor) } : undefined, reference: v.reference || undefined });
        await reload();
        return true;
      } catch (e) {
        if (e instanceof ValidationError) setErrors(Object.fromEntries(e.errors.map((x) => [x.field, x.message])));
        else setErrors({ general: errorText(e) });
        return false;
      }
    },
  );
  const v = form.values;
  const from = snap.accounts.find((a) => a.id === v.from);
  const to = snap.accounts.find((a) => a.id === v.to);
  return (
    <Modal title="Nouveau transfert entre vos comptes" onClose={requestClose}>
      <DraftBanner offer={form.draftOffer} onRestore={form.restoreDraft} onIgnore={form.ignoreDraft} />
      <p className="sub">Deux opérations liées, neutres dans les revenus et dépenses. Les frais et l’écart de change éventuel sont comptés comme dépenses « Frais bancaires ».</p>
      <form onSubmit={async (e) => { e.preventDefault(); if (await form.save()) onClose(); }}>
        <div className="grid2">
          <Field label="Compte débité" error={errors.from_account_id}><AccountSelect snap={snap} value={v.from} onChange={(x) => form.set({ from: x })} /></Field>
          <Field label="Compte crédité" error={errors.to_account_id}><AccountSelect snap={snap} value={v.to} onChange={(x) => form.set({ to: x })} /></Field>
          <Field label="Date" error={errors.date}><input type="date" value={v.date} onChange={(e) => form.set({ date: e.target.value })} /></Field>
          <Field label="Montant débité" error={errors.out_minor}><MoneyInput value={v.out_minor} onChange={(x) => form.set({ out_minor: x })} currency={from?.currency ?? ''} ariaLabel="Montant débité" /></Field>
          {from && to && from.currency !== to.currency && (
            <Field label={`Montant reçu en ${to.currency}`} error={errors.in_minor}><MoneyInput value={v.in_minor} onChange={(x) => form.set({ in_minor: x })} currency={to.currency} ariaLabel="Montant reçu" /></Field>
          )}
          <Field label="Frais facturés (facultatif)" error={errors.fee}><MoneyInput value={v.fee_minor} onChange={(x) => form.set({ fee_minor: x })} currency={from?.currency ?? ''} allowEmpty ariaLabel="Frais" /></Field>
        </div>
        {errors.general && <Notice kind="error">{errors.general}</Notice>}
        <div className="actions">
          <button type="submit" className="primary">Enregistrer</button>
          <button type="button" onClick={requestClose}>Annuler</button>
        </div>
      </form>
    </Modal>
  );
}
