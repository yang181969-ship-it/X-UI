import { ArrowLeftOutlined, DeleteOutlined, EditOutlined, InboxOutlined, UndoOutlined } from '@ant-design/icons';
import { Button, Card, Descriptions, Empty, Skeleton, Space, Tag, Typography } from 'antd';
import type { PaymentChannelDetail } from '@xui/ledger-shared';
import dayjs from 'dayjs';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router';
import { useChannel } from '../api/channels.ts';
import { InstitutionAvatar } from '../components/InstitutionAvatar.tsx';
import { PageTop } from '../layouts/PanelLayout.tsx';
import { regionName } from '../lib/regions.ts';
import { AccountStatusTag } from './accounts/AccountsTab.tsx';
import { ChannelFormModal } from './channels/ChannelFormModal.tsx';
import { ChannelSourcesPanel } from './channels/ChannelSources.tsx';
import { ChannelStatusTag, ChannelTypeTag } from './channels/ChannelsTab.tsx';
import { useChannelActions } from './channels/useChannelActions.tsx';

/**
 * /accounts/channels/:id (PRODUCT_SPEC §4.5): a payment channel — its type, provider, funds account
 * (the API's balance account, payment services only) and its funding sources, current and ended.
 * A channel holds no money: no balance, amount or exchange rate is shown anywhere.
 */
export function ChannelDetailPage() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data, isLoading, isError } = useChannel(id);
  const channel = data?.id === id ? data : undefined;
  const [editing, setEditing] = useState(false);
  const { archive, restore, remove } = useChannelActions();

  return (
    <>
      <PageTop title={t('channels.detail')} />
      <Link to="/accounts?tab=channels" className="back-link">
        <ArrowLeftOutlined /> {t('channels.back')}
      </Link>
      {isLoading && <Skeleton active />}
      {isError && !channel && (
        <Card>
          <Empty description={t('channels.notFound')} />
        </Card>
      )}
      {channel && (
        <div className="channel-detail">
          <Card>
            <div className="account-head">
              <InstitutionAvatar name={channel.provider?.name ?? channel.name} color={channel.provider?.color ?? null} size={48} />
              <div className="row-main">
                <Typography.Title level={3} style={{ margin: 0 }}>
                  {channel.name}
                </Typography.Title>
                <Space size={4} wrap>
                  <span className="muted">{channel.provider?.name ?? t('channels.noProvider')}</span>
                  <ChannelTypeTag type={channel.channelType} />
                  <ChannelStatusTag status={channel.status} />
                </Space>
              </div>
              <Space wrap className="account-head-actions">
                <Button icon={<EditOutlined />} onClick={() => setEditing(true)}>
                  {t('channels.edit')}
                </Button>
                {channel.status === 'active' ? (
                  <Button icon={<InboxOutlined />} onClick={() => archive(channel)}>
                    {t('channels.archive')}
                  </Button>
                ) : (
                  <Button icon={<UndoOutlined />} onClick={() => restore(channel)}>
                    {t('channels.restore')}
                  </Button>
                )}
                <Button danger icon={<DeleteOutlined />} aria-label={t('channels.delete')} onClick={() => remove(channel, () => navigate('/accounts?tab=channels', { replace: true }))} />
              </Space>
            </div>
          </Card>
          <ChannelInfo channel={channel} />
          <ChannelSourcesPanel channel={channel} />
          <ChannelFormModal open={editing} editing={channel} onClose={() => setEditing(false)} />
        </div>
      )}
    </>
  );
}

function ChannelInfo({ channel }: { channel: PaymentChannelDetail }) {
  const { t, i18n } = useTranslation();
  return (
    <Card title={t('channels.info')}>
      <Descriptions column={{ xs: 1, md: 2 }} size="small" bordered className="channel-info">
        <Descriptions.Item label={t('channels.type')}>
          <ChannelTypeTag type={channel.channelType} /> <span className="muted">{t(`channels.typeHints.${channel.channelType}`)}</span>
        </Descriptions.Item>
        <Descriptions.Item label={t('channels.provider')}>
          {channel.provider ? (
            <span className="institution-option">
              <InstitutionAvatar name={channel.provider.name} color={channel.provider.color} size={20} />
              {channel.provider.name}
              {channel.provider.status === 'archived' && <Tag>{t('institutions.statuses.archived')}</Tag>}
            </span>
          ) : (
            t('channels.noProvider')
          )}
        </Descriptions.Item>
        <Descriptions.Item label={t('channels.balanceAccount')}>
          {channel.balanceAccount ? (
            <Space size={4} wrap>
              <Link to={`/accounts/${encodeURIComponent(channel.balanceAccount.id)}`}>{channel.balanceAccount.name}</Link>
              <span className="muted">{`${regionName(channel.balanceAccount.accountCountry, i18n.language)} (${channel.balanceAccount.accountCountry})`}</span>
              {channel.balanceAccount.status !== 'active' && <AccountStatusTag status={channel.balanceAccount.status} />}
            </Space>
          ) : (
            t('channels.noBalance')
          )}
        </Descriptions.Item>
        <Descriptions.Item label={t('channels.region')}>{channel.region ? `${regionName(channel.region, i18n.language)} (${channel.region})` : t('channels.noRegion')}</Descriptions.Item>
        <Descriptions.Item label={t('channels.notes')} span={2}>
          <span className="pre-wrap">{channel.notes || '—'}</span>
        </Descriptions.Item>
        <Descriptions.Item label={t('channels.sort')}>{channel.sort}</Descriptions.Item>
        <Descriptions.Item label={t('channels.status')}>
          <ChannelStatusTag status={channel.status} />
        </Descriptions.Item>
        <Descriptions.Item label={t('channels.createdAt')}>{dayjs(channel.createdAt).format('YYYY-MM-DD HH:mm')}</Descriptions.Item>
        <Descriptions.Item label={t('channels.updatedAt')}>{dayjs(channel.updatedAt).format('YYYY-MM-DD HH:mm')}</Descriptions.Item>
      </Descriptions>
      <Typography.Paragraph type="secondary" className="field-note">
        {t('channels.noFunds')}
      </Typography.Paragraph>
    </Card>
  );
}
