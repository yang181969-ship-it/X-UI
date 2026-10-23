import { ExportOutlined, InfoCircleOutlined, LinkOutlined, PlusOutlined, RetweetOutlined, SearchOutlined } from '@ant-design/icons';
import { useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  App,
  Button,
  Card,
  DatePicker,
  Descriptions,
  Drawer,
  Empty,
  Input,
  Modal,
  Popconfirm,
  Segmented,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
  type TableColumnsType,
} from 'antd';
import dayjs from 'dayjs';
import { useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router';
import {
  ARCHIVE_LINK_TYPES,
  ARCHIVE_RECORD_TYPES,
  ARCHIVE_STATUSES,
  DATE_PRECISIONS,
  VERIFICATION_STATUSES,
  archiveDateLabel,
  type ArchiveStatus,
  type HistoricalRecordDetailDto,
  type HistoricalRecordDto,
  type TransactionDto,
  type VerificationStatus,
} from '@z-ui/shared';
import { patch, post } from '../api/client.ts';
import { errorText, invalidateLedger, useArchive, useArchiveRecord, useTransactions, type ArchiveFilters } from '../api/hooks.ts';
import { ArchiveModal } from '../components/ArchiveModal.tsx';
import { MoneyText } from '../components/Money.tsx';
import { TransactionModal } from '../components/TransactionModal.tsx';
import { TxRow, VerificationMark } from '../components/TxRow.tsx';
import { PageTop } from '../layouts/PanelLayout.tsx';
import { useLookups } from '../lib/format.ts';

const FILTER_KEYS = ['recordType', 'datePrecision', 'verificationStatus', 'q'] as const;
type StatusView = ArchiveStatus | 'all';
/** The status view lives in the URL (?status=…); without it the page shows open records. */
const statusOf = (params: URLSearchParams): StatusView => {
  const s = params.get('status');
  return s === 'all' || (ARCHIVE_STATUSES as readonly string[]).includes(s ?? '') ? (s as StatusView) : 'open';
};

const STATUS_COLORS: Record<ArchiveStatus, string | undefined> = { open: 'blue', linked: 'cyan', converted: 'green', dismissed: undefined };
const fmtTime = (ms: number) => dayjs(ms).format('YYYY-MM-DD HH:mm');

/** "2024-03", "2024-03-05 14:30" … exactly as known; unknown dates say so. */
function RecordDate({ r }: { r: Pick<HistoricalRecordDto, 'datePrecision' | 'dateFrom' | 'dateTo' | 'occurredTime' | 'timeZone'> }) {
  const { t } = useTranslation();
  const label = archiveDateLabel(r);
  if (!label) return <Typography.Text type="secondary">{t('archive.unknownDate')}</Typography.Text>;
  return (
    <>
      <div>{label}</div>
      {r.occurredTime && (
        <div className="muted" style={{ fontSize: 12 }} title={r.timeZone ?? undefined}>
          {r.occurredTime}
          {r.timeZone ? ` ${r.timeZone}` : ''}
        </div>
      )}
      {r.datePrecision !== 'day' && (
        <div className="muted" style={{ fontSize: 12 }}>
          {t(`archive.precisions.${r.datePrecision}`)}
        </div>
      )}
    </>
  );
}

/** Amount of a record: signed by its kind for income / expense, plain otherwise. */
function RecordAmount({ r }: { r: HistoricalRecordDto }) {
  const { t } = useTranslation();
  if (r.amount === null || !r.currency) return <Typography.Text type="secondary">{t('archive.noAmount')}</Typography.Text>;
  const signed = r.recordType === 'expense' ? -r.amount : r.amount;
  const directional = r.recordType === 'expense' || r.recordType === 'income';
  return <MoneyText minor={directional ? signed : r.amount} currency={r.currency} signed={directional} colored={directional} style={{ fontWeight: 600, whiteSpace: 'nowrap' }} />;
}

export function ArchivePage() {
  const { t } = useTranslation();
  const L = useLookups();
  const [params, setParams] = useSearchParams();
  const status = statusOf(params);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(30);
  const [search, setSearch] = useState(params.get('q') ?? '');
  const [modal, setModal] = useState<{ open: boolean; editing: HistoricalRecordDto | null }>({ open: false, editing: null });
  const [selected, setSelected] = useState<string | null>(null);

  const filters: ArchiveFilters = useMemo(() => {
    const f: ArchiveFilters = { status, page, pageSize };
    for (const k of FILTER_KEYS) {
      const v = params.get(k);
      if (v) f[k] = v;
    }
    return f;
  }, [params, status, page, pageSize]);
  const { data, isFetching } = useArchive(filters);
  const filtered = FILTER_KEYS.some((k) => params.get(k));

  const setParam = (k: (typeof FILTER_KEYS)[number] | 'status', v: string | null | undefined) => {
    const next = new URLSearchParams(params);
    if (v && !(k === 'status' && v === 'open')) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: k !== 'status' });
    setPage(1);
  };

  const accountText = (r: HistoricalRecordDto) =>
    r.recordType === 'transfer'
      ? [r.fromAccountId, r.toAccountId].some(Boolean)
        ? `${L.accountLabel(r.fromAccountId) || '?'} → ${L.accountLabel(r.toAccountId) || '?'}`
        : ''
      : L.accountLabel(r.accountId);

  const columns: TableColumnsType<HistoricalRecordDto> = [
    { key: 'date', title: t('common.date'), width: 130, render: (_, r) => <RecordDate r={r} /> },
    {
      key: 'title',
      title: t('archive.recordTitle'),
      render: (_, r) => (
        <span>
          <Tag style={{ marginInlineEnd: 6 }}>{t(`archive.recordTypes.${r.recordType}`)}</Tag>
          {r.title}
          <VerificationMark status={r.verificationStatus} />
          {(r.counterparty || r.purpose) && (
            <Typography.Text type="secondary" style={{ marginLeft: 6, fontSize: 12 }}>
              {[r.counterparty, r.purpose].filter(Boolean).join(' · ')}
            </Typography.Text>
          )}
          {r.linkLostAt && r.status === 'open' && (
            <Tooltip title={t('archive.linkLost', { time: fmtTime(r.linkLostAt) })}>
              <LinkOutlined style={{ marginLeft: 6, color: 'var(--ant-color-warning)' }} />
            </Tooltip>
          )}
        </span>
      ),
    },
    { key: 'account', title: t('archive.account'), responsive: ['md'], render: (_, r) => <span className="muted">{accountText(r)}</span> },
    { key: 'status', title: t('archive.status'), responsive: ['sm'], render: (_, r) => <Tag color={STATUS_COLORS[r.status]}>{t(`archive.statuses.${r.status}`)}</Tag> },
    { key: 'amount', title: t('common.amount'), align: 'right', render: (_, r) => <RecordAmount r={r} /> },
  ];

  const counts = data?.counts;
  const statusOptions = ([...ARCHIVE_STATUSES, 'all'] as const).map((k) => ({
    value: k,
    label: k === 'all' || !counts ? t(`archive.statuses.${k}`) : `${t(`archive.statuses.${k}`)} ${counts[k]}`,
  }));

  return (
    <>
      <PageTop
        title={t('archive.title')}
        extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setModal({ open: true, editing: null })}>
            {t('archive.add')}
          </Button>
        }
      />
      <Card styles={{ body: { paddingBottom: 8 } }} style={{ marginBottom: 16 }}>
        <Space wrap size={[8, 8]}>
          <Segmented<StatusView> value={status} onChange={(v) => setParam('status', v)} options={statusOptions} />
          <Select
            allowClear
            placeholder={t('archive.recordType')}
            style={{ minWidth: 120 }}
            value={params.get('recordType') ?? undefined}
            onChange={(v) => setParam('recordType', v)}
            options={ARCHIVE_RECORD_TYPES.map((k) => ({ value: k, label: t(`archive.recordTypes.${k}`) }))}
          />
          <Select
            allowClear
            placeholder={t('archive.datePrecision')}
            style={{ minWidth: 120 }}
            value={params.get('datePrecision') ?? undefined}
            onChange={(v) => setParam('datePrecision', v)}
            options={DATE_PRECISIONS.map((k) => ({ value: k, label: t(`archive.precisions.${k}`) }))}
          />
          <Select
            allowClear
            placeholder={t('archive.verification')}
            style={{ minWidth: 120 }}
            value={params.get('verificationStatus') ?? undefined}
            onChange={(v) => setParam('verificationStatus', v)}
            options={VERIFICATION_STATUSES.map((k) => ({ value: k, label: t(`tx.verification.${k}`) }))}
          />
          <Input
            allowClear
            prefix={<SearchOutlined />}
            placeholder={t('archive.search')}
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              if (!e.target.value) setParam('q', null);
            }}
            onPressEnter={() => setParam('q', search.trim())}
            style={{ width: 240 }}
          />
        </Space>
        <div className="muted" data-testid="archive-hint" style={{ marginTop: 12, fontSize: 13 }}>
          <InfoCircleOutlined /> {t('archive.hint')}
        </div>
      </Card>
      <Card styles={{ body: { padding: 0 } }}>
        <Table<HistoricalRecordDto>
          rowKey="id"
          size="middle"
          loading={isFetching}
          columns={columns}
          dataSource={data?.items}
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={status === 'open' && !filtered ? t('archive.empty') : t('archive.emptyFiltered')} /> }}
          onRow={(r) => ({ onClick: () => setSelected(r.id), style: { cursor: 'pointer' } })}
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
      <ArchiveModal open={modal.open} editing={modal.editing} onClose={() => setModal({ open: false, editing: null })} onSaved={(r) => !modal.editing && setSelected(r.id)} />
      <RecordDrawer id={selected} onClose={() => setSelected(null)} onEdit={(r) => setModal({ open: true, editing: r })} />
    </>
  );
}

/** Details of one record and everything that can be done with it. */
function RecordDrawer({ id, onClose, onEdit }: { id: string | null; onClose: () => void; onEdit: (r: HistoricalRecordDto) => void }) {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const qc = useQueryClient();
  const L = useLookups();
  const { data: r } = useArchiveRecord(id);
  const [busy, setBusy] = useState<string | null>(null);
  const [linking, setLinking] = useState(false);
  const [txOpen, setTxOpen] = useState<TransactionDto | null>(null);
  const navigate = useNavigate();
  /** The transactions page on that day (every type), with the entry opened. */
  const openInTransactions = (tx: TransactionDto) => navigate(`/transactions?flow=all&from=${tx.occurredAt}&to=${tx.occurredAt}&tx=${tx.id}`);

  /** Archive-only actions refresh the archive; a conversion changes the ledger too. */
  const act = async (key: string, fn: () => Promise<unknown>, ledger = false) => {
    setBusy(key);
    try {
      await fn();
      if (ledger) await invalidateLedger(qc);
      else await Promise.all([qc.invalidateQueries({ queryKey: ['archive'] }), qc.invalidateQueries({ queryKey: ['archive-record'] })]);
      void message.success(t('common.saved'));
    } catch (e) {
      void message.error(errorText(e, t));
      // Changed meanwhile (or any refusal): show the record as it is now.
      await Promise.all([qc.invalidateQueries({ queryKey: ['archive'] }), qc.invalidateQueries({ queryKey: ['archive-record'] })]);
    } finally {
      setBusy(null);
    }
  };

  const row = (label: string, value: ReactNode) => (value === null || value === undefined || value === '' ? null : { key: label, label, children: value });
  const money = (amount: number | null, currency: string | null) => (amount !== null && currency ? <MoneyText minor={amount} currency={currency} /> : currency);
  const items = r
    ? [
        row(t('archive.recordType'), t(`archive.recordTypes.${r.recordType}`)),
        row(t('common.date'), <RecordDate r={r} />),
        row(t('archive.amount'), money(r.amount, r.currency)),
        r.recordType === 'transfer'
          ? row(t('archive.fromAccount'), L.accountLabel(r.fromAccountId) || null)
          : row(t('archive.account'), L.accountLabel(r.accountId) || null),
        r.recordType === 'transfer' ? row(t('archive.toAccount'), L.accountLabel(r.toAccountId) || null) : null,
        row(t('archive.toAmount'), money(r.toAmount, r.toCurrency)),
        row(t('archive.assetCode'), r.assetCode),
        row(t('archive.assetQuantity'), r.assetQuantity),
        // 0 = confirmed no fee; null = unknown (not shown).
        row(t('archive.fee'), r.feeAmount === 0 ? t('archive.feeNone') : money(r.feeAmount, r.feeCurrency)),
        row(t('archive.exchangeRate'), r.exchangeRate),
        row(t('tx.counterparty'), r.counterparty),
        row(t('tx.purpose'), r.purpose),
        row(t('tx.paymentChannel'), r.paymentChannel),
        row(t('tx.referenceNumber'), r.referenceNumber),
        row(t('tx.evidenceSource'), r.evidenceSource),
        row(t('common.note'), r.note),
        row(t('archive.status'), <Tag color={STATUS_COLORS[r.status]}>{t(`archive.statuses.${r.status}`)}</Tag>),
        row(t('archive.linkedTxId'), r.linkedTransactionId && <Typography.Text copyable code style={{ fontSize: 12 }}>{r.linkedTransactionId}</Typography.Text>),
        row(t('archive.convertedTime'), r.convertedAt && fmtTime(r.convertedAt)),
        row(t('common.details'), <span className="muted">{t('archive.createdAt', { time: fmtTime(r.createdAt) })}</span>),
      ].filter((x): x is NonNullable<typeof x> => !!x)
    : [];

  const convertible = r && !r.convertBlockers.includes('type');
  const blockers = r ? r.convertBlockers.filter((b) => b !== 'status') : [];
  const linkTypes = r ? ARCHIVE_LINK_TYPES[r.recordType] : [];

  return (
    <Drawer open={!!id} onClose={onClose} size={520} title={r?.title ?? ''} destroyOnHidden extra={r && <Button onClick={() => onEdit(r)}>{t('common.edit')}</Button>}>
      {r && (
        <div data-testid="archive-detail">
          {r.status === 'open' && r.linkLostAt && <Alert type="warning" showIcon title={t('archive.linkLost', { time: fmtTime(r.linkLostAt) })} style={{ marginBottom: 12 }} />}
          {r.status === 'converted' && <Alert type="success" showIcon title={t('archive.convertedLocked')} description={r.convertedAt ? t('archive.convertedAt', { time: fmtTime(r.convertedAt) }) : undefined} style={{ marginBottom: 12 }} />}
          {(r.recordType === 'investment' || r.recordType === 'crypto') && <Alert type="info" showIcon title={t('archive.deferred')} style={{ marginBottom: 12 }} />}

          <Space orientation="vertical" size={4} style={{ marginBottom: 12 }}>
            <Typography.Text type="secondary">{t('archive.verification')}</Typography.Text>
            <Segmented<VerificationStatus>
              value={r.verificationStatus}
              disabled={r.status === 'converted' || busy !== null}
              onChange={(v) => act('verify', () => patch(`/archive/${r.id}/verification`, { verificationStatus: v, version: r.version }))}
              options={VERIFICATION_STATUSES.map((k) => ({ value: k, label: t(`tx.verification.${k}`) }))}
            />
          </Space>

          <Descriptions column={1} size="small" bordered items={items} style={{ marginBottom: 16 }} />

          {r.linkedTransactions.length > 0 && (
            <Card
              size="small"
              title={t('archive.linkedTx')}
              extra={
                <Button size="small" type="link" icon={<ExportOutlined />} onClick={() => openInTransactions(r.linkedTransactions[0]!)}>
                  {t('archive.openTx')}
                </Button>
              }
              style={{ marginBottom: 16 }}
              styles={{ body: { padding: 4 } }}
            >
              {r.linkedTransactions.map((tx) => (
                <TxRow key={tx.id} tx={tx} onClick={() => setTxOpen(tx)} />
              ))}
            </Card>
          )}

          <Space wrap>
            {r.status === 'open' && convertible && (
              <Popconfirm title={t('archive.convertConfirm')} onConfirm={() => act('convert', () => post(`/archive/${r.id}/convert`, { version: r.version }), true)} disabled={blockers.length > 0}>
                <Button type="primary" icon={<RetweetOutlined />} disabled={blockers.length > 0} loading={busy === 'convert'}>
                  {t('archive.convert')}
                </Button>
              </Popconfirm>
            )}
            {r.status === 'open' && linkTypes.length > 0 && (
              <Button icon={<LinkOutlined />} onClick={() => setLinking(true)}>
                {t('archive.link')}
              </Button>
            )}
            {r.status === 'open' && (
              <Popconfirm title={t('archive.dismissConfirm')} onConfirm={() => act('dismiss', () => post(`/archive/${r.id}/dismiss`, { version: r.version }))}>
                <Button loading={busy === 'dismiss'}>{t('archive.dismiss')}</Button>
              </Popconfirm>
            )}
            {r.status === 'dismissed' && (
              <Button loading={busy === 'reopen'} onClick={() => act('reopen', () => post(`/archive/${r.id}/reopen`, { version: r.version }))}>
                {t('archive.reopen')}
              </Button>
            )}
            {r.status === 'linked' && (
              <Popconfirm title={t('archive.unlinkConfirm')} onConfirm={() => act('unlink', () => post(`/archive/${r.id}/unlink`, { version: r.version }))}>
                <Button loading={busy === 'unlink'}>{t('archive.unlink')}</Button>
              </Popconfirm>
            )}
          </Space>
          {r.status === 'open' && convertible && blockers.length > 0 && (
            <div data-testid="convert-blockers" className="muted" style={{ marginTop: 12, fontSize: 13 }}>
              {t('archive.convertBlocked')}
              <ul style={{ margin: '4px 0 0', paddingInlineStart: 20 }}>
                {blockers.map((b) => (
                  <li key={b}>{t(`archive.blockers.${b}`)}</li>
                ))}
              </ul>
            </div>
          )}
          {linking && <LinkModal record={r} onClose={() => setLinking(false)} />}
          <TransactionModal open={!!txOpen} editing={txOpen} onClose={() => setTxOpen(null)} />
        </div>
      )}
    </Drawer>
  );
}

/** Pick an existing transaction for a record: searched like the transactions page, only fitting types selectable. */
function LinkModal({ record, onClose }: { record: HistoricalRecordDetailDto; onClose: () => void }) {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const qc = useQueryClient();
  const L = useLookups();
  const allowed = ARCHIVE_LINK_TYPES[record.recordType];
  // Starts at the record's own dates when known — a search filter only, clear it to see everything.
  const [range, setRange] = useState<[string, string] | null>(record.dateFrom && record.dateTo ? [record.dateFrom, record.dateTo] : null);
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { data, isFetching } = useTransactions({ flow: 'all', q: q || undefined, from: range?.[0], to: range?.[1], type: allowed.length === 1 ? allowed[0] : undefined, page, pageSize: 10 });

  const link = async () => {
    if (!picked) return;
    setBusy(true);
    try {
      await post(`/archive/${record.id}/link`, { transactionId: picked, version: record.version });
      await Promise.all([qc.invalidateQueries({ queryKey: ['archive'] }), qc.invalidateQueries({ queryKey: ['archive-record'] })]);
      void message.success(t('common.saved'));
      onClose();
    } catch (e) {
      void message.error(errorText(e, t));
    } finally {
      setBusy(false);
    }
  };

  const columns: TableColumnsType<TransactionDto> = [
    { key: 'date', title: t('common.date'), dataIndex: 'occurredAt', width: 105 },
    {
      key: 'what',
      title: t('tx.counterparty'),
      render: (_, tx) =>
        tx.type === 'transfer'
          ? tx.amount < 0
            ? t('tx.transferTo', { name: L.accountLabel(tx.counterpartAccountId) })
            : t('tx.transferFrom', { name: L.accountLabel(tx.counterpartAccountId) })
          : [tx.counterparty || t(`tx.types.${tx.type}`), tx.purpose].filter(Boolean).join(' · '),
    },
    { key: 'account', title: t('tx.account'), render: (_, tx) => <span className="muted">{L.accountLabel(tx.accountId)}</span>, responsive: ['md'] },
    { key: 'amount', title: t('common.amount'), align: 'right', render: (_, tx) => <MoneyText minor={tx.amount} currency={tx.currency} signed colored /> },
  ];

  return (
    <Modal open onCancel={onClose} title={t('archive.linkTitle')} width={720} okText={t('archive.link')} cancelText={t('common.cancel')} onOk={link} okButtonProps={{ disabled: !picked, loading: busy }}>
      <Typography.Paragraph type="secondary" style={{ fontSize: 13 }}>
        {t('archive.linkHint')} {t('archive.linkTypes', { types: allowed.map((k) => t(`tx.types.${k}`)).join(' / ') })}
      </Typography.Paragraph>
      <Space wrap style={{ marginBottom: 12 }}>
        <DatePicker.RangePicker
          value={range ? [dayjs(range[0]), dayjs(range[1])] : null}
          onChange={(v) => {
            setRange(v?.[0] && v[1] ? [v[0].format('YYYY-MM-DD'), v[1].format('YYYY-MM-DD')] : null);
            setPage(1);
          }}
        />
        <Input
          allowClear
          prefix={<SearchOutlined />}
          placeholder={t('tx.filters.search')}
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            if (!e.target.value) setQ('');
          }}
          onPressEnter={() => (setQ(search.trim()), setPage(1))}
          style={{ width: 220 }}
        />
      </Space>
      <Table<TransactionDto>
        rowKey="id"
        size="small"
        loading={isFetching}
        columns={columns}
        dataSource={data?.items}
        rowSelection={{ type: 'radio', selectedRowKeys: picked ? [picked] : [], onChange: (keys) => setPicked((keys[0] as string) ?? null), getCheckboxProps: (tx) => ({ disabled: !allowed.includes(tx.type) }) }}
        onRow={(tx) => ({ onClick: () => allowed.includes(tx.type) && setPicked(tx.id), style: { cursor: allowed.includes(tx.type) ? 'pointer' : 'not-allowed' } })}
        pagination={{ current: page, pageSize: 10, total: data?.total ?? 0, onChange: setPage, showSizeChanger: false }}
        scroll={{ x: 560 }}
      />
    </Modal>
  );
}
