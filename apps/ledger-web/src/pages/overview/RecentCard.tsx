import { Alert, Card, Empty, Skeleton, Typography } from 'antd';
import type { TransactionListItem } from '@xui/ledger-shared';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router';
import { errorText } from '../../api/hooks.ts';
import { transactionHref } from '../../api/transactions.ts';
import { TxnCard } from '../TransactionsPage.tsx';

/**
 * The latest transactions of the period in the list's own order (GET /transactions: occurredOn
 * desc, then time, then created) — i.e. latest by date of occurrence, not by recording. Shown with
 * the list's card component.
 */
export function RecentCard({ items, loading, error, href }: { items: TransactionListItem[]; loading: boolean; error: unknown; href: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <Card
      className="overview-recent"
      title={t('overview.recent.title')}
      extra={
        <Link to={href} className="overview-recent-all">
          {t('overview.recent.all')}
        </Link>
      }
    >
      <Typography.Paragraph type="secondary" className="field-note">
        {t('overview.recent.note')}
      </Typography.Paragraph>
      {!!error && <Alert type="error" showIcon title={errorText(error, t)} className="form-alert" />}
      {loading && <Skeleton active paragraph={{ rows: 3 }} />}
      {!loading && !error && items.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('overview.recent.empty')} />}
      <div className="txn-cards overview-recent-list">
        {items.map((r) => (
          <TxnCard key={r.id} txn={r} onOpen={() => navigate(transactionHref(r.id))} />
        ))}
      </div>
    </Card>
  );
}
