import { Card, Descriptions, Space, Table, Tag, Typography } from 'antd';
import type { CardSummary, EventFacts, TransactionDto, TransactionEntryDto, TxnType } from '@xui/ledger-shared';
import type { HTMLAttributes } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { channelHref } from '../../api/channels.ts';
import { regionName } from '../../lib/regions.ts';
import { AccountStatusTag } from '../accounts/AccountsTab.tsx';
import { DirectionMark, EventAmount } from './txnDisplay.tsx';
import { MoneyText } from '../../components/MoneyText.tsx';

/**
 * A version's saved facts and snapshots (EventFacts / EntryFacts) — kept apart from the current
 * summaries of its accounts, card and channel (CurrentSummary), which may have changed since. The
 * classification shown is the one the server saved; nothing is recomputed here.
 */

type ChannelRef = NonNullable<TransactionDto['paymentChannel']>;
export interface KnownRefs {
  card: CardSummary | null;
  channel: ChannelRef | null;
}

export function useRegion() {
  const { t, i18n } = useTranslation();
  return (code: string | null) => (code === null ? t('transactions.detail.unknown') : `${regionName(code, i18n.language)} (${code})`);
}

export function FactsView({ txnType, revision, event, entries, refs }: { txnType: TxnType; revision: number; event: EventFacts; entries: TransactionEntryDto[]; refs: KnownRefs }) {
  const { t } = useTranslation();
  return (
    <div className="txn-facts" data-revision={revision}>
      <Card title={t('transactions.detail.snapshot', { n: revision })} className="txn-snapshot">
        <Typography.Paragraph type="secondary" className="field-note">
          {t('transactions.detail.snapshotHint')}
        </Typography.Paragraph>
        <EventView txnType={txnType} event={event} refs={refs} />
        <Typography.Title level={5} className="txn-section-title">
          {t('transactions.detail.entries')}
        </Typography.Title>
        <EntriesTable entries={entries} />
        <Typography.Title level={5} className="txn-section-title">
          {t('transactions.detail.classification')}
        </Typography.Title>
        <ClassificationView event={event} />
      </Card>
    </div>
  );
}

function EventView({ txnType, event, refs }: { txnType: TxnType; event: EventFacts; refs: KnownRefs }) {
  const { t } = useTranslation();
  const region = useRegion();
  const merchant = txnType === 'merchant_spend' || txnType === 'merchant_refund';
  const none = t('transactions.detail.none');
  const cp = event.counterparty;
  const cardText = event.cardId === null ? none : refs.card?.id === event.cardId ? `${refs.card.name} •••• ${refs.card.last4}` : event.cardId;
  const channelText = event.paymentChannelId === null ? none : refs.channel?.id === event.paymentChannelId ? refs.channel.name : event.paymentChannelId;
  return (
    <Descriptions column={{ xs: 1, md: 2 }} size="small" bordered className="txn-event">
      <Descriptions.Item label={t('transactions.detail.occurredOn')}>
        <span className="num" data-field="occurredOn">
          {event.occurredOn}
        </span>
      </Descriptions.Item>
      <Descriptions.Item label={t('transactions.detail.occurredTime')}>{event.occurredTime ?? none}</Descriptions.Item>
      <Descriptions.Item label={t('transactions.detail.postedOn')}>{event.postedOn ?? none}</Descriptions.Item>
      <Descriptions.Item label={t('transactions.detail.recordMode')}>{t(`transactions.recordMode.${event.recordMode}`)}</Descriptions.Item>
      <Descriptions.Item label={t('transactions.detail.eventAmount')}>
        <span data-field="eventAmount">
          <EventAmount event={event} />
        </span>
      </Descriptions.Item>
      {merchant ? (
        <>
          <Descriptions.Item label={t('transactions.detail.merchant')}>{event.merchantName ?? none}</Descriptions.Item>
          <Descriptions.Item label={t('transactions.detail.merchantCountry')}>
            <span data-field="merchantCountry">{region(event.merchantCountry)}</span>
          </Descriptions.Item>
          <Descriptions.Item label={t('transactions.detail.card')}>{cardText}</Descriptions.Item>
        </>
      ) : (
        <>
          <Descriptions.Item label={t('transactions.detail.transferMethod')}>{event.transferMethod ? t(`transactions.transferMethods.${event.transferMethod}`) : none}</Descriptions.Item>
          {cp && (
            <Descriptions.Item label={t('transactions.detail.counterparty')} span={2}>
              <div className="txn-counterparty" data-field="counterparty">
                <Tag>{t(`transactions.detail.counterpartyKinds.${cp.kind}`)}</Tag>
                <span>
                  <span className="muted">{t('transactions.detail.counterpartyName')}</span> {cp.name ?? none}
                </span>
                <span>
                  <span className="muted">{t('transactions.detail.counterpartyCountry')}</span> {region(cp.country)}
                </span>
                <span>
                  <span className="muted">{t('transactions.detail.counterpartyInstitution')}</span> {cp.institution ?? none}
                </span>
                <span>
                  <span className="muted">{t('transactions.detail.counterpartyHint')}</span> {cp.accountHint ? `•••• ${cp.accountHint}` : none}
                </span>
              </div>
            </Descriptions.Item>
          )}
        </>
      )}
      <Descriptions.Item label={t('transactions.detail.channel')}>{channelText}</Descriptions.Item>
    </Descriptions>
  );
}

export function EntriesTable({ entries }: { entries: TransactionEntryDto[] }) {
  const { t } = useTranslation();
  const region = useRegion();
  return (
    <Table<TransactionEntryDto>
      className="txn-entry-table"
      size="small"
      rowKey="entryId"
      pagination={false}
      dataSource={entries}
      scroll={{ x: 760 }}
      onRow={(e) => ({ 'data-direction': e.direction }) as HTMLAttributes<HTMLElement>}
      columns={[
        { key: 'direction', width: 90, render: (_, e) => <DirectionMark direction={e.direction} /> },
        {
          key: 'account',
          title: t('transactions.detail.entryAccount'),
          render: (_, e) => <Link to={`/accounts/${encodeURIComponent(e.account.id)}`}>{e.account.name}</Link>,
        },
        {
          key: 'amount',
          title: t('transactions.detail.entryAmount'),
          align: 'right',
          render: (_, e) => (
            <Space size={4}>
              <MoneyText amount={e.amount} exponent={e.currencyExponent} currency={e.currency} />
              {e.amountStatus === 'pending' && <Tag color="orange">{t('transactions.amountStatus.pending')}</Tag>}
            </Space>
          ),
        },
        {
          key: 'country',
          title: t('transactions.detail.entryCountry'),
          render: (_, e) => (
            <div className="row-main">
              <div data-field="fundingAccountCountry">{region(e.fundingAccountCountry)}</div>
              <div className="row-sub">{t(`transactions.countrySources.${e.countrySource}`)}</div>
            </div>
          ),
        },
        {
          key: 'currencyAtSave',
          title: t('transactions.detail.currencyAtSave'),
          render: (_, e) => (
            <Space size={4} wrap>
              <Tag color={e.currencyStatusAtSave === 'closed' ? 'default' : 'green'} data-field="currencyStatusAtSave">
                {t(`transactions.detail.currencyStatuses.${e.currencyStatusAtSave}`)}
              </Tag>
              {e.closedCurrencyAck && <Tag color="purple">{t('transactions.detail.closedAck')}</Tag>}
            </Space>
          ),
        },
      ]}
    />
  );
}

function ClassificationView({ event }: { event: EventFacts }) {
  const { t } = useTranslation();
  const region = useRegion();
  const fs = event.foreignStatus;
  return (
    <Descriptions column={{ xs: 1, md: 2 }} size="small" bordered className="txn-classification">
      <Descriptions.Item label={t('transactions.detail.homeRegion')}>
        <span data-field="homeRegion">{region(event.homeRegion)}</span> <span className="muted">· {t(`transactions.homeRegionSources.${event.homeRegionSource}`)}</span>
      </Descriptions.Item>
      <Descriptions.Item label={t('transactions.detail.foreignStatus')}>
        <Tag color={fs === 'foreign' ? 'blue' : fs === 'undetermined' ? 'gold' : undefined} data-field="foreignStatus">
          {t(`transactions.foreignStatus.${fs}`)}
        </Tag>
      </Descriptions.Item>
      {event.merchantScope !== null && <Descriptions.Item label={t('transactions.detail.merchantScope')}>{t(`transactions.merchantScopes.${event.merchantScope}`)}</Descriptions.Item>}
      {event.transferScope !== null && <Descriptions.Item label={t('transactions.detail.transferScope')}>{t(`transactions.transferScopes.${event.transferScope}`)}</Descriptions.Item>}
      <Descriptions.Item label={t('transactions.detail.classifierVersion')}>v{event.classifierVersion}</Descriptions.Item>
    </Descriptions>
  );
}

/** The accounts, card and channel as they are now (names and statuses may differ from when the version was saved). */
export function CurrentSummary({ txn }: { txn: TransactionDto }) {
  const { t } = useTranslation();
  const region = useRegion();
  const accounts = [...new Map(txn.entries.map((e) => [e.account.id, e.account])).values()];
  return (
    <Card title={t('transactions.detail.current')} className="txn-current">
      <Typography.Paragraph type="secondary" className="field-note">
        {t('transactions.detail.currentHint')}
      </Typography.Paragraph>
      <section className="ref-section">
        <Typography.Title level={5}>{t('transactions.detail.currentAccounts')}</Typography.Title>
        {accounts.map((a) => (
          <div key={a.id} className="row-item" data-account={a.id}>
            <div className="row-main">
              <div className="row-title">
                <Link to={`/accounts/${encodeURIComponent(a.id)}`}>{a.name}</Link>
              </div>
              <div className="row-sub">
                <span className="muted">{t('transactions.detail.currentAccountCountry')}</span> <span data-field="currentAccountCountry">{region(a.accountCountry)}</span>
              </div>
            </div>
            <AccountStatusTag status={a.status} />
          </div>
        ))}
      </section>
      <section className="ref-section">
        <Typography.Title level={5}>{t('transactions.detail.card')}</Typography.Title>
        {txn.card ? (
          <div className="row-item" data-card={txn.card.id}>
            <div className="row-main">
              <div className="row-title">
                <Link to={`/cards/${encodeURIComponent(txn.card.id)}`}>{txn.card.name}</Link> <span className="muted">•••• {txn.card.last4}</span>
              </div>
            </div>
            <Tag color={txn.card.status === 'active' ? 'green' : txn.card.status === 'frozen' ? 'orange' : undefined}>{t(`cards.statuses.${txn.card.status}`)}</Tag>
          </div>
        ) : (
          <Typography.Text type="secondary">{t('transactions.detail.noCard')}</Typography.Text>
        )}
      </section>
      <section className="ref-section">
        <Typography.Title level={5}>{t('transactions.detail.channel')}</Typography.Title>
        {txn.paymentChannel ? (
          <div className="row-item" data-channel={txn.paymentChannel.id}>
            <div className="row-main">
              <div className="row-title">
                <Link to={channelHref(txn.paymentChannel.id)}>{txn.paymentChannel.name}</Link>
              </div>
            </div>
            <Tag color={txn.paymentChannel.status === 'active' ? 'green' : undefined}>{t(`channels.statuses.${txn.paymentChannel.status}`)}</Tag>
          </div>
        ) : (
          <Typography.Text type="secondary">{t('transactions.detail.noChannel')}</Typography.Text>
        )}
      </section>
    </Card>
  );
}
