import { Card, Tag, Typography } from 'antd';
import type { TransactionSummaryDto } from '@xui/ledger-shared';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { activityKey, pendingEntryCount } from '../../lib/summaryView.ts';

/**
 * Pending amounts: how many transactions (server COUNT DISTINCT) and how many entries, per
 * currency × type × direction — never an amount, never zero in place of an amount. Links to the
 * pending list of the same period.
 */
export function PendingCard({ summary, href }: { summary: TransactionSummaryDto; href: string }) {
  const { t } = useTranslation();
  const entries = pendingEntryCount(summary.pending);
  return (
    <Card
      className="overview-pending"
      title={t('overview.pending.title')}
      extra={
        summary.pendingTransactionCount > 0 && (
          <Link to={href} className="overview-pending-open">
            {t('overview.pending.open')}
          </Link>
        )
      }
    >
      {summary.pendingTransactionCount === 0 ? (
        <Typography.Text type="secondary" className="overview-pending-none">
          {t('overview.pending.none')}
        </Typography.Text>
      ) : (
        <>
          <div className="overview-pending-summary" data-transactions={summary.pendingTransactionCount} data-entries={entries}>
            {t('overview.pending.summary', { txns: summary.pendingTransactionCount, entries })}
          </div>
          <div className="pending-rows">
            {summary.pending.map((p) => {
              const key = activityKey(p.txnType, p.direction);
              return (
                <div key={`${p.foreignStatus}|${p.txnType}|${p.direction}|${p.currency}|${p.currencyExponent}`} className="pending-row" data-currency={p.currency} data-row={key ?? ''}>
                  <span className="stat-currency">{p.currency}</span>
                  <span className="pending-row-label">
                    {key ? t(`overview.rows.${key}`) : p.txnType}
                    {p.foreignStatus !== 'foreign' && <Tag className="pending-row-status">{t(`overview.blocks.${p.foreignStatus}`)}</Tag>}
                  </span>
                  <span className="num muted">{t('overview.pending.entries', { count: p.count })}</span>
                </div>
              );
            })}
          </div>
        </>
      )}
      <Typography.Paragraph type="secondary" className="field-note overview-pending-note">
        {t('overview.pending.note')}
      </Typography.Paragraph>
    </Card>
  );
}
