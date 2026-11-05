import { Button, Card } from 'antd';
import type { SummaryGroup } from '@xui/ledger-shared';
import { Fragment, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatMoney } from '../../lib/money.ts';
import { countText, type CurrencyCard } from '../../lib/summaryView.ts';

/** One server group behind a row: its merchant side / transfer scope and account side, amount and count. */
function GroupLine({ group, exponent }: { group: SummaryGroup; exponent: number }) {
  const { t } = useTranslation();
  const parts = [
    group.merchantScope && t('overview.detail.merchant', { scope: t(`transactions.merchantScopes.${group.merchantScope}`) }),
    group.transferScope && t('overview.detail.transfer', { scope: t(`transactions.transferScopes.${group.transferScope}`) }),
    t('overview.detail.account', { scope: t(`overview.accountScopes.${group.accountScope}`) }),
  ].filter(Boolean);
  return (
    <div className="stat-detail">
      <span className="stat-detail-label">{parts.join(' · ')}</span>
      <span className="stat-row-count muted num">{t('overview.count', { count: group.count })}</span>
      <span className="stat-row-amount num" data-amount={group.amount}>
        {formatMoney(group.amount, exponent)}
      </span>
    </div>
  );
}

/**
 * One currency (with its saved exponent) of one block: the six activity rows, each with its own
 * confirmed amount and transaction count; "—" where nothing was recorded. Nothing is added across
 * rows. "Details" shows the server's groups behind each row.
 */
export function CurrencyStatCard({ card, block }: { card: CurrencyCard; block: 'foreign' | 'undetermined' }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <Card
      size="small"
      className="stat-card"
      data-block={block}
      data-currency={card.currency}
      data-exponent={card.exponent}
      title={<span className="stat-currency">{card.currency}</span>}
      extra={<span className="muted stat-exponent">{t('overview.exponent', { count: card.exponent })}</span>}
    >
      <div className="stat-rows" role="table" aria-label={`${t(`overview.blocks.${block}`)} · ${card.currency}`}>
        <div className="stat-row stat-row-head" role="row">
          <span role="columnheader" />
          <span role="columnheader" className="muted" />
          <span role="columnheader" className="muted stat-row-amount">
            {t('overview.confirmedAmount')}
          </span>
        </div>
        {card.rows.map((r) => (
          <Fragment key={r.key}>
            <div className={`stat-row ${r.count === 0 ? 'is-empty' : ''}`} role="row" data-row={r.key}>
              <span role="cell" className="stat-row-label">
                {t(`overview.rows.${r.key}`)}
              </span>
              <span role="cell" className="stat-row-count muted num">
                {r.count === 0 ? countText(0) : t('overview.count', { count: r.count })}
              </span>
              <span role="cell" className="stat-row-amount num" data-amount={r.amount ?? ''}>
                {r.amount === null ? '—' : formatMoney(r.amount, card.exponent)}
              </span>
            </div>
            {open && r.details.map((g) => <GroupLine key={`${g.merchantScope}|${g.transferScope}|${g.accountScope}`} group={g} exponent={card.exponent} />)}
          </Fragment>
        ))}
      </div>
      <div className="stat-card-foot">
        <span className="muted field-note">{t('overview.cardNote')}</span>
        <Button type="link" size="small" className="stat-details-toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {open ? t('overview.hideDetails') : t('overview.details')}
        </Button>
      </div>
    </Card>
  );
}
