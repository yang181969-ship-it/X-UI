import { Button, Checkbox, ConfigProvider, Form, Input, Modal, Space, Typography } from 'antd';
import { REASON_MAX, type TransactionDto, type TransactionVoid } from '@xui/ledger-shared';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PendingWriteBanner } from '../../../components/PendingWriteBanner.tsx';
import { buildVoidRequest } from '../../../lib/lifecycle.ts';
import { OVERLAY_Z } from '../../../lib/useMedia.ts';
import type { DraftIssue } from '../../../lib/txnDraft.ts';
import { issueMap, useFieldStatus, useIssueText } from '../form/issues.ts';
import { ConflictPanel, LifecycleErrorAlert, useLifecycleWrite } from './useLifecycleWrite.tsx';

/**
 * Void (API_SPEC §5.8): final, no restore and no delete; every version stays readable, the
 * transaction leaves the statistics, notes stay editable. No new version: currentRevision does not
 * change. The user must tick the confirmation; the reason is optional. Base revision fixed at open.
 */
export function VoidModal({ txn, open, onClose }: { txn: TransactionDto; open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <Modal open={open} onCancel={onClose} footer={null} title={t('transactions.lifecycle.voidTitle')} className="txn-void-modal" destroyOnHidden width={560} zIndex={OVERLAY_Z}>
      {open && <VoidForm txn={txn} onClose={onClose} />}
    </Modal>
  );
}

function VoidForm({ txn, onClose }: { txn: TransactionDto; onClose: () => void }) {
  const { t } = useTranslation();
  const lw = useLifecycleWrite({ txn, operation: 'transaction.void', onSaved: onClose, onTerminal: onClose });
  const { writer } = lw;
  const [base, setBase] = useState(txn.currentRevision);
  const [reason, setReason] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [issues, setIssues] = useState<DraftIssue[]>([]);

  useEffect(() => {
    const body = writer.pending?.body as TransactionVoid | undefined;
    if (!writer.restored || !body) return;
    setBase(body.baseRevision);
    setReason(body.reason ?? '');
    setConfirmed(true);
  }, [writer.restored, writer.pending]);

  const map = issueMap([...issues, ...lw.serverIssues]);
  const status = useFieldStatus(map);
  const issueText = useIssueText();
  const locked = writer.locked;

  const submit = async () => {
    const built = buildVoidRequest({ baseRevision: base, reason, confirmed });
    if (!built.ok) {
      setIssues(built.issues);
      return;
    }
    setIssues([]);
    await lw.submit(built.body);
  };

  return (
    <div className="txn-lifecycle-form" data-kind="void" data-base={base}>
      <ul className="txn-void-facts">
        <li>{t('transactions.lifecycle.voidFinal')}</li>
        <li>{t('transactions.lifecycle.voidKeeps')}</li>
        <li>{t('transactions.lifecycle.voidStats')}</li>
        <li>{t('transactions.lifecycle.voidNotes')}</li>
      </ul>
      <PendingWriteBanner writer={writer} onRetry={() => void lw.retry()} checkHref={`/transactions/${txn.id}`} />
      {lw.error?.code === 'REVISION_CONFLICT' && (
        <ConflictPanel
          txn={txn}
          baseRevision={base}
          currentRevision={lw.error.currentRevision}
          onRebase={() => {
            setBase(txn.currentRevision);
            setConfirmed(false);
            lw.clear();
          }}
        />
      )}
      <LifecycleErrorAlert error={lw.error} issues={(map.get('form') ?? []).map(issueText)} />
      <ConfigProvider componentDisabled={locked}>
        <Form layout="vertical" onFinish={() => void submit()} disabled={locked}>
          <Form.Item label={t('transactions.lifecycle.reasonOptional')} {...status('reason')}>
            <Input.TextArea aria-label={t('transactions.lifecycle.voidReason')} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={REASON_MAX} showCount autoSize={{ minRows: 2 }} disabled={locked} />
          </Form.Item>
          <Form.Item {...status('confirm')}>
            <Checkbox checked={confirmed} disabled={locked} onChange={(e) => setConfirmed(e.target.checked)} className="txn-void-confirm">
              {t('transactions.lifecycle.voidConfirm', { n: base })}
            </Checkbox>
          </Form.Item>
          <Typography.Paragraph type="secondary" className="field-note">
            {t('transactions.lifecycle.voidBase', { n: base })}
          </Typography.Paragraph>
          <Space className="txn-lifecycle-actions" wrap>
            <Button onClick={onClose} className="txn-cancel">
              {t('transactions.detail.cancel')}
            </Button>
            <Button type="primary" danger htmlType="submit" disabled={locked || !confirmed} loading={writer.pending?.state === 'sending'} className="txn-submit">
              {t('transactions.lifecycle.voidSubmit')}
            </Button>
          </Space>
        </Form>
      </ConfigProvider>
    </div>
  );
}
