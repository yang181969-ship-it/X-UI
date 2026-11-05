import { Tag } from 'antd';
import type { TransactionListItem } from '@xui/ledger-shared';
import { useTranslation } from 'react-i18next';

/**
 * The saved states of a transaction's current version as tags: voided, region status (as saved by
 * the server — never computed here), pending amounts, backfill, and later versions. Only facts the
 * server returned; no inference.
 */
export function TxnStatusTags({ txn }: { txn: Pick<TransactionListItem, 'status' | 'event' | 'entries' | 'currentRevision'> }) {
  const { t } = useTranslation();
  const pending = txn.entries.some((e) => e.amountStatus === 'pending');
  const fs = txn.event.foreignStatus;
  return (
    <span className="txn-tags">
      {txn.status === 'voided' && (
        <Tag className="tag-voided" data-tag="voided">
          {t('transactions.status.voided')}
        </Tag>
      )}
      <Tag color={fs === 'foreign' ? 'blue' : fs === 'undetermined' ? 'gold' : undefined} data-tag={`foreign-${fs}`}>
        {t(`transactions.foreignStatus.${fs}`)}
      </Tag>
      {pending && (
        <Tag color="orange" data-tag="pending">
          {t('transactions.amountStatus.pending')}
        </Tag>
      )}
      {txn.event.recordMode === 'backfill' && (
        <Tag color="purple" data-tag="backfill">
          {t('transactions.recordMode.backfill')}
        </Tag>
      )}
      {txn.currentRevision > 1 && (
        <Tag data-tag="revised">{t('transactions.tags.revised', { n: txn.currentRevision })}</Tag>
      )}
    </span>
  );
}
