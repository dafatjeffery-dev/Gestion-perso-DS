import { useState } from 'react';
import { formatDateFr } from '../../domain/dates';
import type { Account, AccountType, Currency, Owner, Tracking } from '../../domain/types';
import { accountBalance, liquidities } from '../../engine/balances';
import { ValidationError } from '../../services/plan';
import * as ref from '../../services/referentials';
import { Amount, Field, FigureValue, Modal, MoneyInput, Notice, errorText } from '../components/core';
import { DraftBanner, useGuard, useProtectedForm } from '../components/guard';
import { useData } from '../data';
import { ACCOUNT_TYPE, ownerLabel } from '../labels';
import { useNav } from '../nav';

export function AccountsScreen() {
  const { snap, ctx } = useData();
  const nav = useNav();
  const guard = useGuard();
  const [edit, setEdit] = useState<Account | 'new' | null>(null);
  const [balanceFor, setBalanceFor] = useState<Account | null>(null);
  const [archive, setArchive] = useState<Account | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const active = snap.accounts.filter((a) => a.status === 'actif');
  const archived = snap.accounts.filter((a) => a.status === 'archive');
  const close = (fn: () => void) => () => guard.attempt(fn);

  return (
    <div>
      <div className="screen-head">
        <h1>Comptes</h1>
        <div className="actions">
          <button onClick={() => nav.go('imports')}>Importer des opérations</button>
          <button className="primary" onClick={() => setEdit('new')}>Nouveau compte</button>
        </div>
      </div>
      <p className="sub">
        Liquidités totales : <FigureValue f={liquidities(ctx)} />
      </p>
      {snap.accounts.length === 0 && <Notice>Commencez par créer vos comptes, avec leur dernier solde connu.</Notice>}
      <div className="cards">
        {active.map((a) => (
          <AccountCard key={a.id} a={a} onEdit={() => setEdit(a)} onBalance={() => setBalanceFor(a)} onArchive={() => setArchive(a)} />
        ))}
      </div>
      {archived.length > 0 && (
        <section className="card">
          <button className="link-btn" onClick={() => setShowArchived(!showArchived)} aria-expanded={showArchived}>
            {showArchived ? '▾' : '▸'} Comptes archivés ({archived.length}) — leurs soldes restent dans les liquidités
          </button>
          {showArchived && (
            <div className="cards">
              {archived.map((a) => (
                <AccountCard key={a.id} a={a} onEdit={() => setEdit(a)} onBalance={() => setBalanceFor(a)} onArchive={() => setArchive(a)} />
              ))}
            </div>
          )}
        </section>
      )}
      {edit && <AccountForm account={edit === 'new' ? null : edit} onClose={() => setEdit(null)} requestClose={close(() => setEdit(null))} />}
      {balanceFor && <BalanceForm account={balanceFor} onClose={() => setBalanceFor(null)} requestClose={close(() => setBalanceFor(null))} />}
      {archive && <ArchiveDialog account={archive} onClose={() => setArchive(null)} />}
      <p className="sub" style={{ marginTop: 12 }}>
        {ctx.snap.accounts.length > 0 && 'Le solde d’un compte = dernier solde constaté + opérations postérieures. Les totaux mensuels sans compte n’agissent pas sur les soldes.'}
      </p>
    </div>
  );
}

function AccountCard({ a, onEdit, onBalance, onArchive }: { a: Account; onEdit: () => void; onBalance: () => void; onArchive: () => void }) {
  const { ctx, snap } = useData();
  const nav = useNav();
  const b = accountBalance(ctx, a.id);
  return (
    <article className="account-card" aria-label={`Compte ${a.name}`}>
      <div className="row-between">
        <div>
          <div className="account-name">{a.name}</div>
          <div className="sub">
            {a.institution ? `${a.institution} · ` : ''}{ACCOUNT_TYPE[a.type]} · {ownerLabel(snap, a.owner)} · {a.tracking === 'synthetique' ? 'suivi par soldes' : 'suivi détaillé'}
          </div>
        </div>
        <span className="tag n">{a.currency}</span>
      </div>
      <div className="account-balance">
        <Amount value={b.minor} currency={a.currency} reason={b.missingReason} />
      </div>
      <div className="sub">
        {b.reference ? (
          <>
            Solde constaté au {formatDateFr(b.reference.ref_date)}
            {b.operationsSinceRef > 0 && ` + ${b.operationsSinceRef} opération(s)`}
            {b.stale && <span className="alert"> · ancien de {b.referenceAgeDays} jours</span>}
            {a.tracking === 'synthetique' && b.reference && b.referenceAgeDays! > 0 && ' · estimé depuis ce relevé'}
          </>
        ) : (
          <span className="alert">Aucun solde constaté</span>
        )}
      </div>
      <div className="actions small">
        <button onClick={() => nav.go('operations', { accountId: a.id })}>Opérations</button>
        <button onClick={onBalance}>Solde constaté</button>
        <button onClick={onEdit}>Modifier</button>
        <button onClick={onArchive}>{a.status === 'actif' ? 'Archiver' : 'Réactiver'}</button>
      </div>
    </article>
  );
}

interface AccountValues {
  name: string;
  institution: string;
  currency: Currency;
  owner: Owner;
  type: AccountType;
  tracking: Tracking;
  is_default_for_currency: boolean;
  balance_date: string;
  balance_minor: number | null;
}

function AccountForm({ account, onClose, requestClose }: { account: Account | null; onClose: () => void; requestClose: () => void }) {
  const { driver, snap, reload, today } = useData();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [general, setGeneral] = useState<string | null>(null);
  const initial: AccountValues = account
    ? { name: account.name, institution: account.institution, currency: account.currency, owner: account.owner, type: account.type, tracking: account.tracking, is_default_for_currency: !!account.is_default_for_currency, balance_date: today, balance_minor: null }
    : { name: '', institution: '', currency: 'EUR', owner: 'commun', type: 'courant', tracking: 'detaille', is_default_for_currency: false, balance_date: today, balance_minor: null };
  const form = useProtectedForm<AccountValues>(`compte:${account?.id ?? 'nouveau'}`, account ? `Compte « ${account.name} »` : 'Nouveau compte', initial, async (v) => {
    setErrors({});
    setGeneral(null);
    try {
      if (account) {
        await ref.updateAccount(driver, snap, account.id, { name: v.name, institution: v.institution, owner: v.owner, type: v.type, tracking: v.tracking, currency: v.currency, is_default_for_currency: v.is_default_for_currency });
      } else {
        await ref.createAccount(driver, snap, { ...v, is_default_for_currency: v.is_default_for_currency || undefined, initialBalance: v.balance_minor !== null ? { ref_date: v.balance_date, amount_minor: v.balance_minor } : undefined });
      }
      await reload();
      return true;
    } catch (e) {
      if (e instanceof ValidationError) setErrors(Object.fromEntries(e.errors.map((x) => [x.field, x.message])));
      else setGeneral(errorText(e));
      return false;
    }
  });
  const v = form.values;
  return (
    <Modal title={account ? `Modifier « ${account.name} »` : 'Nouveau compte'} onClose={requestClose}>
      <DraftBanner offer={form.draftOffer} onRestore={form.restoreDraft} onIgnore={form.ignoreDraft} />
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (await form.save()) onClose();
        }}
      >
        <Field label="Nom" error={errors.name}>
          <input value={v.name} onChange={(e) => form.set({ name: e.target.value })} autoFocus />
        </Field>
        <Field label="Établissement">
          <input value={v.institution} onChange={(e) => form.set({ institution: e.target.value })} />
        </Field>
        <div className="grid2">
          <Field label="Devise" error={errors.currency}>
            <select value={v.currency} onChange={(e) => form.set({ currency: e.target.value as Currency })}>
              <option>EUR</option>
              <option>CHF</option>
            </select>
          </Field>
          <Field label="Propriétaire">
            <select value={v.owner} onChange={(e) => form.set({ owner: e.target.value as Owner })}>
              <option value="A">{ownerLabel(snap, 'A')}</option>
              <option value="B">{ownerLabel(snap, 'B')}</option>
              <option value="commun">Commun</option>
            </select>
          </Field>
          <Field label="Type">
            <select value={v.type} onChange={(e) => form.set({ type: e.target.value as AccountType })}>
              {Object.entries(ACCOUNT_TYPE).map(([k, l]) => (
                <option key={k} value={k}>{l}</option>
              ))}
            </select>
          </Field>
          <Field label="Suivi" hint={v.tracking === 'synthetique' ? 'Vous mettez à jour le solde régulièrement, sans saisir les opérations.' : 'Les opérations sont saisies ou importées.'}>
            <select value={v.tracking} onChange={(e) => form.set({ tracking: e.target.value as Tracking })}>
              <option value="detaille">Détaillé (opérations)</option>
              <option value="synthetique">Par soldes constatés</option>
            </select>
          </Field>
        </div>
        <label className="check">
          <input type="checkbox" checked={v.is_default_for_currency} onChange={(e) => form.set({ is_default_for_currency: e.target.checked })} /> Compte par défaut en {v.currency} (prévisions sans compte précisé)
        </label>
        {!account && (
          <div className="grid2">
            <Field label="Dernier solde connu (facultatif)" error={errors['initialBalance.ref_date']}>
              <MoneyInput value={v.balance_minor} onChange={(x) => form.set({ balance_minor: x })} currency={v.currency} allowEmpty ariaLabel="Solde initial" />
            </Field>
            <Field label="à la date du">
              <input type="date" value={v.balance_date} onChange={(e) => form.set({ balance_date: e.target.value })} />
            </Field>
          </div>
        )}
        {general && <Notice kind="error">{general}</Notice>}
        <div className="actions">
          <button type="submit" className="primary">Enregistrer</button>
          <button type="button" onClick={requestClose}>Annuler</button>
        </div>
      </form>
    </Modal>
  );
}

function BalanceForm({ account, onClose, requestClose }: { account: Account; onClose: () => void; requestClose: () => void }) {
  const { driver, snap, reload, today } = useData();
  const [error, setError] = useState<string | null>(null);
  const form = useProtectedForm(`solde:${account.id}`, `Solde constaté de « ${account.name} »`, { ref_date: today, amount_minor: null as number | null, note: '' }, async (v) => {
    if (v.amount_minor === null) {
      setError('Indiquez le montant du solde');
      return false;
    }
    try {
      await ref.setBalanceReference(driver, snap, { account_id: account.id, ref_date: v.ref_date, amount_minor: v.amount_minor, note: v.note, source: 'releve' });
      await reload();
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    }
  });
  const existing = snap.balanceRefs.find((b) => b.account_id === account.id && b.ref_date === form.values.ref_date);
  const history = snap.balanceRefs.filter((b) => b.account_id === account.id).sort((a, b) => (a.ref_date < b.ref_date ? 1 : -1)).slice(0, 6);
  return (
    <Modal title={`Solde constaté — ${account.name}`} onClose={requestClose}>
      <DraftBanner offer={form.draftOffer} onRestore={form.restoreDraft} onIgnore={form.ignoreDraft} />
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (await form.save()) onClose();
        }}
      >
        <div className="grid2">
          <Field label="Date (solde en fin de journée)">
            <input type="date" value={form.values.ref_date} onChange={(e) => form.set({ ref_date: e.target.value })} />
          </Field>
          <Field label="Solde">
            <MoneyInput value={form.values.amount_minor} onChange={(x) => form.set({ amount_minor: x })} currency={account.currency} ariaLabel="Solde constaté" />
          </Field>
        </div>
        {existing && <Notice kind="warn">Un solde existe déjà à cette date ({(existing.amount_minor / 100).toFixed(2).replace('.', ',')} {account.currency}) : il sera corrigé.</Notice>}
        <Field label="Note">
          <input value={form.values.note} onChange={(e) => form.set({ note: e.target.value })} />
        </Field>
        {error && <Notice kind="error">{error}</Notice>}
        <div className="actions">
          <button type="submit" className="primary">Enregistrer</button>
          <button type="button" onClick={requestClose}>Annuler</button>
        </div>
      </form>
      {history.length > 0 && (
        <table className="table">
          <thead><tr><th>Soldes constatés</th><th className="num">Montant</th></tr></thead>
          <tbody>
            {history.map((b) => (
              <tr key={b.id}><td>{formatDateFr(b.ref_date)}</td><td className="num"><Amount value={b.amount_minor} currency={account.currency} /></td></tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  );
}

function ArchiveDialog({ account, onClose }: { account: Account; onClose: () => void }) {
  const { driver, snap, reload } = useData();
  const [error, setError] = useState<string | null>(null);
  const archiving = account.status === 'actif';
  return (
    <Modal title={archiving ? `Archiver « ${account.name} »` : `Réactiver « ${account.name} »`} onClose={onClose}>
      {archiving ? (
        <p>
          Le compte ne sera plus proposé pour de nouvelles saisies et sera replié dans la liste. <strong>Rien n’est supprimé</strong> : son historique reste dans les analyses et son solde restant
          reste compté dans les liquidités et le patrimoine.
        </p>
      ) : (
        <p>Le compte sera de nouveau proposé pour les saisies.</p>
      )}
      {error && <Notice kind="error">{error}</Notice>}
      <div className="actions">
        <button
          className="primary"
          onClick={async () => {
            try {
              if (archiving) await ref.archiveAccount(driver, snap, account.id);
              else await ref.reactivateAccount(driver, snap, account.id);
              await reload();
              onClose();
            } catch (e) {
              setError(errorText(e));
            }
          }}
        >
          {archiving ? 'Archiver' : 'Réactiver'}
        </button>
        <button onClick={onClose}>Annuler</button>
      </div>
    </Modal>
  );
}
