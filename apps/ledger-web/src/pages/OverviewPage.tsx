import { PlusOutlined } from '@ant-design/icons';
import { Alert, Button, Card, Col, Empty, Row, Skeleton, Tag, Typography } from 'antd';
import type { TransactionSummaryDto } from '@xui/ledger-shared';
import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router';
import { errorText } from '../api/hooks.ts';
import { NEW_TRANSACTION_PATH, useTransactionList, useTransactionSummary } from '../api/transactions.ts';
import { PageTop } from '../layouts/PanelLayout.tsx';
import { localToday, parsePeriod, periodQuery, periodToParams, type Period } from '../lib/period.ts';
import { currencyCards, mixedHomeRegions, pendingEntryCount } from '../lib/summaryView.ts';
import { filtersToParams } from '../lib/transactionFilters.ts';
import { useNarrow } from '../lib/useMedia.ts';
import { CurrencyStatCard } from './overview/CurrencyStatCard.tsx';
import { PendingCard } from './overview/PendingCard.tsx';
import { PeriodPicker } from './overview/PeriodPicker.tsx';
import { RecentCard } from './overview/RecentCard.tsx';

const RECENT = 5;

/**
 * 总览 (PRODUCT_SPEC §7.7, §7.10; API_SPEC §5.10; M3-B5-B). Everything comes from the server:
 * GET /transactions/summary for the period (the three blocks, pending counts, the two distinct
 * transaction counts, the saved home regions) and GET /transactions for the latest transactions.
 * Amounts are per original currency and saved exponent, exact decimal strings formatted as text —
 * never added across currencies, converted, netted (refunds vs spending, the two sides of an own
 * transfer) or estimated (pending). There is no balance anywhere.
 *
 * The period lives in the URL (`period`, `from`, `to`); changing it pushes a history entry so back
 * and forward step through periods.
 */
export function OverviewPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const narrow = useNarrow();
  const [params, setParams] = useSearchParams();
  const today = localToday();
  const period = useMemo(() => parsePeriod(params, today), [params, today]);
  const bounds = useMemo(() => periodQuery(period), [period]);
  const setPeriod = useCallback((p: Period) => setParams(periodToParams(p)), [setParams]);

  const summaryQ = useTransactionSummary(bounds);
  const recentQ = useTransactionList({ ...bounds, limit: String(RECENT) });
  const recent = useMemo(() => recentQ.data?.pages[0]?.items.slice(0, RECENT) ?? [], [recentQ.data]);
  const s = summaryQ.data;
  const stale = summaryQ.isPlaceholderData;

  const listHref = (extra: { amountStatus?: 'pending' } = {}) => `/transactions?${filtersToParams({ ...bounds, ...extra }).toString()}`;
  const latest = recent[0]?.event.occurredOn ?? null;

  return (
    <>
      <PageTop
        title={t('nav.overview')}
        extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={() => navigate(NEW_TRANSACTION_PATH)} className="overview-new">
            {t('transactions.form.new')}
          </Button>
        }
      />
      <Typography.Paragraph type="secondary" className="page-desc">
        {t('overview.desc')}
      </Typography.Paragraph>
      <PeriodPicker period={period} today={today} narrow={narrow} onChange={setPeriod} />

      {summaryQ.isError && <Alert type="error" showIcon title={errorText(summaryQ.error, t)} className="form-alert" />}
      {!s && summaryQ.isLoading && <Skeleton active paragraph={{ rows: 6 }} />}

      {s && (
        <div className={`overview-body ${stale ? 'is-stale' : ''}`} aria-busy={stale}>
          {mixedHomeRegions(s) && <Alert type="info" showIcon className="form-alert overview-home-regions" title={t('overview.homeRegions', { list: s.homeRegions.join('、') })} />}

          <Row gutter={[16, 16]} className="overview-metrics">
            <Col xs={24} sm={8}>
              <Metric className="metric-transactions" label={t('overview.metrics.transactions')} value={String(s.transactionCount)} hint={t('overview.metrics.transactionsHint')} />
            </Col>
            <Col xs={24} sm={8}>
              <Metric
                className="metric-pending"
                label={t('overview.metrics.pending')}
                value={String(s.pendingTransactionCount)}
                hint={s.pendingTransactionCount ? t('overview.metrics.pendingHint', { entries: pendingEntryCount(s.pending) }) : t('overview.metrics.pendingNone')}
              />
            </Col>
            <Col xs={24} sm={8}>
              <Metric className="metric-latest" label={t('overview.metrics.lastOccurred')} value={recentQ.isLoading ? '…' : (latest ?? '—')} hint={t('overview.metrics.lastOccurredHint')} />
            </Col>
          </Row>

          <Block summary={s} block="foreign" title={t('overview.blocks.foreign')} empty={t('overview.foreignEmpty')} />
          <Block summary={s} block="undetermined" title={t('overview.blocks.undetermined')} empty={t('overview.undeterminedEmpty')} note={t('overview.undeterminedNote')} />
          <section className="overview-block" data-block="domestic">
            <h2 className="overview-block-title">{t('overview.blocks.domestic')}</h2>
            <Typography.Text type="secondary" className="overview-domestic-note">
              {t('overview.domesticNote')}
            </Typography.Text>
          </section>

          <Row gutter={[16, 16]} className="overview-lower">
            <Col xs={24} xl={10}>
              <PendingCard summary={s} href={listHref({ amountStatus: 'pending' })} />
            </Col>
            <Col xs={24} xl={14}>
              <RecentCard items={recent} loading={recentQ.isLoading} error={recentQ.isError ? recentQ.error : null} href={listHref()} />
            </Col>
          </Row>
        </div>
      )}
    </>
  );
}

function Metric({ label, value, hint, className }: { label: string; value: string; hint: string; className: string }) {
  return (
    <Card size="small" className={`overview-metric ${className}`}>
      <div className="muted overview-metric-label">{label}</div>
      <div className="overview-metric-value num">{value}</div>
      <div className="muted field-note">{hint}</div>
    </Card>
  );
}

/** One block (foreign / undetermined): a card per currency and saved exponent, or a one-line empty state. */
function Block({ summary, block, title, empty, note }: { summary: TransactionSummaryDto; block: 'foreign' | 'undetermined'; title: string; empty: string; note?: string }) {
  const { t } = useTranslation();
  const cards = currencyCards(summary[block]);
  return (
    <section className="overview-block" data-block={block}>
      <h2 className="overview-block-title">
        {title}
        <Tag className="overview-no-convert">{t('overview.noConvert')}</Tag>
      </h2>
      {note && (
        <Typography.Paragraph type="secondary" className="field-note overview-block-note">
          {note}
        </Typography.Paragraph>
      )}
      {cards.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} className="overview-block-empty" description={empty} />
      ) : (
        <Row gutter={[16, 16]}>
          {cards.map((c) => (
            <Col key={`${c.currency}#${c.exponent}`} xs={24} md={12} xxl={8}>
              <CurrencyStatCard card={c} block={block} />
            </Col>
          ))}
        </Row>
      )}
    </section>
  );
}
