import { DeleteOutlined, EditOutlined, PauseCircleOutlined, PlayCircleOutlined, PlusOutlined, SearchOutlined, StopOutlined, UndoOutlined } from '@ant-design/icons';
import { Alert, Button, Card, Empty, Input, Segmented, Select, Space, Table, Tag, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  CARD_FORMS,
  CARD_NETWORKS,
  CARD_STATUSES,
  CARD_TYPES,
  cardExpiry,
  DEFAULT_EXPIRING_WITHIN_DAYS,
  EXPIRY_STATUSES,
  type CardDto,
  type CardForm,
  type CardListItem,
  type CardListQuery,
  type CardNetwork,
  type CardStatus,
  type CardType,
  type ExpiryStatus,
} from '@xui/ledger-shared';
import { useDeferredValue, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { useCards } from '../api/cards.ts';
import { useInstitutions } from '../api/institutions.ts';
import { CardFace } from '../components/CardFace.tsx';
import { ExpiryTag, useToday } from '../components/ExpiryTag.tsx';
import { InstitutionAvatar } from '../components/InstitutionAvatar.tsx';
import { PageTop } from '../layouts/PanelLayout.tsx';
import { regionName } from '../lib/regions.ts';
import { CardFormModal } from './cards/CardFormModal.tsx';
import { useCardActions } from './cards/useCardActions.tsx';

/** Status filter: 'open' (the default) = not deactivated, i.e. active and frozen. */
const STATUS_FILTERS = ['open', ...CARD_STATUSES, 'all'] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];
type View = 'grid' | 'table';

const VIEW_KEY = 'xui-v1-cards-view';
function storedView(): View {
  try {
    return localStorage.getItem(VIEW_KEY) === 'table' ? 'table' : 'grid';
  } catch {
    return 'grid';
  }
}

export function CardStatusTag({ status }: { status: CardStatus }) {
  const { t } = useTranslation();
  const color = status === 'active' ? 'green' : status === 'frozen' ? 'orange' : undefined;
  return <Tag color={color}>{t(`cards.statuses.${status}`)}</Tag>;
}

/** "Visa · 借记卡 · 虚拟卡 · •••• 1234"-style subtitle. */
export function cardSubtitle(c: Pick<CardDto, 'network' | 'cardType' | 'form' | 'last4'>, t: (k: string) => string): string {
  return [t(`cards.networks.${c.network}`), t(`cards.types.${c.cardType}`), t(`cards.forms.${c.form}`), `•••• ${c.last4}`].join(' · ');
}

/**
 * 银行卡 (PRODUCT_SPEC §4.5): card faces or a table, search and filters (issuer, type, network,
 * form, status, expiry), expiry reminders, create / edit, status actions and a guarded delete.
 * Expiry is judged on the user's local day, and that day is sent to the API (today=) so the
 * expiry filter and the tags agree. No balance or amount is shown anywhere.
 */
export function CardsPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const today = useToday();
  const [search, setSearch] = useState('');
  const [issuerId, setIssuerId] = useState<string | undefined>();
  const [type, setType] = useState<CardType | undefined>();
  const [network, setNetwork] = useState<CardNetwork | undefined>();
  const [form, setForm] = useState<CardForm | undefined>();
  const [expiry, setExpiry] = useState<ExpiryStatus | undefined>();
  const [status, setStatus] = useState<StatusFilter>('open');
  const [view, setView] = useState<View>(storedView);
  const q = useDeferredValue(search.trim());
  const filters: CardListQuery = { q: q || undefined, issuerId, type, network, form, expiry, today: expiry ? today : undefined, status: status === 'open' ? undefined : status };
  const { data = [], isLoading } = useCards(filters);
  const filtered = !!(q || issuerId || type || network || form || expiry || status !== 'open');
  const { data: institutions = [] } = useInstitutions({ status: 'all' });
  // Reminders cover every card that is not deactivated, whatever the filters.
  const { data: open = [] } = useCards({});
  const counts = { expiring: 0, expired: 0 };
  for (const c of open) {
    const s = cardExpiry(c.expiresOn, today).status;
    if (s === 'expiring' || s === 'expired') counts[s]++;
  }

  const [editor, setEditor] = useState<{ open: boolean; editing: CardDto | null }>({ open: false, editing: null });
  const { freeze, activate, close, remove, deleteDialog } = useCardActions();
  const openCard = (c: CardDto) => navigate(`/cards/${encodeURIComponent(c.id)}`);

  const changeView = (v: View) => {
    setView(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* ignore */
    }
  };

  const actions = (r: CardListItem) => (
    // Buttons act on the card without opening the details.
    <Space size={0} onClick={(e) => e.stopPropagation()} className="card-actions">
      <ActionButton title={t('cards.edit')} icon={<EditOutlined />} onClick={() => setEditor({ open: true, editing: r })} />
      {r.status === 'active' && <ActionButton title={t('cards.freeze')} icon={<PauseCircleOutlined />} onClick={() => freeze(r)} />}
      {r.status === 'frozen' && <ActionButton title={t('cards.unfreeze')} icon={<PlayCircleOutlined />} onClick={() => activate(r)} />}
      {r.status === 'closed' ? <ActionButton title={t('cards.reopen')} icon={<UndoOutlined />} onClick={() => activate(r)} /> : <ActionButton title={t('cards.close')} icon={<StopOutlined />} onClick={() => close(r)} />}
      <ActionButton title={t('cards.delete')} icon={<DeleteOutlined />} danger onClick={() => remove(r)} />
    </Space>
  );

  const columns: ColumnsType<CardListItem> = [
    {
      key: 'name',
      title: t('cards.name'),
      render: (_, r) => (
        <div className="card-cell">
          <InstitutionAvatar name={r.issuer.name} color={r.issuer.color} size={26} />
          <div className="row-main">
            <div className="row-title">{r.name}</div>
            <div className="row-sub">{cardSubtitle(r, t)}</div>
          </div>
        </div>
      ),
    },
    {
      key: 'issuer',
      title: t('cards.issuer'),
      width: 190,
      render: (_, r) => (
        <span className="institution-option">
          {r.issuer.name}
          {r.issuer.status === 'archived' && <Tag>{t('institutions.statuses.archived')}</Tag>}
        </span>
      ),
    },
    { key: 'country', title: t('cards.issuingCountry'), width: 160, render: (_, r) => `${regionName(r.issuingCountry, i18n.language)} (${r.issuingCountry})` },
    { key: 'expiry', title: t('cards.expiresOn'), width: 190, render: (_, r) => <ExpiryTag expiresOn={r.expiresOn} today={today} /> },
    {
      key: 'accounts',
      title: t('cards.linkedAccounts'),
      width: 110,
      render: (_, r) => (r.linkedAccounts.length ? t('cards.linkedAccountCount', { count: r.linkedAccounts.length }) : <span className="muted">—</span>),
    },
    { key: 'status', title: t('cards.status'), width: 90, render: (_, r) => <CardStatusTag status={r.status} /> },
    { key: 'actions', width: 150, align: 'right', render: (_, r) => actions(r) },
  ];

  const empty = <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={filtered ? t('cards.emptyFiltered') : t('cards.empty')} />;

  return (
    <>
      <PageTop title={t('nav.cards')} />
      <Typography.Paragraph type="secondary" className="page-desc">
        {t('cards.desc')}
      </Typography.Paragraph>
      {(counts.expiring > 0 || counts.expired > 0) && (
        <div className="expiry-reminders">
          {counts.expiring > 0 && (
            <Alert
              type="warning"
              showIcon
              data-reminder="expiring"
              title={t('cards.reminder.expiring', { count: counts.expiring, days: DEFAULT_EXPIRING_WITHIN_DAYS })}
              action={
                <Button size="small" onClick={() => setExpiry('expiring')}>
                  {t('cards.reminder.show')}
                </Button>
              }
            />
          )}
          {counts.expired > 0 && (
            <Alert
              type="error"
              showIcon
              data-reminder="expired"
              title={t('cards.reminder.expired', { count: counts.expired })}
              action={
                <Button size="small" onClick={() => setExpiry('expired')}>
                  {t('cards.reminder.show')}
                </Button>
              }
            />
          )}
        </div>
      )}
      <Card
        title={t('cards.list')}
        extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setEditor({ open: true, editing: null })}>
            {t('cards.add')}
          </Button>
        }
      >
        <div className="filter-row">
          <Input
            allowClear
            prefix={<SearchOutlined />}
            placeholder={t('cards.search')}
            aria-label={t('cards.search')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            maxLength={80}
            style={{ width: 230 }}
          />
          <Select<string>
            allowClear
            showSearch={{ optionFilterProp: 'label' }}
            aria-label={t('cards.issuer')}
            placeholder={t('cards.allIssuers')}
            value={issuerId}
            onChange={setIssuerId}
            options={institutions.map((i) => ({ value: i.id, label: i.name }))}
            style={{ width: 180 }}
          />
          <Select<CardType>
            allowClear
            aria-label={t('cards.type')}
            placeholder={t('cards.allTypes')}
            value={type}
            onChange={setType}
            options={CARD_TYPES.map((v) => ({ value: v, label: t(`cards.types.${v}`) }))}
            style={{ width: 130 }}
          />
          <Select<CardNetwork>
            allowClear
            aria-label={t('cards.network')}
            placeholder={t('cards.allNetworks')}
            value={network}
            onChange={setNetwork}
            options={CARD_NETWORKS.map((v) => ({ value: v, label: t(`cards.networks.${v}`) }))}
            style={{ width: 160 }}
          />
          <Select<CardForm>
            allowClear
            aria-label={t('cards.form')}
            placeholder={t('cards.allForms')}
            value={form}
            onChange={setForm}
            options={CARD_FORMS.map((v) => ({ value: v, label: t(`cards.forms.${v}`) }))}
            style={{ width: 140 }}
          />
          <Select<ExpiryStatus>
            allowClear
            aria-label={t('cards.expiry.label')}
            placeholder={t('cards.allExpiry')}
            value={expiry}
            onChange={setExpiry}
            options={EXPIRY_STATUSES.map((v) => ({ value: v, label: t(`cards.expiry.${v}`) }))}
            style={{ width: 150 }}
          />
          <Segmented<StatusFilter> value={status} onChange={setStatus} options={STATUS_FILTERS.map((s) => ({ value: s, label: t(`cards.statuses.${s}`) }))} />
          <Segmented<View>
            className="view-toggle"
            aria-label={t('cards.viewLabel')}
            value={view}
            onChange={changeView}
            options={[
              { value: 'grid', label: t('cards.view.grid') },
              { value: 'table', label: t('cards.view.table') },
            ]}
          />
        </div>
        {view === 'table' ? (
          <Table<CardListItem>
            className="card-table"
            rowKey="id"
            size="middle"
            loading={isLoading}
            dataSource={data}
            pagination={data.length > 50 ? { pageSize: 50, showSizeChanger: false } : false}
            scroll={{ x: 1100 }}
            locale={{ emptyText: empty }}
            onRow={(r) => ({ onClick: () => openCard(r), className: 'clickable-row' })}
            columns={columns}
          />
        ) : !isLoading && data.length === 0 ? (
          empty
        ) : (
          <div className="card-grid">
            {data.map((c) => (
              <div
                key={c.id}
                className="card-tile"
                data-card={c.id}
                role="link"
                tabIndex={0}
                onClick={() => openCard(c)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && e.target === e.currentTarget) openCard(c);
                }}
              >
                <CardFace card={c} />
                <div className="card-tile-meta">
                  <div className="row-main">
                    <div className="row-title">{c.name}</div>
                    <div className="row-sub">{cardSubtitle(c, t)}</div>
                  </div>
                  {actions(c)}
                </div>
                <div className="card-tile-tags">
                  <CardStatusTag status={c.status} />
                  <ExpiryTag expiresOn={c.expiresOn} today={today} />
                  {c.linkedAccounts.length > 0 && <Tag>{t('cards.linkedAccountCount', { count: c.linkedAccounts.length })}</Tag>}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
      <CardFormModal open={editor.open} editing={editor.editing} onClose={() => setEditor((f) => ({ ...f, open: false }))} />
      {deleteDialog}
    </>
  );
}

function ActionButton({ title, icon, onClick, danger }: { title: string; icon: ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <Tooltip title={title}>
      <Button type="text" size="small" danger={danger} icon={icon} aria-label={title} onClick={onClick} />
    </Tooltip>
  );
}
