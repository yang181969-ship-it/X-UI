import { DeleteOutlined, EditOutlined, InboxOutlined, UndoOutlined } from '@ant-design/icons';
import { Button, Descriptions, Drawer, Empty, Skeleton, Space, Tag, Typography } from 'antd';
import type { InstitutionDetail, InstitutionDto } from '@xui/ledger-shared';
import dayjs from 'dayjs';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { useInstitution } from '../../api/institutions.ts';
import { InstitutionAvatar } from '../../components/InstitutionAvatar.tsx';
import { regionName } from '../../lib/regions.ts';
import { useInstitutionActions } from './useInstitutionActions.ts';

function RefList({ title, items }: { title: string; items: { id: string; main: ReactNode; sub?: ReactNode; status: string }[] }) {
  const { t } = useTranslation();
  return (
    <section className="ref-section">
      <Typography.Title level={5}>
        {title} <span className="muted">({items.length})</span>
      </Typography.Title>
      {items.length === 0 ? (
        <Typography.Text type="secondary">{t('institutions.none')}</Typography.Text>
      ) : (
        items.map((i) => (
          <div key={i.id} className="row-item">
            <div className="row-main">
              <div className="row-title">{i.main}</div>
              {i.sub && <div className="row-sub">{i.sub}</div>}
            </div>
            {i.status !== 'active' && <Tag>{t(`institutions.refStatus.${i.status}`)}</Tag>}
          </div>
        ))
      )}
    </section>
  );
}

/** Institution details: fields, reference counts and the accounts, cards and channels using it. */
export function InstitutionDrawer({ id, onClose, onEdit }: { id: string | null; onClose: () => void; onEdit: (inst: InstitutionDto) => void }) {
  const { t, i18n } = useTranslation();
  const { data, isLoading, isError } = useInstitution(id);
  const { archive, restore, remove } = useInstitutionActions();
  const inst: InstitutionDetail | undefined = data?.id === id ? data : undefined;

  return (
    <Drawer
      open={!!id}
      onClose={onClose}
      size={520}
      title={t('institutions.detail')}
      extra={
        inst && (
          <Space wrap>
            <Button icon={<EditOutlined />} onClick={() => onEdit(inst)}>
              {t('institutions.edit')}
            </Button>
            {inst.status === 'active' ? (
              <Button icon={<InboxOutlined />} onClick={() => archive(inst)}>
                {t('institutions.archive')}
              </Button>
            ) : (
              <Button icon={<UndoOutlined />} onClick={() => restore(inst)}>
                {t('institutions.restore')}
              </Button>
            )}
            <Button danger icon={<DeleteOutlined />} aria-label={t('institutions.delete')} onClick={() => remove(inst, onClose)} />
          </Space>
        )
      }
    >
      {isLoading && <Skeleton active />}
      {isError && !inst && <Empty description={t('errors.codes.NOT_FOUND')} />}
      {inst && (
        <div className="institution-detail">
          <div className="institution-head">
            <InstitutionAvatar name={inst.name} color={inst.color} size={48} />
            <div className="row-main">
              <Typography.Title level={4} style={{ margin: 0 }}>
                {inst.name}
              </Typography.Title>
              <Space size={4} wrap>
                <Tag color="blue">{t(`institutions.types.${inst.institutionType}`)}</Tag>
                {inst.status === 'archived' && <Tag>{t('institutions.statuses.archived')}</Tag>}
              </Space>
            </div>
          </div>
          <Descriptions column={1} size="small" bordered>
            <Descriptions.Item label={t('institutions.country')}>{inst.country ? `${regionName(inst.country, i18n.language)} (${inst.country})` : t('institutions.noCountry')}</Descriptions.Item>
            <Descriptions.Item label={t('institutions.website')}>
              {inst.website ? (
                <Typography.Link href={inst.website} target="_blank" rel="noopener noreferrer nofollow">
                  {inst.website}
                </Typography.Link>
              ) : (
                '—'
              )}
            </Descriptions.Item>
            <Descriptions.Item label={t('institutions.notes')}>
              <span className="pre-wrap">{inst.notes || '—'}</span>
            </Descriptions.Item>
            <Descriptions.Item label={t('institutions.sort')}>{inst.sort}</Descriptions.Item>
            <Descriptions.Item label={t('institutions.references')}>{t('institutions.refCounts', { accounts: inst.accountCount, cards: inst.cardCount, channels: inst.channelCount })}</Descriptions.Item>
            <Descriptions.Item label={t('institutions.createdAt')}>{dayjs(inst.createdAt).format('YYYY-MM-DD HH:mm')}</Descriptions.Item>
            <Descriptions.Item label={t('institutions.updatedAt')}>{dayjs(inst.updatedAt).format('YYYY-MM-DD HH:mm')}</Descriptions.Item>
          </Descriptions>
          <RefList
            title={t('institutions.accounts')}
            items={inst.accounts.map((a) => ({ id: a.id, main: a.name, sub: `${regionName(a.accountCountry, i18n.language)} (${a.accountCountry})`, status: a.status }))}
          />
          <RefList
            title={t('institutions.cards')}
            items={inst.cards.map((c) => ({ id: c.id, main: <Link to={`/cards/${encodeURIComponent(c.id)}`}>{c.name}</Link>, sub: `${t(`cards.networks.${c.network}`)} •••• ${c.last4}`, status: c.status }))}
          />
          <RefList title={t('institutions.channels')} items={inst.channels.map((c) => ({ id: c.id, main: c.name, status: c.status }))} />
        </div>
      )}
    </Drawer>
  );
}
