import { ArrowLeftOutlined, DeleteOutlined, EditOutlined, PauseCircleOutlined, PlayCircleOutlined, StopOutlined, UndoOutlined } from '@ant-design/icons';
import { Button, Card, Descriptions, Empty, Skeleton, Space, Tag, Typography } from 'antd';
import type { AccountDetail, CardLinkDto, ChannelSummary } from '@xui/ledger-shared';
import dayjs from 'dayjs';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router';
import { useAccount } from '../api/accounts.ts';
import { CurrencyTags } from '../components/CurrencyTags.tsx';
import { InstitutionAvatar } from '../components/InstitutionAvatar.tsx';
import { PageTop } from '../layouts/PanelLayout.tsx';
import { currencyName } from '../lib/currencies.ts';
import { regionName } from '../lib/regions.ts';
import { AccountFormModal } from './accounts/AccountFormModal.tsx';
import { AccountStatusTag, accountSubtitle } from './accounts/AccountsTab.tsx';
import { CurrencyModal } from './accounts/CurrencyModal.tsx';
import { useAccountActions } from './accounts/useAccountActions.ts';

/**
 * /accounts/:id (PRODUCT_SPEC §4.5): details, currencies, linked cards (read-only until the cards
 * step — grouped by currency scope, ended links in a history section), and the payment channels
 * using the account. No balance or amount is shown anywhere.
 */
export function AccountDetailPage() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data, isLoading, isError } = useAccount(id);
  const account = data?.id === id ? data : undefined;
  const [editing, setEditing] = useState(false);
  const [currencies, setCurrencies] = useState(false);
  const { freeze, activate, close, remove } = useAccountActions();

  const back = (
    <Link to="/accounts" className="back-link">
      <ArrowLeftOutlined /> {t('accounts.back')}
    </Link>
  );

  return (
    <>
      <PageTop title={t('accounts.detail')} />
      {back}
      {isLoading && <Skeleton active />}
      {isError && !account && (
        <Card>
          <Empty description={t('accounts.notFound')} />
        </Card>
      )}
      {account && (
        <div className="account-detail">
          <Card>
            <div className="account-head">
              <InstitutionAvatar name={account.institution.name} color={account.institution.color} size={48} />
              <div className="row-main">
                <Typography.Title level={3} style={{ margin: 0 }}>
                  {account.name}
                </Typography.Title>
                <Space size={4} wrap>
                  <span className="muted">{account.institution.name}</span>
                  <span className="muted">·</span>
                  <span className="muted">{accountSubtitle(account, t)}</span>
                  <AccountStatusTag status={account.status} />
                </Space>
              </div>
              <Space wrap className="account-head-actions">
                <Button icon={<EditOutlined />} onClick={() => setEditing(true)}>
                  {t('accounts.edit')}
                </Button>
                {account.status === 'active' && (
                  <Button icon={<PauseCircleOutlined />} onClick={() => freeze(account)}>
                    {t('accounts.freeze')}
                  </Button>
                )}
                {account.status === 'frozen' && (
                  <Button icon={<PlayCircleOutlined />} onClick={() => activate(account)}>
                    {t('accounts.unfreeze')}
                  </Button>
                )}
                {account.status === 'closed' ? (
                  <Button icon={<UndoOutlined />} onClick={() => activate(account)}>
                    {t('accounts.reopen')}
                  </Button>
                ) : (
                  <Button icon={<StopOutlined />} onClick={() => close(account)}>
                    {t('accounts.close')}
                  </Button>
                )}
                <Button danger icon={<DeleteOutlined />} aria-label={t('accounts.delete')} onClick={() => remove(account, () => navigate('/accounts', { replace: true }))} />
              </Space>
            </div>
          </Card>
          <AccountInfo account={account} />
          <Card
            title={t('accounts.currencies')}
            className="account-currencies"
            extra={
              <Button size="small" onClick={() => setCurrencies(true)}>
                {t('accounts.currency.manage')}
              </Button>
            }
          >
            <CurrencyList account={account} />
          </Card>
          <Card title={t('accounts.cardLinks')} className="account-links">
            <CardLinks links={account.links} />
          </Card>
          <Card title={t('accounts.channels')} className="account-channels">
            <ChannelList title={t('accounts.channelAsFunds')} items={account.balanceOfChannels} />
            <ChannelList title={t('accounts.channelAsSource')} items={account.sourceOfChannels} />
          </Card>
          <AccountFormModal open={editing} editing={account} onClose={() => setEditing(false)} />
          <CurrencyModal open={currencies} account={account} onClose={() => setCurrencies(false)} />
        </div>
      )}
    </>
  );
}

function AccountInfo({ account }: { account: AccountDetail }) {
  const { t, i18n } = useTranslation();
  return (
    <Card title={t('accounts.info')}>
      <Descriptions column={{ xs: 1, md: 2 }} size="small" bordered className="account-info">
        <Descriptions.Item label={t('accounts.institution')}>
          <span className="institution-option">
            <InstitutionAvatar name={account.institution.name} color={account.institution.color} size={20} />
            {account.institution.name}
            {account.institution.status === 'archived' && <Tag>{t('institutions.statuses.archived')}</Tag>}
          </span>
        </Descriptions.Item>
        <Descriptions.Item label={t('accounts.type')}>
          {t(`accounts.types.${account.accountType}`)}
          {account.depositKind && ` · ${t(`accounts.depositKinds.${account.depositKind}`)}`}
        </Descriptions.Item>
        <Descriptions.Item label={t('accounts.country')}>{`${regionName(account.accountCountry, i18n.language)} (${account.accountCountry})`}</Descriptions.Item>
        <Descriptions.Item label={t('accounts.numberHint')}>{account.numberHint ? `•••• ${account.numberHint}` : '—'}</Descriptions.Item>
        <Descriptions.Item label={t('accounts.openedOn')}>{account.openedOn ?? '—'}</Descriptions.Item>
        <Descriptions.Item label={t('accounts.closedOn')}>{account.closedOn ?? '—'}</Descriptions.Item>
        <Descriptions.Item label={t('accounts.notes')} span={2}>
          <span className="pre-wrap">{account.notes || '—'}</span>
        </Descriptions.Item>
        <Descriptions.Item label={t('accounts.sort')}>{account.sort}</Descriptions.Item>
        <Descriptions.Item label={t('accounts.updatedAt')}>{dayjs(account.updatedAt).format('YYYY-MM-DD HH:mm')}</Descriptions.Item>
      </Descriptions>
      <Typography.Paragraph type="secondary" className="field-note">
        {t('accounts.countryHint')}
      </Typography.Paragraph>
    </Card>
  );
}

/** Active and closed currencies in separate sections, so a closed one is never read as in use. */
function CurrencyList({ account }: { account: AccountDetail }) {
  const { t, i18n } = useTranslation();
  const active = account.currencies.filter((c) => c.status === 'active');
  const closed = account.currencies.filter((c) => c.status === 'closed');
  const row = (c: AccountDetail['currencies'][number]) => (
    <div key={c.currency} className={`row-item ${c.status === 'closed' ? 'is-closed' : ''}`} data-currency={c.currency}>
      <div className="row-main">
        <div className="row-title">
          {c.currency} <span className="muted">{currencyName(c.currency, i18n.language)}</span>
        </div>
      </div>
      <Space size={4}>
        {c.isDefault && <Tag color="blue">{t('accounts.currency.default')}</Tag>}
        <Tag color={c.status === 'active' ? 'green' : undefined}>{t(`accounts.currency.${c.status}`)}</Tag>
      </Space>
    </div>
  );
  return (
    <>
      <CurrencyTags currencies={account.currencies} />
      <section className="ref-section currency-section" data-status="active">
        <Typography.Title level={5}>
          {t('accounts.currency.activeList')} <span className="muted">({active.length})</span>
        </Typography.Title>
        {active.map(row)}
      </section>
      {closed.length > 0 && (
        <section className="ref-section currency-section" data-status="closed">
          <Typography.Title level={5}>
            {t('accounts.currency.closedList')} <span className="muted">({closed.length})</span>
          </Typography.Title>
          <Typography.Text type="secondary" className="field-note">
            {t('accounts.currency.closedListHint')}
          </Typography.Text>
          {closed.map(row)}
        </section>
      )}
    </>
  );
}

/** Links grouped by currency scope; ended links (history) last. Read-only in this step (cards link to their page). */
function CardLinks({ links }: { links: CardLinkDto[] }) {
  const { t } = useTranslation();
  const current = links.filter((l) => l.status !== 'ended');
  const ended = links.filter((l) => l.status === 'ended');
  const scopes = [...new Set(current.map((l) => l.currency))].sort((a, b) => (a === null ? -1 : b === null ? 1 : a.localeCompare(b)));
  const row = (l: CardLinkDto) => (
    <div key={l.id} className="row-item" data-link={l.id}>
      <div className="row-main">
        <div className="row-title">
          <Link to={`/cards/${encodeURIComponent(l.cardId)}`}>{l.card.name}</Link> <span className="muted">•••• {l.card.last4}</span>
        </div>
        <div className="row-sub">
          {t(`accounts.roles.${l.role}`)}
          {l.startedOn && ` · ${l.startedOn}`}
          {l.endedOn && ` – ${l.endedOn}`}
        </div>
      </div>
      <Space size={4}>
        {l.isDefault && <Tag color="blue">{t('accounts.defaultSource')}</Tag>}
        {l.status !== 'active' && <Tag>{t(`accounts.linkStatuses.${l.status}`)}</Tag>}
      </Space>
    </div>
  );
  return (
    <>
      {links.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('accounts.cardLinksEmpty')} />}
      {scopes.map((scope) => (
        <section key={scope ?? 'all'} className="ref-section">
          <Typography.Title level={5}>{scope ?? t('accounts.scopeAll')}</Typography.Title>
          {current.filter((l) => l.currency === scope).map(row)}
        </section>
      ))}
      {ended.length > 0 && (
        <section className="ref-section link-history">
          <Typography.Title level={5}>{t('accounts.linkHistory')}</Typography.Title>
          {ended.map(row)}
        </section>
      )}
      <Typography.Paragraph type="secondary" className="field-note">
        {t('accounts.cardLinksLater')}
      </Typography.Paragraph>
    </>
  );
}

function ChannelList({ title, items }: { title: string; items: ChannelSummary[] }) {
  const { t } = useTranslation();
  return (
    <section className="ref-section">
      <Typography.Title level={5}>
        {title} <span className="muted">({items.length})</span>
      </Typography.Title>
      {items.length === 0 ? (
        <Typography.Text type="secondary">{t('accounts.none')}</Typography.Text>
      ) : (
        items.map((c) => (
          <div key={c.id} className="row-item">
            <div className="row-main">
              <div className="row-title">{c.name}</div>
            </div>
            {c.status !== 'active' && <Tag>{t('institutions.statuses.archived')}</Tag>}
          </div>
        ))
      )}
    </section>
  );
}
