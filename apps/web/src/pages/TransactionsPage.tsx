import { InfoCircleOutlined, PlusOutlined, RetweetOutlined, SearchOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { Button, Card, DatePicker, Input, Segmented, Select, Space, Switch, Table, Tag, Tooltip, Typography, type TableColumnsType } from 'antd';
import dayjs from 'dayjs';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import { HIDDEN_TAG, OUTFLOW_TYPES, TRANSACTION_TYPES, TX_FLOWS, type TransactionDto, type TxFlow } from '@z-ui/shared';
import { get } from '../api/client.ts';
import { useConfig, useTransactions, type TxFilters } from '../api/hooks.ts';
import { useCustomColumns } from '../components/CustomFields.tsx';
import { MoneyText } from '../components/Money.tsx';
import { TransactionModal } from '../components/TransactionModal.tsx';
import { VerificationMark } from '../components/TxRow.tsx';
import { PageTop } from '../layouts/PanelLayout.tsx';
import { useAccountOptions, useLookups } from '../lib/format.ts';

const SHOW_HIDDEN_KEY = 'zui-tx-hidden';
const FILTER_KEYS = ['accountId', 'institutionId', 'type', 'categoryId', 'tagId', 'from', 'to', 'q', 'currency'] as const;
/** The view lives in the URL (?flow=all); without it the page shows outflows. */
const flowOf = (params: URLSearchParams): TxFlow => (params.get('flow') === 'all' ? 'all' : 'outflow');
/** Types the outflow view can contain; picking another there would always give an empty list. */
const typeFits = (flow: TxFlow, type: string | null) => !!type && (flow === 'all' || (OUTFLOW_TYPES as readonly string[]).includes(type));

export function TransactionsPage() {
  const { t } = useTranslation();
  const L = useLookups();
  const accountOptions = useAccountOptions();
  const { data: cfg } = useConfig();
  const [params, setParams] = useSearchParams();
  const flow = flowOf(params);
  const [page, setPage] = useState(1);
  // Back to page 1 whenever the view changes, also through the browser's back/forward buttons.
  const [pageFlow, setPageFlow] = useState(flow);
  if (pageFlow !== flow) {
    setPageFlow(flow);
    setPage(1);
  }
  const [pageSize, setPageSize] = useState(30);
  const [modal, setModal] = useState<{ open: boolean; editing: TransactionDto | null }>({ open: false, editing: null });
  // ?tx=<id> (e.g. from a historical record) opens that entry.
  const txParam = params.get('tx');
  const { data: linkedTx } = useQuery({ queryKey: ['transaction', txParam], queryFn: () => get<TransactionDto>(`/transactions/${txParam}`), enabled: !!txParam });
  const shown = !modal.open && txParam && linkedTx ? { open: true, editing: linkedTx } : modal;
  const closeModal = () => {
    setModal({ open: false, editing: null });
    if (txParam) {
      const next = new URLSearchParams(params);
      next.delete('tx');
      setParams(next, { replace: true });
    }
  };
  const [search, setSearch] = useState(params.get('q') ?? '');
  // Small everyday spending tagged "hidden" stays out of the list unless shown (remembered).
  const [showHidden, setShowHidden] = useState(() => {
    try {
      return localStorage.getItem(SHOW_HIDDEN_KEY) === '1';
    } catch {
      return false;
    }
  });
  const toggleHidden = (on: boolean) => {
    setShowHidden(on);
    setPage(1);
    try {
      localStorage.setItem(SHOW_HIDDEN_KEY, on ? '1' : '0');
    } catch {
      /* private mode */
    }
  };
  const hiddenTag = L.tags.find((x) => x.name.toLowerCase() === HIDDEN_TAG);

  const filters: TxFilters = useMemo(() => {
    const f: TxFilters = { page, pageSize, flow: flowOf(params) };
    for (const k of FILTER_KEYS) {
      const v = params.get(k);
      if (v) f[k] = v;
    }
    // A type that cannot be an outflow (e.g. from an older link) is ignored rather than emptying the list.
    if (!typeFits(f.flow!, f.type ?? null)) delete f.type;
    // Filtering by the hidden tag itself obviously wants to see those.
    if (showHidden || (hiddenTag && f.tagId === hiddenTag.id)) f.hidden = '1';
    return f;
  }, [params, page, pageSize, showHidden, hiddenTag]);
  const { data, isFetching } = useTransactions(filters);

  const setFilter = (k: (typeof FILTER_KEYS)[number], v: string | null | undefined) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
    setPage(1);
  };

  /** Switch views as a new history entry, so back/forward moves between them. */
  const setFlow = (v: TxFlow) => {
    const next = new URLSearchParams(params);
    if (v === 'all') next.set('flow', 'all');
    else {
      next.delete('flow');
      if (!typeFits('outflow', next.get('type'))) next.delete('type');
    }
    setParams(next);
  };
  const typeParam = params.get('type');

  const customCols = useCustomColumns<TransactionDto>('transaction');
  const columns: TableColumnsType<TransactionDto> = [
    {
      key: 'date',
      title: t('common.date'),
      dataIndex: 'occurredAt',
      width: 110,
      render: (d: string, tx) => (
        <>
          <div>{d}</div>
          {tx.occurredTime && (
            <div className="muted" style={{ fontSize: 12 }} title={tx.timeZone ?? undefined}>
              {tx.occurredTime}
            </div>
          )}
        </>
      ),
    },
    {
      key: 'what',
      title: t('tx.counterparty'),
      render: (_, tx) => {
        const cat = tx.categoryId ? L.cat.get(tx.categoryId) : undefined;
        if (tx.type === 'transfer') {
          return (
            <span>
              <RetweetOutlined className="muted" />{' '}
              {tx.amount < 0 ? t('tx.transferTo', { name: L.accountLabel(tx.counterpartAccountId) }) : t('tx.transferFrom', { name: L.accountLabel(tx.counterpartAccountId) })}
              <VerificationMark status={tx.verificationStatus} />
              {tx.purpose && (
                <Typography.Text type="secondary" style={{ marginLeft: 6, fontSize: 12 }}>
                  {tx.purpose}
                </Typography.Text>
              )}
            </span>
          );
        }
        return (
          <span>
            {cat && (
              <Tag color={cat.color ?? undefined} style={{ marginInlineEnd: 6 }}>
                {cat.name}
              </Tag>
            )}
            {tx.counterparty || (!cat ? t(`tx.types.${tx.type}`) : '')}
            <VerificationMark status={tx.verificationStatus} />
            {tx.purpose && (
              <Typography.Text type="secondary" style={{ marginLeft: 6, fontSize: 12 }}>
                {tx.purpose}
              </Typography.Text>
            )}
            {tx.note && (
              <Typography.Text type="secondary" style={{ marginLeft: 6, fontSize: 12 }}>
                {tx.note}
              </Typography.Text>
            )}
          </span>
        );
      },
    },
    { key: 'account', title: t('tx.account'), render: (_, tx) => <span className="muted">{L.accountLabel(tx.accountId)}</span>, responsive: ['md'] },
    {
      key: 'tags',
      title: t('tx.tags'),
      responsive: ['lg'],
      render: (_, tx) =>
        tx.tagIds.map((id) => (
          <Tag key={id} color={L.tag.get(id)?.color ?? undefined}>
            {L.tag.get(id)?.name}
          </Tag>
        )),
    },
    ...customCols,
    {
      key: 'amount',
      title: t('common.amount'),
      align: 'right',
      render: (_, tx) => <MoneyText minor={tx.amount} currency={tx.currency} signed colored style={{ fontWeight: 600, whiteSpace: 'nowrap' }} />,
    },
  ];

  const range = params.get('from') && params.get('to') ? ([dayjs(params.get('from')), dayjs(params.get('to'))] as const) : null;

  return (
    <>
      <PageTop
        title={t('nav.transactions')}
        extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setModal({ open: true, editing: null })} disabled={L.accounts.length === 0}>
            {t('tx.add')}
          </Button>
        }
      />
      <Card styles={{ body: { paddingBottom: 8 } }} style={{ marginBottom: 16 }}>
        <Space wrap size={[8, 8]}>
          <Segmented<TxFlow> value={flow} onChange={setFlow} options={TX_FLOWS.map((k) => ({ value: k, label: t(`tx.flow.${k}`) }))} />
          <DatePicker.RangePicker
            value={range as never}
            onChange={(r) => {
              const next = new URLSearchParams(params);
              if (r?.[0] && r[1]) {
                next.set('from', r[0].format('YYYY-MM-DD'));
                next.set('to', r[1].format('YYYY-MM-DD'));
              } else {
                next.delete('from');
                next.delete('to');
              }
              setParams(next, { replace: true });
              setPage(1);
            }}
            presets={[
              { label: t('common.today'), value: [dayjs(), dayjs()] },
              { label: '7d', value: [dayjs().subtract(6, 'day'), dayjs()] },
              { label: dayjs().format('YYYY-MM'), value: [dayjs().startOf('month'), dayjs().endOf('month')] },
              { label: dayjs().subtract(1, 'month').format('YYYY-MM'), value: [dayjs().subtract(1, 'month').startOf('month'), dayjs().subtract(1, 'month').endOf('month')] },
              { label: dayjs().format('YYYY'), value: [dayjs().startOf('year'), dayjs().endOf('year')] },
            ]}
          />
          <Select
            allowClear
            placeholder={t('institution.title')}
            style={{ minWidth: 150 }}
            value={params.get('institutionId') ?? undefined}
            onChange={(v) => setFilter('institutionId', v)}
            options={L.institutions.map((i) => ({ value: i.id, label: i.name }))}
          />
          <Select allowClear placeholder={t('tx.account')} style={{ minWidth: 180 }} value={params.get('accountId') ?? undefined} onChange={(v) => setFilter('accountId', v)} options={accountOptions} />
          <Select
            allowClear
            placeholder={t('common.type')}
            style={{ minWidth: 110 }}
            value={typeFits(flow, typeParam) ? typeParam! : undefined}
            onChange={(v) => setFilter('type', v)}
            options={(flow === 'outflow' ? OUTFLOW_TYPES : TRANSACTION_TYPES).map((k) => ({ value: k, label: t(`tx.types.${k}`) }))}
          />
          <Select
            allowClear
            placeholder={t('common.currency')}
            style={{ minWidth: 90 }}
            value={params.get('currency') ?? undefined}
            onChange={(v) => setFilter('currency', v)}
            options={(cfg?.currencies ?? []).map((c) => ({ value: c.code, label: c.code }))}
          />
          <Select
            allowClear
            placeholder={t('tx.category')}
            style={{ minWidth: 130 }}
            value={params.get('categoryId') ?? undefined}
            onChange={(v) => setFilter('categoryId', v)}
            showSearch={{ optionFilterProp: 'label' }}
            // Income categories never hold outflows; keep the selected one so its name still shows.
            options={L.categories
              .filter((c) => flow === 'all' || c.kind !== 'income' || c.id === params.get('categoryId'))
              .map((c) => ({ value: c.id, label: c.name }))}
          />
          <Select
            allowClear
            placeholder={t('tx.tags')}
            style={{ minWidth: 110 }}
            value={params.get('tagId') ?? undefined}
            onChange={(v) => setFilter('tagId', v)}
            options={L.tags.map((x) => ({ value: x.id, label: x.name }))}
          />
          <Input
            allowClear
            prefix={<SearchOutlined />}
            placeholder={t('tx.filters.search')}
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              if (!e.target.value) setFilter('q', null);
            }}
            onPressEnter={() => setFilter('q', search.trim())}
            style={{ width: 200 }}
          />
          <Tooltip title={t('tx.hiddenHint')}>
            <label className="muted switch-label">
              <Switch size="small" checked={showHidden} onChange={toggleHidden} />
              {t('tx.showHidden')}
            </label>
          </Tooltip>
        </Space>
        {flow === 'outflow' && (
          <div className="muted" data-testid="outflow-hint" style={{ marginTop: 12, fontSize: 13 }}>
            <InfoCircleOutlined /> {t('tx.flow.outflowHint')}
          </div>
        )}
        {flow === 'all' && data && data.sums.length > 0 && (
          <div data-testid="tx-sums" style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 24px', marginTop: 12, fontSize: 13 }}>
            <span className="muted">{t('tx.sums')}</span>
            {data.sums.map((s) => (
              <span key={s.currency}>
                <Tag style={{ marginInlineEnd: 6 }}>{s.currency}</Tag>
                <MoneyText minor={s.income} currency={s.currency} signed style={{ color: 'var(--income)' }} />
                <span className="muted"> / </span>
                <MoneyText minor={-s.expense} currency={s.currency} signed style={{ color: 'var(--expense)' }} />
              </span>
            ))}
          </div>
        )}
      </Card>
      <Card styles={{ body: { padding: 0 } }}>
        <Table<TransactionDto>
          rowKey="id"
          size="middle"
          loading={isFetching}
          columns={columns}
          dataSource={data?.items}
          onRow={(tx) => ({ onClick: () => setModal({ open: true, editing: tx }), style: { cursor: 'pointer' } })}
          pagination={{
            current: page,
            pageSize,
            total: data?.total ?? 0,
            showSizeChanger: true,
            pageSizeOptions: [30, 50, 100, 200],
            showTotal: (n) => t('common.total', { n }),
            onChange: (p, s) => {
              setPage(p);
              setPageSize(s);
            },
            style: { padding: '0 16px' },
          }}
          scroll={{ x: 640 }}
        />
      </Card>
      <TransactionModal open={shown.open} editing={shown.editing} defaults={{ accountId: params.get('accountId') ?? undefined }} onClose={closeModal} />
    </>
  );
}
