import { useQueryClient } from '@tanstack/react-query';
import { Alert, App, Button, Skeleton, Space } from 'antd';
import type { IdempotentOperation, TransactionDto, TransactionWriteResult } from '@xui/ledger-shared';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../../api/client.ts';
import { errorText, useMe } from '../../../api/hooks.ts';
import { correctTransaction, TRANSACTIONS, useTransactionRevision, voidTransaction } from '../../../api/transactions.ts';
import { diffVersions } from '../../../lib/lifecycle.ts';
import type { PrepareResult, RunResult } from '../../../lib/pendingWrite.ts';
import { issuesFromServer, type DraftIssue } from '../../../lib/txnDraft.ts';
import { usePendingWrite } from '../../../lib/usePendingWrite.ts';

/**
 * One lifecycle write on one transaction (M3-B4-D): a correction (settlement, fact, snapshot — one
 * slot, 'transaction.correct' + id) or a void ('transaction.void' + id), each through the B4-B/C
 * pending-write machine (lib/usePendingWrite.ts) — no second state machine.
 *
 * Definitive answers: REVISION_CONFLICT keeps the draft, refetches the transaction and reports the
 * current revision (the user chooses: rebase = new content, new key; never automatic);
 * TRANSACTION_VOIDED is final (the caller closes its form, the detail refreshes);
 * CONFIRMED_DOMESTIC is shown as the server's answer with a way into the void flow; a correction
 * that changes no fact is "no change"; other field problems go back to the fields.
 */

export type LifecycleError =
  | { code: 'REVISION_CONFLICT'; currentRevision: number }
  | { code: 'CONFIRMED_DOMESTIC' | 'noChange' | 'fields' | 'IDEMPOTENCY_CONFLICT' }
  | { code: 'in_flight' | 'unknown_outcome' }
  | { code: 'other'; message: string };

type Op = Extract<IdempotentOperation, 'transaction.correct' | 'transaction.void'>;

export function useLifecycleWrite(opts: { txn: TransactionDto; operation: Op; onSaved: (r: TransactionWriteResult) => void; onTerminal: () => void }) {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const qc = useQueryClient();
  const { data: me } = useMe();
  const { txn, operation } = opts;
  const send = useMemo(() => (operation === 'transaction.void' ? voidTransaction(txn.id) : correctTransaction(txn.id)), [operation, txn.id]);
  const writer = usePendingWrite<TransactionWriteResult>({ userId: me?.user.id, operation, transactionId: txn.id, send });
  const [error, setError] = useState<LifecycleError | null>(null);
  const [serverIssues, setServerIssues] = useState<DraftIssue[]>([]);
  const { onSaved, onTerminal } = opts;

  const handle = useCallback(
    async (r: RunResult<TransactionWriteResult> | Extract<PrepareResult, { ok: false }> | null, body: unknown) => {
      if (!r) return;
      if ('reason' in r) {
        setError({ code: r.reason });
        return;
      }
      if (r.outcome.kind === 'success' && r.data) {
        await qc.invalidateQueries({ queryKey: [TRANSACTIONS] });
        void message.success(r.outcome.replayed ? t('transactions.lifecycle.savedReplayed') : t(operation === 'transaction.void' ? 'transactions.lifecycle.voided' : 'transactions.lifecycle.corrected'));
        onSaved(r.data);
        return;
      }
      if (r.outcome.kind !== 'definitive') return; // unknown: the banner explains, the form stays locked; aborted: abandoned
      const e = r.error;
      if (!(e instanceof ApiError)) {
        setError({ code: 'other', message: errorText(e, t) });
        return;
      }
      if (e.code === 'REVISION_CONFLICT') {
        await qc.invalidateQueries({ queryKey: [TRANSACTIONS, 'detail', txn.id] });
        setError({ code: 'REVISION_CONFLICT', currentRevision: (e.details as { currentRevision?: number } | undefined)?.currentRevision ?? txn.currentRevision });
        return;
      }
      if (e.code === 'TRANSACTION_VOIDED') {
        await qc.invalidateQueries({ queryKey: [TRANSACTIONS] });
        void message.warning(t('errors.codes.TRANSACTION_VOIDED'));
        onTerminal();
        return;
      }
      if (e.code === 'IDEMPOTENCY_CONFLICT') {
        setError({ code: 'IDEMPOTENCY_CONFLICT' });
        return;
      }
      const entries = (body as { entries?: readonly { direction: 'out' | 'in' }[] }).entries ?? [];
      const fields = issuesFromServer(e, { entries }, true);
      if (fields) {
        setServerIssues(fields);
        setError({ code: fields.some((i) => i.code === 'confirmedDomestic') ? 'CONFIRMED_DOMESTIC' : fields.some((i) => i.code === 'noChange') ? 'noChange' : 'fields' });
        return;
      }
      setError({ code: 'other', message: errorText(e, t) });
    },
    [qc, message, t, operation, onSaved, onTerminal, txn.id, txn.currentRevision],
  );

  const submit = useCallback(
    async (body: unknown) => {
      setError(null);
      setServerIssues([]);
      await handle(await writer.submit(body), body);
    },
    [writer, handle],
  );
  const retry = useCallback(async () => {
    setError(null);
    const body = writer.pending?.body;
    if (body !== undefined) await handle(await writer.retry(), body);
  }, [writer, handle]);
  const clear = useCallback(() => {
    setError(null);
    setServerIssues([]);
  }, []);

  return { writer, error, serverIssues, submit, retry, clear };
}

/** Alerts for a lifecycle error (the conflict has its own panel). */
export function LifecycleErrorAlert({ error, issues, onVoid }: { error: LifecycleError | null; issues: string[]; onVoid?: () => void }) {
  const { t } = useTranslation();
  if (!error || error.code === 'REVISION_CONFLICT') return null;
  const common = { showIcon: true, className: 'form-alert txn-form-error', 'data-code': error.code } as const;
  if (error.code === 'CONFIRMED_DOMESTIC') {
    return (
      <Alert
        type="error"
        {...common}
        title={t('errors.codes.CONFIRMED_DOMESTIC')}
        description={t('transactions.lifecycle.domesticVoidHint')}
        action={
          onVoid && (
            <Button danger size="small" onClick={onVoid} className="txn-void-instead">
              {t('transactions.lifecycle.voidInstead')}
            </Button>
          )
        }
      />
    );
  }
  if (error.code === 'noChange') return <Alert type="warning" {...common} title={t('transactions.lifecycle.noChange')} />;
  if (error.code === 'in_flight' || error.code === 'unknown_outcome') return <Alert type="warning" {...common} title={t(`transactions.form.locked.${error.code}`)} />;
  if (error.code === 'IDEMPOTENCY_CONFLICT') return <Alert type="error" {...common} title={t('errors.codes.IDEMPOTENCY_CONFLICT')} />;
  if (error.code === 'other') return <Alert type="error" {...common} title={error.message} />;
  return <Alert type="error" {...common} title={issues[0] ?? t('transactions.form.fixFields')} />;
}

/**
 * REVISION_CONFLICT: the draft is kept; this shows the version it was based on against the current
 * one (what someone else changed) and lets the user decide. Rebasing changes the request (a new
 * key); nothing happens automatically.
 */
export function ConflictPanel({ txn, baseRevision, currentRevision, onRebase, children }: { txn: TransactionDto; baseRevision: number; currentRevision: number; onRebase: () => void; children?: ReactNode }) {
  const { t } = useTranslation();
  const { data: base } = useTransactionRevision(txn.id, String(baseRevision));
  const fresh = txn.currentRevision >= currentRevision;
  const changes = base && fresh ? diffVersions(base, { revision: txn.currentRevision, event: txn.event, entries: txn.entries }) : null;
  return (
    <Alert
      type="warning"
      showIcon
      className="form-alert txn-conflict"
      data-current={txn.currentRevision}
      title={t('transactions.lifecycle.conflictTitle', { base: baseRevision, current: txn.currentRevision })}
      description={
        <>
          <div>{t('transactions.lifecycle.conflictContent')}</div>
          {!changes ? (
            <Skeleton active paragraph={{ rows: 1 }} title={false} />
          ) : changes.length === 0 ? (
            <div className="muted">{t('transactions.lifecycle.conflictNoFacts')}</div>
          ) : (
            <ul className="txn-conflict-changes">
              {changes.map((c) => (
                <li key={c.field} data-field={c.field}>
                  <span className="muted">{t(`transactions.lifecycle.fields.${c.field.replace('.', '_')}`)}</span> {c.before} → <strong>{c.after}</strong>
                </li>
              ))}
            </ul>
          )}
          <Space wrap className="txn-conflict-actions">
            <Button type="primary" onClick={onRebase} disabled={!fresh || txn.status === 'voided'} className="txn-rebase">
              {t('transactions.lifecycle.rebase', { n: txn.currentRevision })}
            </Button>
            {children}
          </Space>
        </>
      }
    />
  );
}
