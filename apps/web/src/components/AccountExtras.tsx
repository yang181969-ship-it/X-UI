import { WarningFilled } from '@ant-design/icons';
import { Progress, Tooltip } from 'antd';
import { useTranslation } from 'react-i18next';
import type { AccountDto } from '@z-ui/shared';
import { useMoney } from '../lib/format.ts';

/** Status colors (fixed, never series colors) and always paired with a label/icon. */
const usageColor = (percent: number) => (percent > 100 ? 'var(--ant-color-error)' : percent >= 80 ? 'var(--ant-color-warning)' : 'var(--ant-color-primary)');

/**
 * Share of a credit account's limit in use. `compact` is the one-line form for lists; the full
 * form shows owed / limit underneath.
 */
export function CreditUsage({ usage, currency, compact = false }: { usage: NonNullable<AccountDto['creditUsage']>; currency: string; compact?: boolean }) {
  const { t } = useTranslation();
  const money = useMoney();
  const label = usage.over ? t('account.overLimit', { amount: money(usage.used - usage.limit, currency) }) : t('account.usedPercent', { n: usage.percent });
  const bar = (
    <Progress
      percent={Math.min(100, usage.percent)}
      showInfo={false}
      size={compact ? { width: 48, height: 4 } : 'small'}
      strokeColor={usageColor(usage.percent)}
      style={{ margin: 0, width: compact ? 48 : '100%' }}
    />
  );
  if (compact) {
    return (
      <Tooltip title={`${money(usage.used, currency)} / ${money(usage.limit, currency)}`}>
        <span className={`credit-usage compact ${usage.over ? 'over' : ''}`}>
          {bar}
          <span className="credit-usage-label">
            {usage.over && <WarningFilled />} {label}
          </span>
        </span>
      </Tooltip>
    );
  }
  return (
    <div className={`credit-usage ${usage.over ? 'over' : ''}`}>
      {bar}
      <div className="credit-usage-text">
        <span>
          {usage.over && <WarningFilled />} {label}
        </span>
        <span className="muted num">
          {money(usage.used, currency)} / {money(usage.limit, currency)}
        </span>
      </div>
    </div>
  );
}

/** "Holdings $X · cash $Y" for accounts holding stocks (their USD balance includes both). */
export function InvestmentLine({ account }: { account: AccountDto }) {
  const { t } = useTranslation();
  const money = useMoney();
  const inv = account.investment;
  if (!inv) return null;
  const usd = account.currencies.find((c) => c.currency === 'USD');
  const cash = usd ? usd.balance - inv.marketValue : null;
  return (
    <span className="muted" style={{ fontSize: 12 }}>
      {t('account.holdingsValue', { amount: money(inv.marketValue, 'USD') })}
      {cash !== null && cash !== 0 && ` · ${t('account.cashPart', { amount: money(cash, 'USD') })}`}
      {inv.unpriced > 0 && ` · ${t('account.unpriced', { n: inv.unpriced })}`}
    </span>
  );
}
