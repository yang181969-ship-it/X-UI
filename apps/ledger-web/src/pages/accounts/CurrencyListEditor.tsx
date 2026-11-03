import { ArrowDownOutlined, ArrowUpOutlined, DeleteOutlined } from '@ant-design/icons';
import { Button, Radio, Segmented, Select, Tooltip } from 'antd';
import { ACCOUNT_CURRENCIES_MAX, type AccountCurrencyInput, type AccountCurrencyStatus, type CurrencyCode } from '@xui/ledger-shared';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { currencyName, currencyOptions } from '../../lib/currencies.ts';

export type CurrencyItem = { code: CurrencyCode; isDefault: boolean; status: AccountCurrencyStatus };

export const toInput = (list: CurrencyItem[]): AccountCurrencyInput[] =>
  list.map((c) => ({ code: c.code, ...(c.isDefault && { isDefault: true }), status: c.status }));

/** The same rules as accountCurrencyListSchema, as a form-rule message (or null when valid). */
export function currencyListProblem(list: CurrencyItem[] | undefined, t: (k: string) => string): string | null {
  if (!list?.length) return t('accounts.currency.none');
  const defaults = list.filter((c) => c.isDefault);
  if (defaults.length !== 1) return t('accounts.currency.oneDefault');
  if (defaults[0]!.status !== 'active') return t('accounts.currency.defaultActive');
  return null;
}

/**
 * Edit an account's currency list (antd Form control: value / onChange). One default (radio), each
 * currency active or closed, order = list order. The default can't be closed or removed — another
 * currency has to become the default first. The first currency added becomes the default.
 */
export function CurrencyListEditor({ value = [], onChange, id }: { value?: CurrencyItem[]; onChange?: (v: CurrencyItem[]) => void; id?: string }) {
  const { t, i18n } = useTranslation();
  const options = useMemo(() => currencyOptions(i18n.language, value.map((c) => c.code)), [i18n.language, value]);
  const set = (next: CurrencyItem[]) => onChange?.(next);
  const update = (i: number, patch: Partial<CurrencyItem>) => set(value.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const move = (i: number, d: -1 | 1) => {
    const next = [...value];
    [next[i], next[i + d]] = [next[i + d]!, next[i]!];
    set(next);
  };

  return (
    <div className="currency-editor" id={id}>
      {value.map((c, i) => (
        <div key={c.code} className={`currency-row-edit ${c.status === 'closed' ? 'is-closed' : ''}`} data-currency={c.code}>
          <Tooltip title={t('accounts.currency.setDefault')}>
            <Radio
              checked={c.isDefault}
              disabled={c.status === 'closed'}
              aria-label={`${t('accounts.currency.setDefault')} ${c.code}`}
              onChange={() => set(value.map((x, j) => ({ ...x, isDefault: j === i })))}
            />
          </Tooltip>
          <div className="currency-code">
            <b>{c.code}</b>
            <span className="muted">{currencyName(c.code, i18n.language)}</span>
            {c.isDefault && <span className="currency-default-label">{t('accounts.currency.default')}</span>}
          </div>
          <Segmented<AccountCurrencyStatus>
            size="small"
            aria-label={t('accounts.currency.statusLabel', { code: c.code })}
            value={c.status}
            disabled={c.isDefault}
            onChange={(status) => update(i, { status })}
            options={[
              { value: 'active', label: t('accounts.currency.active') },
              { value: 'closed', label: t('accounts.currency.closed') },
            ]}
          />
          <span className="currency-row-actions">
            <Button type="text" size="small" icon={<ArrowUpOutlined />} disabled={i === 0} aria-label={t('accounts.currency.moveUp', { code: c.code })} onClick={() => move(i, -1)} />
            <Button
              type="text"
              size="small"
              icon={<ArrowDownOutlined />}
              disabled={i === value.length - 1}
              aria-label={t('accounts.currency.moveDown', { code: c.code })}
              onClick={() => move(i, 1)}
            />
            <Button
              type="text"
              size="small"
              danger
              icon={<DeleteOutlined />}
              disabled={c.isDefault}
              aria-label={t('accounts.currency.remove', { code: c.code })}
              onClick={() => set(value.filter((_, j) => j !== i))}
            />
          </span>
        </div>
      ))}
      {value.length < ACCOUNT_CURRENCIES_MAX && (
        <Select<CurrencyCode>
          className="currency-add"
          showSearch={{ optionFilterProp: 'label' }}
          aria-label={t('accounts.currency.add')}
          placeholder={`+ ${t('accounts.currency.add')}`}
          value={null}
          options={options}
          onChange={(code) => set([...value, { code, isDefault: !value.some((c) => c.isDefault), status: 'active' }])}
          style={{ width: 260 }}
        />
      )}
    </div>
  );
}
