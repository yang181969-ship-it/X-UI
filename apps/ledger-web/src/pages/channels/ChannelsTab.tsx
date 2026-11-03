import { DeleteOutlined, EditOutlined, InboxOutlined, PlusOutlined, SearchOutlined, UndoOutlined } from '@ant-design/icons';
import { Button, Card, Empty, Input, Segmented, Select, Space, Table, Tag, Tooltip, Typography } from 'antd';
import { CHANNEL_STATUS_FILTERS, CHANNEL_TYPES, type ChannelStatus, type ChannelType, type PaymentChannelDto, type PaymentChannelListItem, type PaymentChannelListQuery } from '@xui/ledger-shared';
import { useDeferredValue, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router';
import { channelHref, useChannels } from '../../api/channels.ts';
import { InstitutionAvatar } from '../../components/InstitutionAvatar.tsx';
import { regionName } from '../../lib/regions.ts';
import { AccountStatusTag } from '../accounts/AccountsTab.tsx';
import { ChannelFormModal } from './ChannelFormModal.tsx';
import { useChannelActions } from './useChannelActions.tsx';

type StatusFilter = (typeof CHANNEL_STATUS_FILTERS)[number];

export function ChannelTypeTag({ type }: { type: ChannelType }) {
  const { t } = useTranslation();
  const color = type === 'device_wallet' ? 'purple' : type === 'payment_service' ? 'blue' : undefined;
  return <Tag color={color}>{t(`channels.types.${type}`)}</Tag>;
}

export function ChannelStatusTag({ status }: { status: ChannelStatus }) {
  const { t } = useTranslation();
  return status === 'archived' ? <Tag>{t('channels.statuses.archived')}</Tag> : <Tag color="green">{t('channels.statuses.active')}</Tag>;
}

/**
 * 账户 → 支付渠道 (PRODUCT_SPEC §4.5): list with search and filters, create / edit dialog,
 * archive / restore and delete; a row opens the channel's page (/accounts/channels/:id). No
 * balance or amount is shown — a channel holds no money.
 */
export function ChannelsTab() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [type, setType] = useState<ChannelType | undefined>();
  const [status, setStatus] = useState<StatusFilter>('active');
  const q = useDeferredValue(search.trim());
  const filters: PaymentChannelListQuery = { q: q || undefined, type, status: status === 'active' ? undefined : status };
  const { data = [], isLoading } = useChannels(filters);
  const filtered = !!(q || type || status !== 'active');
  const [form, setForm] = useState<{ open: boolean; editing: PaymentChannelDto | null }>({ open: false, editing: null });
  const { archive, restore, remove } = useChannelActions();

  return (
    <Card
      title={t('accounts.tabs.channels')}
      extra={
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setForm({ open: true, editing: null })}>
          {t('channels.add')}
        </Button>
      }
    >
      <Typography.Paragraph type="secondary">{t('channels.desc')}</Typography.Paragraph>
      <div className="filter-row">
        <Input
          allowClear
          prefix={<SearchOutlined />}
          placeholder={t('channels.search')}
          aria-label={t('channels.search')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          maxLength={80}
          style={{ width: 220 }}
        />
        <Select<ChannelType>
          allowClear
          aria-label={t('channels.type')}
          placeholder={t('channels.allTypes')}
          value={type}
          onChange={setType}
          options={CHANNEL_TYPES.map((v) => ({ value: v, label: t(`channels.types.${v}`) }))}
          style={{ width: 180 }}
        />
        <Segmented<StatusFilter> value={status} onChange={setStatus} options={CHANNEL_STATUS_FILTERS.map((s) => ({ value: s, label: t(`channels.statuses.${s}`) }))} />
      </div>
      <Table<PaymentChannelListItem>
        className="channel-table"
        rowKey="id"
        size="middle"
        loading={isLoading}
        dataSource={data}
        pagination={data.length > 50 ? { pageSize: 50, showSizeChanger: false } : false}
        scroll={{ x: 960 }}
        locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={filtered ? t('channels.emptyFiltered') : t('channels.empty')} /> }}
        onRow={(r) => ({ onClick: () => navigate(channelHref(r.id)), className: 'clickable-row' })}
        columns={[
          {
            key: 'name',
            title: t('channels.name'),
            render: (_, r) => (
              <div className="institution-cell">
                <InstitutionAvatar name={r.provider?.name ?? r.name} color={r.provider?.color ?? null} />
                <div className="row-main">
                  <div className="row-title">
                    <Link to={channelHref(r.id)} onClick={(e) => e.stopPropagation()}>
                      {r.name}
                    </Link>
                  </div>
                  <div className="row-sub">{r.provider ? r.provider.name : t('channels.noProvider')}</div>
                </div>
              </div>
            ),
          },
          { key: 'type', title: t('channels.type'), width: 120, render: (_, r) => <ChannelTypeTag type={r.channelType} /> },
          {
            key: 'balance',
            title: t('channels.balanceAccount'),
            width: 220,
            render: (_, r) =>
              r.balanceAccount ? (
                <Space size={4} wrap onClick={(e) => e.stopPropagation()}>
                  <Link to={`/accounts/${encodeURIComponent(r.balanceAccount.id)}`}>{r.balanceAccount.name}</Link>
                  {r.balanceAccount.status !== 'active' && <AccountStatusTag status={r.balanceAccount.status} />}
                </Space>
              ) : (
                <span className="muted">—</span>
              ),
          },
          { key: 'sources', title: t('channels.sources'), width: 130, render: (_, r) => <span className="muted">{t('channels.sourceCount', { n: r.sourceCount })}</span> },
          { key: 'region', title: t('channels.region'), width: 150, render: (_, r) => (r.region ? `${regionName(r.region, i18n.language)} (${r.region})` : <span className="muted">—</span>) },
          { key: 'status', title: t('channels.status'), width: 90, render: (_, r) => <ChannelStatusTag status={r.status} /> },
          {
            key: 'actions',
            width: 130,
            align: 'right',
            render: (_, r) => (
              // Buttons act on the row without opening it.
              <Space size={0} onClick={(e) => e.stopPropagation()}>
                <Tooltip title={t('channels.edit')}>
                  <Button type="text" size="small" icon={<EditOutlined />} aria-label={t('channels.edit')} onClick={() => setForm({ open: true, editing: r })} />
                </Tooltip>
                {r.status === 'active' ? (
                  <Tooltip title={t('channels.archive')}>
                    <Button type="text" size="small" icon={<InboxOutlined />} aria-label={t('channels.archive')} onClick={() => archive(r)} />
                  </Tooltip>
                ) : (
                  <Tooltip title={t('channels.restore')}>
                    <Button type="text" size="small" icon={<UndoOutlined />} aria-label={t('channels.restore')} onClick={() => restore(r)} />
                  </Tooltip>
                )}
                <Tooltip title={t('channels.delete')}>
                  <Button type="text" size="small" danger icon={<DeleteOutlined />} aria-label={t('channels.delete')} onClick={() => remove(r)} />
                </Tooltip>
              </Space>
            ),
          },
        ]}
      />
      <ChannelFormModal open={form.open} editing={form.editing} onClose={() => setForm((f) => ({ ...f, open: false }))} />
    </Card>
  );
}
