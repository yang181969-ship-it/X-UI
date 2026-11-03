import { Tag, Tooltip } from 'antd';
import { cardExpiry, DEFAULT_EXPIRING_WITHIN_DAYS, localDate } from '@xui/ledger-shared';
import { useTranslation } from 'react-i18next';

/** The user's own calendar day (YYYY-MM-DD): expiry is judged on it, and it is what the list filter sends as today=. */
export const useToday = () => localDate();

/** Expiry state of a card on the user's local day (shared rules: @xui/ledger-shared expiry.ts). Never a card status. */
export function ExpiryTag({ expiresOn, today }: { expiresOn: string | null; today: string }) {
  const { t } = useTranslation();
  const x = cardExpiry(expiresOn, today);
  const tip = t('cards.expiry.hint', { days: DEFAULT_EXPIRING_WITHIN_DAYS });
  const tag = (() => {
    switch (x.status) {
      case 'none':
        return <Tag>{t('cards.expiry.none')}</Tag>;
      case 'expired':
        return <Tag color="red">{`${t('cards.expiry.expired')} · ${expiresOn}`}</Tag>;
      case 'expiring':
        return <Tag color="orange">{`${t('cards.expiry.expiring')} · ${x.daysLeft === 0 ? t('cards.expiry.lastDay') : t('cards.expiry.daysLeft', { count: x.daysLeft! })}`}</Tag>;
      case 'valid':
        return <Tag color="green">{t('cards.expiry.validUntil', { date: expiresOn })}</Tag>;
    }
  })();
  return (
    <Tooltip title={tip}>
      <span className="expiry-tag" data-expiry={x.status}>
        {tag}
      </span>
    </Tooltip>
  );
}
