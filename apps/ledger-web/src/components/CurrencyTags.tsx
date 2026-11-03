import { StarFilled } from '@ant-design/icons';
import { Tag, Tooltip } from 'antd';
import type { AccountCurrencyDto } from '@xui/ledger-shared';
import { useTranslation } from 'react-i18next';
import { currencyName } from '../lib/currencies.ts';

/**
 * An account's currencies as chips. Active ones first (the default highlighted), then the closed
 * ones after an explicit "closed" label, muted — they still show up (filters include them) but
 * can't be mistaken for currencies in use. No amounts.
 */
export function CurrencyTags({ currencies }: { currencies: AccountCurrencyDto[] }) {
  const { t, i18n } = useTranslation();
  const active = currencies.filter((c) => c.status === 'active');
  const closed = currencies.filter((c) => c.status === 'closed');
  const tag = (c: AccountCurrencyDto) => (
    <Tooltip
      key={c.currency}
      title={`${currencyName(c.currency, i18n.language)}${c.isDefault ? ` · ${t('accounts.currency.default')}` : ''}${c.status === 'closed' ? ` · ${t('accounts.currency.closed')}` : ''}`}
    >
      <Tag
        className={`currency-tag ${c.isDefault ? 'is-default' : ''} ${c.status === 'closed' ? 'is-closed' : ''}`}
        color={c.isDefault ? 'blue' : undefined}
        data-currency={c.currency}
        data-status={c.status}
        icon={c.isDefault ? <StarFilled aria-label={t('accounts.currency.default')} /> : undefined}
      >
        {c.currency}
      </Tag>
    </Tooltip>
  );
  return (
    <span className="currency-tags">
      {active.map(tag)}
      {closed.length > 0 && (
        <span className="currency-closed-group">
          <span className="currency-closed-label">{t('accounts.currency.closed')}</span>
          {closed.map(tag)}
        </span>
      )}
    </span>
  );
}
