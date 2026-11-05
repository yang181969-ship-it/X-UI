import { FilterOutlined, SearchOutlined } from '@ant-design/icons';
import { Badge, Button, DatePicker, Drawer, Input, Segmented, Select } from 'antd';
import { AMOUNT_STATUSES, RECORD_MODES, TXN_TYPES, type CurrencyCode } from '@xui/ledger-shared';
import dayjs from 'dayjs';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useAccounts } from '../../api/accounts.ts';
import { useCards } from '../../api/cards.ts';
import { useChannels } from '../../api/channels.ts';
import { currencyOptions } from '../../lib/currencies.ts';
import { OVERLAY_Z } from '../../lib/useMedia.ts';
import { activeFilterCount, LIST_FOREIGN_STATUSES, LIST_STATUSES, SEARCH_MAX, type ListStatus, type TxnFilters } from '../../lib/transactionFilters.ts';

const DATE = 'YYYY-MM-DD';
export const SEARCH_DEBOUNCE_MS = 300;

/**
 * The list filters (API_SPEC §5.3). Desktop: one wrapping row; narrow screens: the search box and a
 * "filters" button opening a drawer with the same controls. Every change goes straight to the URL
 * (the caller's onChange); the search text is debounced.
 */
export function TransactionFilters({ filters, onChange, narrow }: { filters: TxnFilters; onChange: (next: TxnFilters) => void; narrow: boolean }) {
  const { t, i18n } = useTranslation();
  const [drawer, setDrawer] = useState(false);
  // Options include closed / archived records: old transactions still use them.
  const { data: accounts = [] } = useAccounts({ status: 'all' });
  const { data: cards = [] } = useCards({ status: 'all' });
  const { data: channels = [] } = useChannels({ status: 'all' });
  const currencies = useMemo(() => currencyOptions(i18n.language), [i18n.language]);
  const set = (patch: Partial<TxnFilters>) => {
    const next = { ...filters, ...patch };
    for (const k of Object.keys(next) as (keyof TxnFilters)[]) if (next[k] === undefined || next[k] === '') delete next[k];
    onChange(next);
  };
  const count = activeFilterCount(filters);
  const width = (w: number) => (narrow ? { width: '100%' } : { width: w });

  const controls: ReactNode[] = [
    <DatePicker.RangePicker
      key="period"
      aria-label={t('transactions.filters.period')}
      placeholder={[t('transactions.filters.from'), t('transactions.filters.to')]}
      allowEmpty={[true, true]}
      value={[filters.from ? dayjs(filters.from, DATE) : null, filters.to ? dayjs(filters.to, DATE) : null]}
      onChange={(v) => set({ from: v?.[0]?.format(DATE), to: v?.[1]?.format(DATE) })}
      style={width(250)}
      inputReadOnly={narrow}
    />,
    <Select
      key="type"
      allowClear
      aria-label={t('transactions.filters.type')}
      placeholder={t('transactions.filters.allTypes')}
      value={filters.type}
      onChange={(v) => set({ type: v })}
      options={TXN_TYPES.map((v) => ({ value: v, label: t(`transactions.types.${v}`) }))}
      style={width(150)}
    />,
    <Select
      key="foreign"
      allowClear
      aria-label={t('transactions.filters.foreign')}
      placeholder={t('transactions.filters.allForeign')}
      value={filters.foreignStatus}
      onChange={(v) => set({ foreignStatus: v })}
      options={LIST_FOREIGN_STATUSES.map((v) => ({ value: v, label: t(`transactions.foreignStatus.${v}`) }))}
      style={width(150)}
    />,
    <Select
      key="amountStatus"
      allowClear
      aria-label={t('transactions.filters.amountStatus')}
      placeholder={t('transactions.filters.allAmountStatus')}
      value={filters.amountStatus}
      onChange={(v) => set({ amountStatus: v })}
      options={AMOUNT_STATUSES.map((v) => ({ value: v, label: t(`transactions.amountStatus.${v}`) }))}
      style={width(150)}
    />,
    <Select
      key="recordMode"
      allowClear
      aria-label={t('transactions.filters.recordMode')}
      placeholder={t('transactions.filters.allRecordModes')}
      value={filters.recordMode}
      onChange={(v) => set({ recordMode: v })}
      options={RECORD_MODES.map((v) => ({ value: v, label: t(`transactions.recordMode.${v}`) }))}
      style={width(150)}
    />,
    <Select<string>
      key="account"
      allowClear
      showSearch={{ optionFilterProp: 'label' }}
      aria-label={t('transactions.filters.account')}
      placeholder={t('transactions.filters.allAccounts')}
      value={filters.accountId}
      onChange={(v) => set({ accountId: v })}
      options={accounts.map((a) => ({ value: a.id, label: a.name }))}
      style={width(180)}
    />,
    <Select<string>
      key="card"
      allowClear
      showSearch={{ optionFilterProp: 'label' }}
      aria-label={t('transactions.filters.card')}
      placeholder={t('transactions.filters.allCards')}
      value={filters.cardId}
      onChange={(v) => set({ cardId: v })}
      options={cards.map((c) => ({ value: c.id, label: `${c.name} •••• ${c.last4}` }))}
      style={width(180)}
    />,
    <Select<string>
      key="channel"
      allowClear
      showSearch={{ optionFilterProp: 'label' }}
      aria-label={t('transactions.filters.channel')}
      placeholder={t('transactions.filters.allChannels')}
      value={filters.channelId}
      onChange={(v) => set({ channelId: v })}
      options={channels.map((c) => ({ value: c.id, label: c.name }))}
      style={width(170)}
    />,
    <Select<CurrencyCode>
      key="currency"
      allowClear
      showSearch={{ optionFilterProp: 'label' }}
      aria-label={t('transactions.filters.currency')}
      placeholder={t('transactions.filters.allCurrencies')}
      value={filters.currency}
      onChange={(v) => set({ currency: v })}
      options={currencies}
      style={width(160)}
    />,
    <Segmented<ListStatus>
      key="status"
      aria-label={t('transactions.filters.status')}
      value={filters.status ?? 'active'}
      onChange={(v) => set({ status: v === 'active' ? undefined : v })}
      options={LIST_STATUSES.map((s) => ({ value: s, label: t(`transactions.statusFilter.${s}`) }))}
    />,
  ];

  const search = <SearchBox key="q" value={filters.q ?? ''} onChange={(q) => set({ q: q || undefined })} narrow={narrow} />;
  const reset = (
    <Button key="reset" type="link" onClick={() => onChange(filters.limit ? { limit: filters.limit } : {})} disabled={count === 0 && !filters.q}>
      {t('transactions.filters.reset')}
    </Button>
  );

  if (!narrow) {
    return (
      <div className="filter-row txn-filter-row">
        {search}
        {controls}
        {reset}
      </div>
    );
  }
  return (
    <div className="txn-filter-bar">
      {search}
      <Badge count={count} size="small">
        <Button icon={<FilterOutlined />} onClick={() => setDrawer(true)} className="txn-filter-open">
          {count ? t('transactions.filters.openCount', { count }) : t('transactions.filters.open')}
        </Button>
      </Badge>
      <Drawer
        open={drawer}
        onClose={() => setDrawer(false)}
        placement="bottom"
        size="85%"
        title={t('transactions.filters.title')}
        className="txn-filter-drawer"
        zIndex={OVERLAY_Z}
        extra={
          <Button type="primary" onClick={() => setDrawer(false)}>
            {t('transactions.filters.done')}
          </Button>
        }
      >
        <div className="txn-filter-stack">
          {controls.map((c, i) => (
            <div key={i} className="txn-filter-field">
              {c}
            </div>
          ))}
          {reset}
        </div>
      </Drawer>
    </div>
  );
}

/** Search text, sent SEARCH_DEBOUNCE_MS after the last keystroke; follows the URL when it changes elsewhere. */
function SearchBox({ value, onChange, narrow }: { value: string; onChange: (q: string) => void; narrow: boolean }) {
  const { t } = useTranslation();
  const [text, setText] = useState(value);
  const sent = useRef(value);
  // The latest callback, so a parent re-render never restarts the debounce timer.
  const send = useRef(onChange);
  send.current = onChange;
  useEffect(() => {
    if (value !== sent.current) {
      sent.current = value;
      setText(value);
    }
  }, [value]);
  useEffect(() => {
    const q = text.trim();
    if (q === sent.current) return;
    const timer = setTimeout(() => {
      sent.current = q;
      send.current(q);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text]);
  return (
    <Input
      allowClear
      prefix={<SearchOutlined />}
      placeholder={t('transactions.filters.search')}
      aria-label={t('transactions.filters.search')}
      value={text}
      onChange={(e) => setText(e.target.value)}
      maxLength={SEARCH_MAX}
      style={narrow ? { flex: 1, minWidth: 0 } : { width: 240 }}
      className="txn-search"
    />
  );
}
