import { ArrowLeftOutlined, DeleteOutlined, EditOutlined, PauseCircleOutlined, PlayCircleOutlined, StopOutlined, UndoOutlined } from '@ant-design/icons';
import { Button, Card, Descriptions, Empty, Skeleton, Space, Tag, Typography } from 'antd';
import { cardExpiry, type CardDetail } from '@xui/ledger-shared';
import dayjs from 'dayjs';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router';
import { useCard } from '../api/cards.ts';
import { useInstitution } from '../api/institutions.ts';
import { CardFace } from '../components/CardFace.tsx';
import { ExpiryTag, useToday } from '../components/ExpiryTag.tsx';
import { InstitutionAvatar } from '../components/InstitutionAvatar.tsx';
import { PageTop } from '../layouts/PanelLayout.tsx';
import { regionName } from '../lib/regions.ts';
import { CardFormModal } from './cards/CardFormModal.tsx';
import { useCardActions } from './cards/useCardActions.tsx';
import { CardLinksPanel } from './links/CardLinks.tsx';
import { SpendingSourcePreview } from './links/SpendingSourcePreview.tsx';
import { CardStatusTag, cardSubtitle } from './CardsPage.tsx';

/**
 * /cards/:id (PRODUCT_SPEC §4.5): the card face (only "•••• 1234"), its details, the linked
 * accounts with their own jurisdiction (managed here: add, edit, default, suspend / resume, end,
 * delete; history included), the spending-source preview and the payment channels using it. No
 * balance or amount is shown anywhere.
 */
export function CardDetailPage() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data, isLoading, isError } = useCard(id);
  const card = data?.id === id ? data : undefined;
  const [editing, setEditing] = useState(false);
  const { freeze, activate, close, remove, deleteDialog } = useCardActions();
  const today = useToday();

  return (
    <>
      <PageTop title={t('cards.detail')} />
      <Link to="/cards" className="back-link">
        <ArrowLeftOutlined /> {t('cards.back')}
      </Link>
      {isLoading && <Skeleton active />}
      {isError && !card && (
        <Card>
          <Empty description={t('cards.notFound')} />
        </Card>
      )}
      {card && (
        <div className="card-detail">
          <Card>
            <div className="card-detail-head">
              <CardFace card={card} size="lg" />
              <div className="row-main">
                <Typography.Title level={3} style={{ margin: 0 }}>
                  {card.name}
                </Typography.Title>
                <div className="muted">{cardSubtitle(card, t)}</div>
                <Space size={4} wrap className="card-detail-tags">
                  <CardStatusTag status={card.status} />
                  <ExpiryTag expiresOn={card.expiresOn} today={today} />
                </Space>
                <Space wrap className="card-detail-actions">
                  <Button icon={<EditOutlined />} onClick={() => setEditing(true)}>
                    {t('cards.edit')}
                  </Button>
                  {card.status === 'active' && (
                    <Button icon={<PauseCircleOutlined />} onClick={() => freeze(card)}>
                      {t('cards.freeze')}
                    </Button>
                  )}
                  {card.status === 'frozen' && (
                    <Button icon={<PlayCircleOutlined />} onClick={() => activate(card)}>
                      {t('cards.unfreeze')}
                    </Button>
                  )}
                  {card.status === 'closed' ? (
                    <Button icon={<UndoOutlined />} onClick={() => activate(card)}>
                      {t('cards.reopen')}
                    </Button>
                  ) : (
                    <Button icon={<StopOutlined />} onClick={() => close(card)}>
                      {t('cards.close')}
                    </Button>
                  )}
                  <Button danger icon={<DeleteOutlined />} aria-label={t('cards.delete')} onClick={() => remove(card, () => navigate('/cards', { replace: true }))} />
                </Space>
              </div>
            </div>
          </Card>
          <CardInfo card={card} today={today} />
          <CardLinksPanel owner={{ side: 'card', card }} links={card.links} />
          <SpendingSourcePreview card={card} />
          <Card title={t('cards.channels')} className="card-channels">
            {card.channels.length === 0 ? (
              <Typography.Text type="secondary">{t('cards.channelsEmpty')}</Typography.Text>
            ) : (
              card.channels.map((c) => (
                <div key={c.id} className="row-item">
                  <div className="row-main">
                    <div className="row-title">{c.name}</div>
                  </div>
                  {c.status !== 'active' && <Tag>{t('institutions.statuses.archived')}</Tag>}
                </div>
              ))
            )}
          </Card>
          <CardFormModal open={editing} editing={card} onClose={() => setEditing(false)} />
        </div>
      )}
      {deleteDialog}
    </>
  );
}

function CardInfo({ card, today }: { card: CardDetail; today: string }) {
  const { t, i18n } = useTranslation();
  const region = (code: string) => `${regionName(code, i18n.language)} (${code})`;
  // The issuer's own country (institutions.country) is a separate fact from the card's issuing country.
  const { data: issuer } = useInstitution(card.issuerInstitutionId);
  const expiry = cardExpiry(card.expiresOn, today);
  return (
    <Card title={t('cards.info')}>
      <Descriptions column={{ xs: 1, md: 2 }} size="small" bordered className="card-info">
        <Descriptions.Item label={t('cards.issuer')}>
          <span className="institution-option">
            <InstitutionAvatar name={card.issuer.name} color={card.issuer.color} size={20} />
            {card.issuer.name}
            {card.issuer.status === 'archived' && <Tag>{t('institutions.statuses.archived')}</Tag>}
          </span>
        </Descriptions.Item>
        <Descriptions.Item label={t('cards.issuerCountry')}>{issuer?.id === card.issuerInstitutionId ? (issuer.country ? region(issuer.country) : t('institutions.noCountry')) : '…'}</Descriptions.Item>
        <Descriptions.Item label={t('cards.issuingCountry')}>{region(card.issuingCountry)}</Descriptions.Item>
        <Descriptions.Item label={t('cards.network')}>{t(`cards.networks.${card.network}`)}</Descriptions.Item>
        <Descriptions.Item label={t('cards.type')}>{t(`cards.types.${card.cardType}`)}</Descriptions.Item>
        <Descriptions.Item label={t('cards.form')}>{t(`cards.forms.${card.form}`)}</Descriptions.Item>
        <Descriptions.Item label={t('cards.last4')}>•••• {card.last4}</Descriptions.Item>
        <Descriptions.Item label={t('cards.expiresOn')}>
          {card.expiresOn ? `${card.expiresOn} · ${t('cards.expiry.validUntil', { date: expiry.lastDay })}` : t('cards.expiry.none')}
        </Descriptions.Item>
        <Descriptions.Item label={t('cards.status')}>
          <CardStatusTag status={card.status} />
        </Descriptions.Item>
        <Descriptions.Item label={t('cards.sort')}>{card.sort}</Descriptions.Item>
        <Descriptions.Item label={t('cards.notes')} span={2}>
          <span className="pre-wrap">{card.notes || '—'}</span>
        </Descriptions.Item>
        <Descriptions.Item label={t('cards.createdAt')}>{dayjs(card.createdAt).format('YYYY-MM-DD HH:mm')}</Descriptions.Item>
        <Descriptions.Item label={t('cards.updatedAt')}>{dayjs(card.updatedAt).format('YYYY-MM-DD HH:mm')}</Descriptions.Item>
      </Descriptions>
      <Typography.Paragraph type="secondary" className="field-note">
        {t('cards.regionsNote')}
      </Typography.Paragraph>
    </Card>
  );
}
