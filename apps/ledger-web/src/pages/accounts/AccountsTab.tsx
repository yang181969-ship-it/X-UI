import { DeleteOutlined, EditOutlined, PauseCircleOutlined, PlayCircleOutlined, PlusOutlined, SearchOutlined, StopOutlined, UndoOutlined } from '@ant-design/icons';
import { Button, Card, Empty, Input, Segmented, Select, Space, Table, Tag, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  ACCOUNT_STATUSES,
  ACCOUNT_TYPES,
  type AccountDto,
  type AccountListItem,
  type AccountListQuery,
  type AccountStatus,
  type AccountType,
  type CountryCode,
  type CurrencyCode,
} from '@xui/ledger-shared';
import { useDeferredValue, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { useAccounts } from '../../api/accounts.ts';
import { useInstitutions } from '../../api/institutions.ts';
import { CurrencyTags } from '../../components/CurrencyTags.tsx';
import { InstitutionAvatar } from '../../components/InstitutionAvatar.tsx';
import { currencyOptions } from '../../lib/currencies.ts';
import { regionName, regionOptions } from '../../lib/regions.ts';
import { AccountFormModal } from './AccountFormModal.tsx';
import { useAccountActions } from './useAccountActions.ts';

/** Status filter: 'open' (the default) = not closed, i.e. active and frozen. */
const STATUS_FILTERS = ['open', ...ACCOUNT_STATUSES, 'all'] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];
type View = 'grouped' | 'flat';

const VIEW_KEY = 'xui-v1-accounts-view';
function storedView(): View {
  try {
    return localStorage.getItem(VIEW_KEY) === 'flat' ? 'flat' : 'grouped';
  } catch {
    return 'grouped';
  }
}

export function AccountStatusTag({ status }: { status: AccountStatus }) {
  const { t } = useTranslation();
  const color = status === 'active' ? 'green' : status === 'frozen' ? 'orange' : undefined;
  return <Tag color={color}>{t(`accounts.statuses.${status}`)}</Tag>;
}

/** "银行账户 · 储蓄 · 尾号 1234"-style subtitle. */
export function accountSubtitle(a: Pick<AccountDto, 'accountType' | 'depositKind' | 'numberHint'>, t: (k: string) => string): string {
  return [t(`accounts.types.${a.accountType}`), a.depositKind && t(`accounts.depositKinds.${a.depositKind}`), a.numberHint && `•••• ${a.numberHint}`].filter(Boolean).join(' · ');
}

/** 账户 → 账户: grouped-by-institution or flat list, search and filters, create / edit, status actions. */
export function AccountsTab() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [institutionId, setInstitutionId] = useState<string | undefined>();
  const [country, setCountry] = useState<CountryCode | undefined>();
  const [currency, setCurrency] = useState<CurrencyCode | undefined>();
  const [type, setType] = useState<AccountType | undefined>();
  const [status, setStatus] = useState<StatusFilter>('open');
  const [view, setView] = useState<View>(storedView);
  const q = useDeferredValue(search.trim());
  const filters: AccountListQuery = { q: q || undefined, institutionId, country, currency, type, status: status === 'open' ? undefined : status };
  const { data = [], isLoading } = useAccounts(filters);
  const filtered = !!(q || institutionId || country || currency || type || status !== 'open');
  const { data: institutions = [] } = useInstitutions({ status: 'all' });

  const [form, setForm] = useState<{ open: boolean; editing: AccountDto | null; institutionId?: string }>({ open: false, editing: null });
  const { freeze, activate, close, remove } = useAccountActions();
  const countries = useMemo(() => regionOptions(i18n.language), [i18n.language]);
  const currencies = useMemo(() => currencyOptions(i18n.language), [i18n.language]);

  const changeView = (v: View) => {
    setView(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* ignore */
    }
  };

  const columns = (withInstitution: boolean): ColumnsType<AccountListItem> => [
    {
      key: 'name',
      title: t('accounts.name'),
      render: (_, r) => (
        <div className="row-main">
          <div className="row-title">{r.name}</div>
          <div className="row-sub">{accountSubtitle(r, t)}</div>
        </div>
      ),
    },
    ...(withInstitution
      ? [
          {
            key: 'institution',
            title: t('accounts.institution'),
            width: 200,
            render: (_: unknown, r: AccountListItem) => (
              <span className="institution-option">
                <InstitutionAvatar name={r.institution.name} color={r.institution.color} size={22} />
                {r.institution.name}
              </span>
            ),
          },
        ]
      : []),
    { key: 'country', title: t('accounts.country'), width: 170, render: (_, r) => `${regionName(r.accountCountry, i18n.language)} (${r.accountCountry})` },
    { key: 'currencies', title: t('accounts.currencies'), width: 230, render: (_, r) => <CurrencyTags currencies={r.currencies} /> },
    {
      key: 'cards',
      title: t('accounts.linkedCards'),
      width: 110,
      render: (_, r) => (r.linkedCardCount ? t('accounts.linkedCardCount', { count: r.linkedCardCount }) : <span className="muted">—</span>),
    },
    { key: 'status', title: t('accounts.status'), width: 90, render: (_, r) => <AccountStatusTag status={r.status} /> },
    {
      key: 'actions',
      width: 150,
      align: 'right',
      render: (_, r) => (
        // Buttons act on the row without opening the details.
        <Space size={0} onClick={(e) => e.stopPropagation()}>
          <ActionButton title={t('accounts.edit')} icon={<EditOutlined />} onClick={() => setForm({ open: true, editing: r })} />
          {r.status === 'active' && <ActionButton title={t('accounts.freeze')} icon={<PauseCircleOutlined />} onClick={() => freeze(r)} />}
          {r.status === 'frozen' && <ActionButton title={t('accounts.unfreeze')} icon={<PlayCircleOutlined />} onClick={() => activate(r)} />}
          {r.status === 'closed' ? (
            <ActionButton title={t('accounts.reopen')} icon={<UndoOutlined />} onClick={() => activate(r)} />
          ) : (
            <ActionButton title={t('accounts.close')} icon={<StopOutlined />} onClick={() => close(r)} />
          )}
          <ActionButton title={t('accounts.delete')} icon={<DeleteOutlined />} danger onClick={() => remove(r)} />
        </Space>
      ),
    },
  ];

  const empty = <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={filtered ? t('accounts.emptyFiltered') : t('accounts.empty')} />;
  const table = (rows: AccountListItem[], withInstitution: boolean) => (
    <Table<AccountListItem>
      className="account-table"
      rowKey="id"
      size="middle"
      loading={isLoading}
      dataSource={rows}
      pagination={rows.length > 50 ? { pageSize: 50, showSizeChanger: false } : false}
      scroll={{ x: withInstitution ? 1060 : 860 }}
      locale={{ emptyText: empty }}
      onRow={(r) => ({ onClick: () => navigate(`/accounts/${encodeURIComponent(r.id)}`), className: 'clickable-row' })}
      columns={columns(withInstitution)}
    />
  );

  // Grouped view: one section per institution, institutions in name order.
  const groups = useMemo(() => {
    const map = new Map<string, { institution: AccountListItem['institution']; items: AccountListItem[] }>();
    for (const a of data) {
      const g = map.get(a.institutionId) ?? { institution: a.institution, items: [] };
      g.items.push(a);
      map.set(a.institutionId, g);
    }
    const collator = new Intl.Collator(i18n.language);
    return [...map.values()].sort((a, b) => collator.compare(a.institution.name, b.institution.name));
  }, [data, i18n.language]);

  return (
    <Card
      title={t('accounts.list')}
      extra={
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setForm({ open: true, editing: null })}>
          {t('accounts.add')}
        </Button>
      }
    >
      <Typography.Paragraph type="secondary">{t('accounts.desc')}</Typography.Paragraph>
      <div className="filter-row">
        <Input
          allowClear
          prefix={<SearchOutlined />}
          placeholder={t('accounts.search')}
          aria-label={t('accounts.search')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          maxLength={80}
          style={{ width: 230 }}
        />
        <Select<string>
          allowClear
          showSearch={{ optionFilterProp: 'label' }}
          aria-label={t('accounts.institution')}
          placeholder={t('accounts.allInstitutions')}
          value={institutionId}
          onChange={setInstitutionId}
          options={institutions.map((i) => ({ value: i.id, label: i.name }))}
          style={{ width: 190 }}
        />
        <Select<CountryCode>
          allowClear
          showSearch={{ optionFilterProp: 'label' }}
          aria-label={t('accounts.country')}
          placeholder={t('accounts.allCountries')}
          value={country}
          onChange={setCountry}
          options={countries}
          style={{ width: 190 }}
        />
        <Select<CurrencyCode>
          allowClear
          showSearch={{ optionFilterProp: 'label' }}
          aria-label={t('accounts.currencies')}
          placeholder={t('accounts.allCurrencies')}
          value={currency}
          onChange={setCurrency}
          options={currencies}
          style={{ width: 170 }}
        />
        <Select<AccountType>
          allowClear
          aria-label={t('accounts.type')}
          placeholder={t('accounts.allTypes')}
          value={type}
          onChange={setType}
          options={ACCOUNT_TYPES.map((v) => ({ value: v, label: t(`accounts.types.${v}`) }))}
          style={{ width: 160 }}
        />
        <Segmented<StatusFilter> value={status} onChange={setStatus} options={STATUS_FILTERS.map((s) => ({ value: s, label: t(`accounts.statuses.${s}`) }))} />
        <Segmented<View>
          className="view-toggle"
          aria-label={t('accounts.viewLabel')}
          value={view}
          onChange={changeView}
          options={[
            { value: 'grouped', label: t('accounts.view.grouped') },
            { value: 'flat', label: t('accounts.view.flat') },
          ]}
        />
      </div>
      {view === 'flat' || (!isLoading && groups.length === 0) ? (
        table(data, true)
      ) : (
        <div className="account-groups">
          {groups.map((g) => (
            <section key={g.institution.id} className="account-group" data-institution={g.institution.id}>
              <header className="account-group-head">
                <InstitutionAvatar name={g.institution.name} color={g.institution.color} size={28} />
                <span className="account-group-name">{g.institution.name}</span>
                {g.institution.status === 'archived' && <Tag>{t('institutions.statuses.archived')}</Tag>}
                <span className="muted">{t('accounts.accountCount', { count: g.items.length })}</span>
                {/* New accounts need an active institution. */}
                {g.institution.status === 'active' && (
                  <Button
                    type="link"
                    size="small"
                    icon={<PlusOutlined />}
                    className="account-group-add"
                    onClick={() => setForm({ open: true, editing: null, institutionId: g.institution.id })}
                  >
                    {t('accounts.add')}
                  </Button>
                )}
              </header>
              {table(g.items, false)}
            </section>
          ))}
        </div>
      )}
      <AccountFormModal open={form.open} editing={form.editing} initialInstitutionId={form.institutionId} onClose={() => setForm((f) => ({ ...f, open: false }))} />
    </Card>
  );
}

function ActionButton({ title, icon, onClick, danger }: { title: string; icon: ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <Tooltip title={title}>
      <Button type="text" size="small" danger={danger} icon={icon} aria-label={title} onClick={onClick} />
    </Tooltip>
  );
}
