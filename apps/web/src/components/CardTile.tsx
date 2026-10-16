import { LockOutlined } from '@ant-design/icons';
import { Progress, Tag } from 'antd';
import { useTranslation } from 'react-i18next';
import { BRAND_META, isExpired, type CardDto } from '@z-ui/shared';
import { cardLabel, useLookups, useMoney } from '../lib/format.ts';
import { BankCard } from './BankCard.tsx';

/** Dense card row: thumbnail face + the facts that matter (status, expiry, due day, limit). */
export function CardTile({ card, onClick, indent = false }: { card: CardDto; onClick?: () => void; indent?: boolean }) {
  const { t } = useTranslation();
  const L = useLookups();
  const money = useMoney();
  const account = L.acc.get(card.accountId);
  const inst = account ? L.inst.get(account.institutionId) : undefined;
  const parent = card.parentCardId ? L.card.get(card.parentCardId) : undefined;
  const expired = card.expMonth && card.expYear ? isExpired(card.expMonth, card.expYear) : false;
  const usage = card.spendLimit && card.spent !== null ? Math.min(100, Math.round((card.spent / card.spendLimit) * 100)) : null;
  return (
    <div className={`card-tile ${indent ? 'indent' : ''} ${card.archived ? 'archived' : ''}`} onClick={onClick}>
      <BankCard card={card} bankName={inst?.name} width={indent ? 112 : 132} />
      <div className="card-tile-info">
        <div className="card-tile-title">
          <span className="row-title">{card.nickname ?? `${BRAND_META[card.brand].label} •••• ${card.last4}`}</span>
          {card.form === 'virtual' && <Tag color="purple">{t('card.forms.virtual')}</Tag>}
          {card.status !== 'active' && <Tag color={card.status === 'frozen' ? 'blue' : 'default'}>{t(`card.statuses.${card.status}`)}</Tag>}
          {card.singleUse && <Tag>{t('card.singleUse')}</Tag>}
          {expired && <Tag color="red">{t('card.expired')}</Tag>}
        </div>
        <div className="row-sub">
          {BRAND_META[card.brand].label} •••• {card.last4} · {t(`card.fundings.${card.funding}`)}
          {card.expMonth && card.expYear ? ` · ${String(card.expMonth).padStart(2, '0')}/${String(card.expYear).slice(-2)}` : ''}
        </div>
        {card.funding === 'credit' && (card.statementDay || card.dueDay) && (
          <div className="row-sub">
            {t('card.statementDay')} {card.statementDay ?? '—'} · {t('card.dueDay')} {card.dueDay ?? '—'}
          </div>
        )}
        {parent && <div className="row-sub">{t('card.virtualUnder', { name: cardLabel(parent) })}</div>}
        {card.merchant && (
          <div className="row-sub">
            <LockOutlined /> {card.merchant}
          </div>
        )}
        {card.spendLimit && account && (
          <div className="card-tile-limit">
            {usage !== null && <Progress percent={usage} size="small" showInfo={false} strokeColor={usage > 85 ? 'var(--expense)' : undefined} />}
            <span className="row-sub">
              {card.limitPeriod && t(`card.limitPeriods.${card.limitPeriod}`)} {card.spent !== null && `${money(card.spent, account.currency)} / `}
              {money(card.spendLimit, account.currency)}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
