import { PlusOutlined } from '@ant-design/icons';
import { Alert, Button, Card, Empty, Segmented, Skeleton, Space, Table, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { TransactionListItem } from '@xui/ledger-shared';
import { useCallback, useMemo, type HTMLAttributes } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate, useSearchParams } from 'react-router';
import { errorText, useMe } from '../api/hooks.ts';
import { NEW_TRANSACTION_PATH, transactionHref, useTransactionList } from '../api/transactions.ts';
import { browserSessionStorage, listPendingWrites } from '../lib/pendingWrite.ts';
import { TxnStatusTags } from '../components/TxnStatusTags.tsx';
import { PageTop } from '../layouts/PanelLayout.tsx';
import { applyQuickView, filtersToParams, filtersToQuery, parseFilters, QUICK_VIEWS, quickViewOf, type QuickView, type TxnFilters } from '../lib/transactionFilters.ts';
import { useNarrow } from '../lib/useMedia.ts';
import { TransactionFilters } from './transactions/TransactionFilters.tsx';
import { dateOf, EntryLine, EventAmount, subjectOf, typeLabel } from './transactions/txnDisplay.tsx';

/**
 * 流水 (/transactions, PRODUCT_SPEC §7.10, API_SPEC §5.3): the current version of each transaction in
 * the server's fixed order (date, time, created, id — all descending), keyset pages with "load more".
 * Filters live in the URL, so a refresh or a shared link restores them. Each amount is shown in its
 * own currency; there is no total, count or conversion of any kind. Desktop: a table; ≤ 768 px: cards.
 */
export function TransactionsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const narrow = useNarrow();
  const [params, setParams] = useSearchParams();
  const filters = useMemo(() => parseFilters(params), [params]);
  const query = useMemo(() => filtersToQuery(filters), [filters]);
  const { data, isLoading, isError, error, hasNextPage, fetchNextPage, isFetchingNextPage, isPlaceholderData } = useTransactionList(query);
  const items = useMemo(() => data?.pages.flatMap((p) => p.items) ?? [], [data]);
  const setFilters = useCallback((next: TxnFilters) => setParams(filtersToParams(next), { replace: true }), [setParams]);
  const view = quickViewOf(filters);
  const filtered = Object.keys(filters).some((k) => k !== 'limit');
  const open = (id: string) => navigate(transactionHref(id), { state: { from: location.search } });
  // A create whose outcome is unknown (kept in this tab's sessionStorage): point to the form that can resolve it.
  const { data: me } = useMe();
  const unresolved = useMemo(() => (me ? listPendingWrites(browserSessionStorage(), me.user.id).filter((p) => p.operation === 'transaction.create') : []), [me]);

  const columns: ColumnsType<TransactionListItem> = [
    { key: 'date', title: t('transactions.columns.date'), width: 130, render: (_, r) => <span className="num">{dateOf(r.event)}</span> },
    {
      key: 'type',
      title: t('transactions.columns.type'),
      width: 190,
      render: (_, r) => (
        <div className="row-main">
          <div className="row-title">{typeLabel(r, t)}</div>
          <div className="row-sub">{subjectOf(r, t) ?? '—'}</div>
        </div>
      ),
    },
    {
      key: 'entries',
      title: t('transactions.columns.entries'),
      render: (_, r) => (
        <div className="txn-entries">
          {r.entries.map((e) => (
            <EntryLine key={e.entryId} entry={e} />
          ))}
        </div>
      ),
    },
    { key: 'event', title: t('transactions.columns.event'), width: 170, align: 'right', render: (_, r) => <EventAmount event={r.event} /> },
    { key: 'tags', title: t('transactions.columns.tags'), width: 230, render: (_, r) => <TxnStatusTags txn={r} /> },
  ];

  const empty = <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={filtered ? t('transactions.emptyFiltered') : t('transactions.empty')} />;

  return (
    <>
      <PageTop
        title={t('nav.transactions')}
        extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={() => navigate(NEW_TRANSACTION_PATH)} className="txn-new">
            {t('transactions.form.new')}
          </Button>
        }
      />
      {unresolved.length > 0 && (
        <Alert
          type="warning"
          showIcon
          className="form-alert txn-unresolved"
          title={t('transactions.form.unresolvedTitle')}
          action={
            <Space>
              <Button size="small" onClick={() => navigate(NEW_TRANSACTION_PATH)}>
                {t('transactions.form.unresolvedOpen')}
              </Button>
            </Space>
          }
        />
      )}
      <Typography.Paragraph type="secondary" className="page-desc">
        {t('transactions.desc')}
      </Typography.Paragraph>
      <Card
        title={t('transactions.list')}
        className="txn-list-card"
        extra={
          <Segmented<QuickView>
            className="txn-quick"
            aria-label={t('transactions.list')}
            // No quick view matches hand-set status / amount filters: none is highlighted (an uncontrolled Segmented would show "all").
            value={(view ?? '') as QuickView}
            onChange={(v) => setFilters(applyQuickView(filters, v))}
            options={QUICK_VIEWS.map((v) => ({ value: v, label: t(`transactions.quick.${v}`) }))}
          />
        }
      >
        <TransactionFilters filters={filters} onChange={setFilters} narrow={narrow} />
        {isError && <Alert type="error" showIcon title={errorText(error, t)} className="form-alert" />}
        {narrow ? (
          <div className={`txn-cards ${isPlaceholderData ? 'is-stale' : ''}`}>
            {isLoading && <Skeleton active paragraph={{ rows: 4 }} />}
            {!isLoading && items.length === 0 && empty}
            {items.map((r) => (
              <TxnCard key={r.id} txn={r} onOpen={() => open(r.id)} />
            ))}
          </div>
        ) : (
          <Table<TransactionListItem>
            className="txn-table"
            rowKey="id"
            size="middle"
            loading={isLoading || (isPlaceholderData && !isFetchingNextPage)}
            dataSource={items}
            pagination={false}
            scroll={{ x: 980 }}
            locale={{ emptyText: empty }}
            rowClassName={(r) => `clickable-row ${r.status === 'voided' ? 'is-voided' : ''}`}
            onRow={(r) => ({ onClick: () => open(r.id), 'data-txn': r.id }) as HTMLAttributes<HTMLElement>}
            columns={columns}
          />
        )}
        <div className="txn-list-foot">
          {hasNextPage ? (
            <Button onClick={() => void fetchNextPage()} loading={isFetchingNextPage} className="txn-load-more">
              {t('transactions.loadMore')}
            </Button>
          ) : (
            items.length > 0 && <span className="muted txn-all-loaded">{t('transactions.allLoaded')}</span>
          )}
          <Typography.Text type="secondary" className="field-note">
            {t('transactions.noTotal')}
          </Typography.Text>
        </div>
      </Card>
    </>
  );
}

/** One transaction as a card (narrow screens). */
function TxnCard({ txn, onOpen }: { txn: TransactionListItem; onOpen: () => void }) {
  const { t } = useTranslation();
  return (
    <div
      className={`txn-card ${txn.status === 'voided' ? 'is-voided' : ''}`}
      data-txn={txn.id}
      role="link"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onOpen();
      }}
    >
      <div className="txn-card-head">
        <span className="row-title">{typeLabel(txn, t)}</span>
        <span className="num muted">{dateOf(txn.event)}</span>
      </div>
      <div className="row-sub">{subjectOf(txn, t) ?? '—'}</div>
      <div className="txn-entries">
        {txn.entries.map((e) => (
          <EntryLine key={e.entryId} entry={e} />
        ))}
      </div>
      <div className="txn-card-foot">
        <span className="muted">
          {t('transactions.eventAmount')} <EventAmount event={txn.event} />
        </span>
        <TxnStatusTags txn={txn} />
      </div>
    </div>
  );
}
