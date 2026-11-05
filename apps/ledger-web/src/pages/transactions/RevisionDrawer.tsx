import { Alert, Drawer, Empty, Skeleton, Tag } from 'antd';
import type { TransactionDto } from '@xui/ledger-shared';
import { useTranslation } from 'react-i18next';
import { useTransactionRevision } from '../../api/transactions.ts';
import { OVERLAY_Z, useNarrow } from '../../lib/useMedia.ts';
import { FactsView } from './TxnFacts.tsx';

/**
 * /transactions/:id/revisions/:revision — one published version, read-only (API_SPEC §5.6). The URL
 * opens it directly; a malformed or unpublished revision shows "not found" (the server answers
 * 400 / 404). There are no edit or delete actions.
 */
export function RevisionDrawer({ txn, revision, onClose }: { txn: TransactionDto; revision: string | undefined; onClose: () => void }) {
  const { t } = useTranslation();
  const narrow = useNarrow();
  const { data, isLoading, isError } = useTransactionRevision(txn.id, revision);
  const version = data && data.transactionId === txn.id && String(data.revision) === revision ? data : undefined;
  const summary = txn.revisions.find((r) => String(r.revision) === revision);
  const kind = version ? t(`transactions.revisionKinds.${version.event.revisionKind}`) : summary ? t(`transactions.revisionKinds.${summary.revisionKind}`) : '';
  return (
    <Drawer
      open={revision !== undefined}
      onClose={onClose}
      size={narrow ? '100%' : 820}
      className="txn-revision-drawer"
      zIndex={OVERLAY_Z}
      title={
        <span>
          {revision !== undefined && t('transactions.detail.revisionTitle', { n: revision, kind })} <Tag>{t('transactions.detail.readOnly')}</Tag>
        </span>
      }
      destroyOnHidden
    >
      {isLoading && <Skeleton active />}
      {isError && !version && <Empty description={t('transactions.detail.revisionNotFound')} />}
      {version && (
        <>
          <Alert
            type={version.revision === txn.currentRevision ? 'info' : 'warning'}
            showIcon
            className="form-alert txn-revision-state"
            title={version.revision === txn.currentRevision ? t('transactions.detail.revisionIsCurrent') : t('transactions.detail.revisionSuperseded')}
            description={version.event.correctionReason ? t('transactions.detail.reason', { reason: version.event.correctionReason }) : undefined}
          />
          <FactsView txnType={version.txnType} revision={version.revision} event={version.event} entries={version.entries} refs={{ card: txn.card, channel: txn.paymentChannel }} />
        </>
      )}
    </Drawer>
  );
}
