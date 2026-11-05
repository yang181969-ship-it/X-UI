import { Button, Card, Tag, Timeline, Typography } from 'antd';
import type { TransactionDto } from '@xui/ledger-shared';
import dayjs from 'dayjs';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router';
import { revisionHref } from '../../api/transactions.ts';

const at = (ms: number) => dayjs(ms).format('YYYY-MM-DD HH:mm');

/**
 * Every published version, oldest first, each opening a read-only view; a voided transaction ends
 * with the void as a final node (it is a status change, not a version). Nothing here changes or
 * deletes a version.
 */
export function RevisionTimeline({ txn }: { txn: TransactionDto }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const revisions = [...txn.revisions].sort((a, b) => a.revision - b.revision);
  const items = revisions.map((r) => ({
    key: `r${r.revision}`,
    color: r.revision === txn.currentRevision ? 'blue' : 'gray',
    content: (
      <div className="txn-revision-node" data-revision={r.revision} data-kind={r.revisionKind}>
        <div className="txn-revision-head">
          <strong>
            v{r.revision} · {t(`transactions.revisionKinds.${r.revisionKind}`)}
          </strong>
          {r.revision === txn.currentRevision && <Tag color="blue">{t('transactions.detail.currentTag')}</Tag>}
          <span className="muted num">{at(r.createdAt)}</span>
        </div>
        {r.correctionReason && <div className="txn-revision-reason">{t('transactions.detail.reason', { reason: r.correctionReason })}</div>}
        <Button size="small" type="link" className="txn-revision-view" onClick={() => navigate(revisionHref(txn.id, r.revision), { state: location.state })}>
          {t('transactions.detail.view', { n: r.revision })}
        </Button>
      </div>
    ),
  }));
  if (txn.status === 'voided') {
    items.push({
      key: 'void',
      color: 'red',
      content: (
        <div className="txn-revision-node txn-void-node" data-kind="void">
          <div className="txn-revision-head">
            <strong>{t('transactions.detail.voidNode')}</strong>
            {txn.voidedAt !== null && <span className="muted num">{at(txn.voidedAt)}</span>}
          </div>
          <div className="txn-revision-reason">{txn.voidReason ? t('transactions.detail.voidReason', { reason: txn.voidReason }) : t('transactions.detail.voidNoReason')}</div>
        </div>
      ),
    });
  }
  return (
    <Card title={t('transactions.detail.history')} className="txn-history">
      <Typography.Paragraph type="secondary" className="field-note">
        {t('transactions.detail.historyHint')}
      </Typography.Paragraph>
      <Timeline items={items} />
    </Card>
  );
}
