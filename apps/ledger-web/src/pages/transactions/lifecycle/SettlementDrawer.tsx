import { Alert, Button, Checkbox, ConfigProvider, Drawer, Form, Input, Space, Tag, Typography } from 'antd';
import { REASON_MAX, formatAmount, type EntryDirection, type SettlementCorrection, type TransactionDto } from '@xui/ledger-shared';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AmountInput } from '../../../components/AmountInput.tsx';
import { PendingWriteBanner } from '../../../components/PendingWriteBanner.tsx';
import { buildSettlementRequest, pendingEntries, type SettlementDraft } from '../../../lib/lifecycle.ts';
import { OVERLAY_Z, useNarrow } from '../../../lib/useMedia.ts';
import type { DraftIssue } from '../../../lib/txnDraft.ts';
import { issueMap, useFieldStatus, useIssueText } from '../form/issues.ts';
import { DirectionMark } from '../txnDisplay.tsx';
import { useRegion } from '../TxnFacts.tsx';
import { ConflictPanel, LifecycleErrorAlert, useLifecycleWrite } from './useLifecycleWrite.tsx';

/**
 * Settlement (API_SPEC §5.7, kind settlement): only the current version's PENDING entries, each
 * direction on its own (an own transfer may settle one side only). Everything else — accounts,
 * currencies (a currency closed since is a lawful same-account carry-over: no acknowledgement),
 * snapshots, the classification — is carried by the server. The draft survives any failure.
 */
export function SettlementDrawer({ txn, open, onClose }: { txn: TransactionDto; open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const narrow = useNarrow();
  return (
    <Drawer open={open} onClose={onClose} size={narrow ? '100%' : 640} title={t('transactions.lifecycle.settleTitle')} className="txn-settle-drawer" destroyOnHidden zIndex={OVERLAY_Z}>
      {open && <SettlementForm txn={txn} onClose={onClose} />}
    </Drawer>
  );
}

function SettlementForm({ txn, onClose }: { txn: TransactionDto; onClose: () => void }) {
  const { t } = useTranslation();
  const region = useRegion();
  const lw = useLifecycleWrite({ txn, operation: 'transaction.correct', onSaved: onClose, onTerminal: onClose });
  const { writer } = lw;
  // The version the settlement is based on: fixed when the form opens; changed only by the user (rebase).
  const [base, setBase] = useState(txn.currentRevision);
  const pending = pendingEntries(txn.entries);
  const [draft, setDraft] = useState<SettlementDraft>(() => Object.fromEntries(pending.map((e) => [e.direction, { selected: true, amountText: '' }])));
  const [reason, setReason] = useState('');
  const [issues, setIssues] = useState<DraftIssue[]>([]);

  // A restored unknown settlement is shown exactly as it will be resent.
  useEffect(() => {
    const body = writer.pending?.body as SettlementCorrection | undefined;
    if (!writer.restored || body?.kind !== 'settlement') return;
    setBase(body.baseRevision);
    setReason(body.reason ?? '');
    setDraft(
      Object.fromEntries(
        txn.entries.map((e) => {
          const s = body.entries.find((x) => x.direction === e.direction);
          return [e.direction, { selected: !!s, amountText: s ? formatAmount(s.amount, e.currencyExponent) : '' }];
        }),
      ),
    );
  }, [writer.restored, writer.pending, txn.entries]);

  const map = issueMap([...issues, ...lw.serverIssues]);
  const status = useFieldStatus(map);
  const issueText = useIssueText();
  const locked = writer.locked;
  const set = (dir: EntryDirection, patch: Partial<{ selected: boolean; amountText: string }>) => setDraft((d) => ({ ...d, [dir]: { selected: true, amountText: '', ...d[dir], ...patch } }));

  const submit = async () => {
    const built = buildSettlementRequest(txn.entries, draft, { baseRevision: base, reason });
    if (!built.ok) {
      setIssues(built.issues);
      return;
    }
    setIssues([]);
    await lw.submit(built.body);
  };

  if (pending.length === 0 && !writer.pending) {
    return <Alert type="info" showIcon className="form-alert" title={t('transactions.lifecycle.nothingPending')} />;
  }

  return (
    <div className="txn-lifecycle-form" data-kind="settlement" data-base={base}>
      <Typography.Paragraph type="secondary">{t('transactions.lifecycle.settleIntro')}</Typography.Paragraph>
      <PendingWriteBanner writer={writer} onRetry={() => void lw.retry()} checkHref={`/transactions/${txn.id}`} />
      {lw.error?.code === 'REVISION_CONFLICT' && (
        <ConflictPanel
          txn={txn}
          baseRevision={base}
          currentRevision={lw.error.currentRevision}
          onRebase={() => {
            setBase(txn.currentRevision);
            lw.clear();
          }}
        />
      )}
      <LifecycleErrorAlert error={lw.error} issues={(map.get('form') ?? []).map(issueText)} />
      <ConfigProvider componentDisabled={locked}>
        <Form layout="vertical" onFinish={() => void submit()} disabled={locked}>
          {pending.map((e) => {
            const d = draft[e.direction] ?? { selected: false, amountText: '' };
            return (
              <div key={e.entryId} className="txn-settle-entry" data-direction={e.direction}>
                <div className="txn-settle-head">
                  <DirectionMark direction={e.direction} />
                  <strong>{e.account.name}</strong>
                  <Tag>{e.currency}</Tag>
                  <span className="muted">
                    {t('transactions.detail.entryCountry')} {region(e.fundingAccountCountry)}
                  </span>
                  <Tag color={e.currencyStatusAtSave === 'closed' ? 'default' : 'green'}>
                    {t('transactions.detail.currencyAtSave')}：{t(`transactions.detail.currencyStatuses.${e.currencyStatusAtSave}`)}
                  </Tag>
                </div>
                {pending.length > 1 && (
                  <Checkbox checked={d.selected} disabled={locked} onChange={(ev) => set(e.direction, { selected: ev.target.checked })}>
                    {t('transactions.lifecycle.settleThis')}
                  </Checkbox>
                )}
                <Form.Item label={t(e.direction === 'out' ? 'transactions.form.amountOut' : 'transactions.form.amountIn')} {...status(`entry.${e.direction}.amount`)} extra={t('transactions.lifecycle.carriedCurrency')}>
                  <AmountInput
                    aria-label={`${t('transactions.lifecycle.settleAmount')} · ${e.direction}`}
                    value={d.amountText}
                    currency={e.currency}
                    disabled={locked || !d.selected}
                    onChange={(v) => set(e.direction, { amountText: v })}
                  />
                </Form.Item>
              </div>
            );
          })}
          <Form.Item label={t('transactions.lifecycle.reasonOptional')} {...status('reason')}>
            <Input.TextArea aria-label={t('transactions.lifecycle.reasonOptional')} value={reason} onChange={(ev) => setReason(ev.target.value)} maxLength={REASON_MAX} showCount autoSize={{ minRows: 2 }} disabled={locked} />
          </Form.Item>
          <Space className="txn-lifecycle-actions">
            <Button onClick={onClose} className="txn-cancel">
              {t('transactions.detail.cancel')}
            </Button>
            <Button type="primary" htmlType="submit" disabled={locked} loading={writer.pending?.state === 'sending'} className="txn-submit">
              {t('transactions.lifecycle.settleSubmit')}
            </Button>
          </Space>
        </Form>
      </ConfigProvider>
    </div>
  );
}
