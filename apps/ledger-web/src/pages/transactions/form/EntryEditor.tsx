import { Checkbox, Col, Form, Row, Select, Switch, Tag } from 'antd';
import type { AccountListItem, EntryDirection, RecordMode } from '@xui/ledger-shared';
import { useTranslation } from 'react-i18next';
import { AmountInput } from '../../../components/AmountInput.tsx';
import { currencyName } from '../../../lib/currencies.ts';
import type { EntryPrefill } from '../../../lib/prefill.ts';
import type { EntryDraft } from '../../../lib/txnDraft.ts';
import type { IssueMap } from './issues.ts';
import { useFieldStatus } from './issues.ts';

/**
 * One entry of the create form: a registered account, one of ITS registered currencies (closed ones
 * only in backfill, each confirmed — P7), the actual amount as typed text, or "pending" (unknown,
 * never estimated). Every user change reports which recommendation fields it touched, so a later
 * recommendation never overwrites them.
 */
export function EntryEditor({
  direction,
  entry,
  accounts,
  recordMode,
  label,
  amountLabel,
  issues,
  onChange,
  disabled = false,
}: {
  direction: EntryDirection;
  entry: EntryDraft;
  accounts: AccountListItem[];
  recordMode: RecordMode;
  label: string;
  amountLabel: string;
  issues: IssueMap;
  onChange: (patch: Partial<EntryDraft>, touched: (keyof EntryPrefill)[]) => void;
  /** The whole form is locked (a request in flight or an unknown outcome): every control, explicitly. */
  disabled?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const status = useFieldStatus(issues);
  const f = (k: string) => `entry.${direction}.${k}`;
  const account = accounts.find((a) => a.id === entry.accountId);
  const backfill = recordMode === 'backfill';
  const current = account?.currencies.find((c) => c.currency === entry.currency);
  const closed = current?.status === 'closed';
  const currencyOptions = (account?.currencies ?? [])
    .slice()
    .sort((a, b) => (a.status === b.status ? a.sort - b.sort : a.status === 'active' ? -1 : 1))
    .map((c) => ({
      value: c.currency,
      // Closed currencies: only for a backfill, confirmed per entry (P7); never in a current transaction.
      disabled: c.status === 'closed' && !backfill,
      label: `${c.currency} · ${currencyName(c.currency, i18n.language)}${c.status === 'closed' ? ` ${t('transactions.form.closedCurrency')}` : ''}`,
    }));

  return (
    <div className="txn-entry-editor" data-direction={direction}>
      <Row gutter={16}>
        <Col xs={24} md={12}>
          <Form.Item label={label} required {...status(f('accountId'))}>
            <Select<string>
              aria-label={label}
              disabled={disabled}
              showSearch={{ optionFilterProp: 'label' }}
              placeholder={t('transactions.form.chooseAccount')}
              value={entry.accountId ?? undefined}
              onChange={(id) => {
                const next = accounts.find((a) => a.id === id);
                // A currency the new account does not have is cleared (never guessed).
                const keep = !!next?.currencies.some((c) => c.currency === entry.currency);
                onChange({ accountId: id, ...(keep ? {} : { currency: null, closedAck: false }) }, ['accountId']);
              }}
              options={accounts.map((a) => ({
                value: a.id,
                label: `${a.name}${a.status !== 'active' ? ` (${t(`accounts.statuses.${a.status}`)})` : ''}`,
              }))}
            />
          </Form.Item>
        </Col>
        <Col xs={24} md={12}>
          <Form.Item label={t('transactions.form.fundingCurrency')} required {...status(f('currency'))} extra={account ? undefined : t('transactions.form.currencyAfterAccount')}>
            <Select<string>
              aria-label={`${label} · ${t('transactions.form.fundingCurrency')}`}
              placeholder={t('transactions.form.chooseCurrency')}
              disabled={disabled || !account}
              value={entry.currency ?? undefined}
              onChange={(c) => onChange({ currency: c, closedAck: false }, ['currency'])}
              options={currencyOptions}
            />
          </Form.Item>
        </Col>
      </Row>
      <Row gutter={16} align="middle">
        <Col xs={24} md={12}>
          <Form.Item label={amountLabel} required={!entry.pending} {...status(f('amount'))}>
            <AmountInput aria-label={amountLabel} value={entry.amountText} currency={entry.currency} disabled={disabled || entry.pending} onChange={(text) => onChange({ amountText: text }, ['amountText'])} />
          </Form.Item>
        </Col>
        <Col xs={24} md={12}>
          <Form.Item label={t('transactions.form.pendingLabel')} extra={t('transactions.form.pendingHint')}>
            <Switch aria-label={`${label} · ${t('transactions.form.pendingLabel')}`} checked={entry.pending} disabled={disabled} onChange={(v) => onChange({ pending: v }, ['amountText'])} />
          </Form.Item>
        </Col>
      </Row>
      {backfill && closed && (
        <Form.Item {...status(f('closedAck'))} className="txn-closed-ack">
          <Checkbox checked={entry.closedAck} disabled={disabled} onChange={(e) => onChange({ closedAck: e.target.checked }, [])}>
            {t('transactions.form.closedAck', { currency: entry.currency })} <Tag>{t('transactions.form.statusAtSave')}</Tag>
          </Checkbox>
        </Form.Item>
      )}
    </div>
  );
}
