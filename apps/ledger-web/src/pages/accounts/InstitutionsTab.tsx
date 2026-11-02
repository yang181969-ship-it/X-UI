import { DeleteOutlined, EditOutlined, InboxOutlined, PlusOutlined, SearchOutlined, UndoOutlined } from '@ant-design/icons';
import { Button, Card, Empty, Input, Segmented, Select, Space, Table, Tag, Tooltip, Typography } from 'antd';
import { INSTITUTION_STATUS_FILTERS, INSTITUTION_TYPES, type CountryCode, type InstitutionDto, type InstitutionListItem, type InstitutionListQuery, type InstitutionType } from '@xui/ledger-shared';
import { useDeferredValue, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useInstitutions } from '../../api/institutions.ts';
import { InstitutionAvatar } from '../../components/InstitutionAvatar.tsx';
import { regionName, regionOptions } from '../../lib/regions.ts';
import { InstitutionDrawer } from './InstitutionDrawer.tsx';
import { InstitutionFormModal } from './InstitutionFormModal.tsx';
import { useInstitutionActions } from './useInstitutionActions.ts';

type StatusFilter = (typeof INSTITUTION_STATUS_FILTERS)[number];

/** 账户 → 机构: list with search and filters, create / edit dialog, details drawer, archive and delete. */
export function InstitutionsTab() {
  const { t, i18n } = useTranslation();
  const [search, setSearch] = useState('');
  const [type, setType] = useState<InstitutionType | undefined>();
  const [country, setCountry] = useState<CountryCode | undefined>();
  const [status, setStatus] = useState<StatusFilter>('active');
  const q = useDeferredValue(search.trim());
  const filters: InstitutionListQuery = { q: q || undefined, type, country, status: status === 'active' ? undefined : status };
  const { data = [], isLoading } = useInstitutions(filters);
  const filtered = !!(q || type || country || status !== 'active');

  const [form, setForm] = useState<{ open: boolean; editing: InstitutionDto | null }>({ open: false, editing: null });
  const [detailId, setDetailId] = useState<string | null>(null);
  const { archive, restore, remove } = useInstitutionActions();
  const countries = useMemo(() => regionOptions(i18n.language), [i18n.language]);

  const openEdit = (inst: InstitutionDto) => setForm({ open: true, editing: inst });
  const viewExisting = (id: string) => {
    setForm({ open: false, editing: null });
    setDetailId(id);
  };

  return (
    <Card
      title={t('accounts.tabs.institutions')}
      extra={
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setForm({ open: true, editing: null })}>
          {t('institutions.add')}
        </Button>
      }
    >
      <Typography.Paragraph type="secondary">{t('institutions.desc')}</Typography.Paragraph>
      <div className="filter-row">
        <Input
          allowClear
          prefix={<SearchOutlined />}
          placeholder={t('institutions.search')}
          aria-label={t('institutions.search')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          maxLength={80}
          style={{ width: 220 }}
        />
        <Select<InstitutionType>
          allowClear
          aria-label={t('institutions.type')}
          placeholder={t('institutions.allTypes')}
          value={type}
          onChange={setType}
          options={INSTITUTION_TYPES.map((v) => ({ value: v, label: t(`institutions.types.${v}`) }))}
          style={{ width: 200 }}
        />
        <Select<CountryCode>
          allowClear
          showSearch={{ optionFilterProp: 'label' }}
          aria-label={t('institutions.country')}
          placeholder={t('institutions.allCountries')}
          value={country}
          onChange={setCountry}
          options={countries}
          style={{ width: 220 }}
        />
        <Segmented<StatusFilter>
          value={status}
          onChange={setStatus}
          options={INSTITUTION_STATUS_FILTERS.map((s) => ({ value: s, label: t(`institutions.statuses.${s}`) }))}
        />
      </div>
      <Table<InstitutionListItem>
        className="institution-table"
        rowKey="id"
        size="middle"
        loading={isLoading}
        dataSource={data}
        pagination={data.length > 50 ? { pageSize: 50, showSizeChanger: false } : false}
        scroll={{ x: 880 }}
        locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={filtered ? t('institutions.emptyFiltered') : t('institutions.empty')} /> }}
        onRow={(r) => ({ onClick: () => setDetailId(r.id), className: 'clickable-row' })}
        columns={[
          {
            key: 'name',
            title: t('institutions.name'),
            render: (_, r) => (
              <div className="institution-cell">
                <InstitutionAvatar name={r.name} color={r.color} />
                <div className="row-main">
                  <div className="row-title">{r.name}</div>
                  {r.website && <div className="row-sub">{r.website.replace(/^https:\/\//, '')}</div>}
                </div>
              </div>
            ),
          },
          { key: 'type', title: t('institutions.type'), width: 190, render: (_, r) => <Tag color="blue">{t(`institutions.types.${r.institutionType}`)}</Tag> },
          {
            key: 'country',
            title: t('institutions.country'),
            width: 180,
            render: (_, r) => (r.country ? `${regionName(r.country, i18n.language)} (${r.country})` : <span className="muted">{t('institutions.noCountry')}</span>),
          },
          {
            key: 'refs',
            title: t('institutions.references'),
            width: 250,
            render: (_, r) => <span className="muted">{t('institutions.refCounts', { accounts: r.accountCount, cards: r.cardCount, channels: r.channelCount })}</span>,
          },
          {
            key: 'status',
            title: t('institutions.status'),
            width: 90,
            render: (_, r) => (r.status === 'archived' ? <Tag>{t('institutions.statuses.archived')}</Tag> : <Tag color="green">{t('institutions.statuses.active')}</Tag>),
          },
          {
            key: 'actions',
            width: 130,
            align: 'right',
            render: (_, r) => (
              // Buttons act on the row without opening the drawer.
              <Space size={0} onClick={(e) => e.stopPropagation()}>
                <Tooltip title={t('institutions.edit')}>
                  <Button type="text" size="small" icon={<EditOutlined />} aria-label={t('institutions.edit')} onClick={() => openEdit(r)} />
                </Tooltip>
                {r.status === 'active' ? (
                  <Tooltip title={t('institutions.archive')}>
                    <Button type="text" size="small" icon={<InboxOutlined />} aria-label={t('institutions.archive')} onClick={() => archive(r)} />
                  </Tooltip>
                ) : (
                  <Tooltip title={t('institutions.restore')}>
                    <Button type="text" size="small" icon={<UndoOutlined />} aria-label={t('institutions.restore')} onClick={() => restore(r)} />
                  </Tooltip>
                )}
                <Tooltip title={t('institutions.delete')}>
                  <Button type="text" size="small" danger icon={<DeleteOutlined />} aria-label={t('institutions.delete')} onClick={() => remove(r)} />
                </Tooltip>
              </Space>
            ),
          },
        ]}
      />
      <InstitutionFormModal open={form.open} editing={form.editing} onClose={() => setForm((f) => ({ ...f, open: false }))} onViewExisting={viewExisting} />
      <InstitutionDrawer id={detailId} onClose={() => setDetailId(null)} onEdit={openEdit} />
    </Card>
  );
}
