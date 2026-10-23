import { DeleteOutlined } from '@ant-design/icons';
import { useQueryClient } from '@tanstack/react-query';
import { Alert, App, Button, Checkbox, Col, Collapse, DatePicker, Form, Input, Modal, Popconfirm, Row, Segmented, Select, Space, Typography, type InputProps } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import {
  fromMinor,
  HIDDEN_TAG,
  parseTimeOfDay,
  VERIFICATION_STATUSES,
  type AccountDto,
  type TagDto,
  type TransactionDto,
  type TransactionType,
  type VerificationStatus,
} from '@z-ui/shared';
import { del, post, put } from '../api/client.ts';
import { errorText, invalidateLedger } from '../api/hooks.ts';
import { cardLabel, useAccountOptions, useDecimals, useLookups } from '../lib/format.ts';
import { CustomFieldInputs } from './CustomFields.tsx';
import { MoneyInput } from './Money.tsx';

interface Values {
  type: TransactionType;
  accountId?: string;
  currency?: string;
  cardId?: string | null;
  fromAccountId?: string;
  fromCurrency?: string;
  toAccountId?: string;
  toCurrency?: string;
  amount?: number | null;
  toAmount?: number | null;
  categoryId?: string | null;
  counterparty?: string;
  note?: string;
  occurredAt: Dayjs;
  tagIds?: string[];
  extra?: Record<string, unknown>;
  // Optional details. Empty stays empty: no time or source is ever filled in for the user.
  /** The "HH:mm" string itself (never a Date), as stored and as typed. */
  occurredTime?: string;
  timeZone?: string | null;
  purpose?: string;
  paymentChannel?: string;
  referenceNumber?: string;
  evidenceSource?: string;
  /** '' = not marked. */
  verificationStatus?: VerificationStatus | '';
}

const DETAIL_FIELDS = ['occurredTime', 'timeZone', 'purpose', 'paymentChannel', 'referenceNumber', 'evidenceSource', 'verificationStatus'] as const;

/**
 * Local time of day typed as text. The form holds the "HH:mm" string itself: no Date or Dayjs is
 * ever made from it, so the browser's date and zone (DST gaps included) can't change it. On blur a
 * loose entry ("930", "9:30") is tidied to "09:30"; anything else is left for the validator.
 */
function TimeOfDayInput({ value, onChange, ...rest }: Omit<InputProps, 'value' | 'onChange'> & { value?: string; onChange?: (v: string) => void }) {
  return (
    <Input
      {...rest}
      value={value ?? ''}
      onChange={(e) => onChange?.(e.target.value)}
      onBlur={() => {
        const tidy = value ? parseTimeOfDay(value) : null;
        if (tidy && tidy !== value) onChange?.(tidy);
      }}
      maxLength={5}
      inputMode="numeric"
      autoComplete="off"
      allowClear
    />
  );
}

const hasDetails = (tx: TransactionDto | null | undefined) => !!tx && DETAIL_FIELDS.some((k) => !!tx[k]);

/** IANA zones known to the browser; the browser's own zone first. */
function timeZoneOptions(current?: string | null) {
  let zones: string[] = [];
  try {
    zones = Intl.supportedValuesOf('timeZone');
  } catch {
    /* older browsers: only the local zone and UTC */
  }
  const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const list = [...new Set([local, ...zones, 'UTC', ...(current ? [current] : [])])].filter(Boolean);
  return list.map((z) => ({ value: z, label: z }));
}

export interface TxDefaults {
  type?: TransactionType;
  accountId?: string;
  cardId?: string;
}

function initialValues(tx: TransactionDto | null | undefined, d: TxDefaults): Partial<Values> {
  if (!tx) return { type: d.type ?? 'expense', accountId: d.accountId, cardId: d.cardId, occurredAt: dayjs(), tagIds: [], extra: {}, verificationStatus: '' };
  const common = {
    occurredAt: dayjs(tx.occurredAt),
    note: tx.note ?? undefined,
    counterparty: tx.counterparty ?? undefined,
    tagIds: tx.tagIds,
    extra: tx.extra,
    categoryId: tx.categoryId,
    occurredTime: tx.occurredTime ?? undefined,
    timeZone: tx.timeZone,
    purpose: tx.purpose ?? undefined,
    paymentChannel: tx.paymentChannel ?? undefined,
    referenceNumber: tx.referenceNumber ?? undefined,
    evidenceSource: tx.evidenceSource ?? undefined,
    verificationStatus: tx.verificationStatus ?? ('' as const),
  };
  if (tx.type === 'transfer') {
    const out = tx.amount < 0;
    const other = { accountId: tx.counterpartAccountId ?? undefined, currency: tx.counterpartCurrency ?? undefined, amount: tx.counterpartAmount ?? 0 };
    return {
      ...common,
      type: 'transfer',
      fromAccountId: out ? tx.accountId : other.accountId,
      fromCurrency: out ? tx.currency : other.currency,
      toAccountId: out ? other.accountId : tx.accountId,
      toCurrency: out ? other.currency : tx.currency,
      amount: out ? -tx.amount : -other.amount,
      toAmount: out ? other.amount : tx.amount,
    };
  }
  return { ...common, type: tx.type, accountId: tx.accountId, currency: tx.currency, cardId: tx.cardId, amount: tx.type === 'adjustment' ? tx.amount : Math.abs(tx.amount) };
}

/** Currency picker shown only for multi-currency accounts. */
function CurrencyPick({ account, value, onChange }: { account?: AccountDto; value?: string; onChange?: (v: string) => void }) {
  if (!account || account.currencies.length < 2) return null;
  return (
    <Select
      style={{ width: 96, flex: '0 0 auto' }}
      value={value ?? account.currency}
      onChange={onChange}
      options={account.currencies.map((c) => ({ value: c.currency, label: c.currency }))}
    />
  );
}

export function TransactionModal({
  open,
  onClose,
  editing,
  defaults = {},
}: {
  open: boolean;
  onClose: () => void;
  editing?: TransactionDto | null;
  defaults?: TxDefaults;
}) {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [form] = Form.useForm<Values>();
  const [busy, setBusy] = useState(false);
  const L = useLookups();
  const navigate = useNavigate();
  const decimals = useDecimals();
  const accountOptions = useAccountOptions();

  const type = Form.useWatch('type', form) ?? 'expense';
  const accountId = Form.useWatch('accountId', form);
  const fromId = Form.useWatch('fromAccountId', form);
  const toId = Form.useWatch('toAccountId', form);
  const amount = Form.useWatch('amount', form);
  const toAmount = Form.useWatch('toAmount', form);
  const currencyField = Form.useWatch('currency', form);
  const fromCurField = Form.useWatch('fromCurrency', form);
  const toCurField = Form.useWatch('toCurrency', form);
  const detailsFilled = Form.useWatch((v: Values) => DETAIL_FIELDS.filter((k) => !!v[k]).length, form) ?? 0;
  const savedTimeZone = editing?.timeZone;
  const zoneOptions = useMemo(() => timeZoneOptions(savedTimeZone), [savedTimeZone]);
  // The simple form by default; details open when the edited transaction has some.
  const [detailsOpen, setDetailsOpen] = useState(false);

  useEffect(() => {
    if (open) {
      form.resetFields();
      form.setFieldsValue(initialValues(editing, defaults) as Values);
      setDetailsOpen(hasDetails(editing));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editing]);

  const account = accountId ? L.acc.get(accountId) : undefined;
  const from = fromId ? L.acc.get(fromId) : undefined;
  const to = toId ? L.acc.get(toId) : undefined;
  const currency = currencyField ?? account?.currency;
  const fromCurrency = fromCurField ?? from?.currency;
  const toCurrency = toCurField ?? to?.currency;
  const crossCurrency = !!fromCurrency && !!toCurrency && fromCurrency !== toCurrency;

  const cardOptions = useMemo(
    () => L.cards.filter((c) => c.accountId === accountId && !c.archived && c.status !== 'closed').map((c) => ({ value: c.id, label: cardLabel(c) })),
    [L.cards, accountId],
  );
  const categoryOptions = useMemo(
    () => L.categories.filter((c) => !c.archived && c.kind === (type === 'income' ? 'income' : 'expense')).map((c) => ({ value: c.id, label: c.name })),
    [L.categories, type],
  );
  const tagOptions = useMemo(() => L.tags.map((tg) => ({ value: tg.id, label: tg.name })), [L.tags]);
  const hiddenTag = L.tags.find((tg) => tg.name.toLowerCase() === HIDDEN_TAG);

  const rate =
    crossCurrency && amount && toAmount
      ? (Number(fromMinor(toAmount, decimals(toCurrency!))) / Number(fromMinor(amount, decimals(fromCurrency!)))).toFixed(4)
      : null;

  const submit = async (v: Values) => {
    setBusy(true);
    try {
      // Tags typed in the select that don't exist yet are created first.
      const known = new Set(L.tags.map((x) => x.id));
      const tagIds: string[] = [];
      for (const id of v.tagIds ?? []) {
        if (known.has(id)) tagIds.push(id);
        else tagIds.push((await post<TagDto>('/tags', { name: id })).id);
      }
      const base = {
        occurredAt: v.occurredAt.format('YYYY-MM-DD'),
        note: v.note || null,
        counterparty: v.counterparty || null,
        tagIds,
        extra: v.extra ?? {},
        // Always sent, so clearing a field clears it (the API keeps fields that are left out).
        // Blank (cleared) → null, never "00:00"; an untouched stored value goes back unchanged.
        occurredTime: v.occurredTime?.trim() ? parseTimeOfDay(v.occurredTime) : null,
        timeZone: v.timeZone || null,
        purpose: v.purpose?.trim() || null,
        paymentChannel: v.paymentChannel?.trim() || null,
        referenceNumber: v.referenceNumber?.trim() || null,
        evidenceSource: v.evidenceSource?.trim() || null,
        verificationStatus: v.verificationStatus || null,
      };
      const body =
        v.type === 'transfer'
          ? { ...base, type: 'transfer', fromAccountId: v.fromAccountId, fromCurrency, toAccountId: v.toAccountId, toCurrency, amount: v.amount, toAmount: crossCurrency ? v.toAmount : null }
          : v.type === 'adjustment'
            ? { ...base, type: 'adjustment', accountId: v.accountId, currency, amount: v.amount }
            : { ...base, type: v.type, accountId: v.accountId, currency, cardId: v.cardId || null, categoryId: v.categoryId || null, amount: v.amount };
      if (editing) await put(`/transactions/${editing.id}`, body);
      else await post('/transactions', body);
      await invalidateLedger(qc);
      void message.success(t('common.saved'));
      onClose();
    } catch (e) {
      void message.error(errorText(e, t));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!editing) return;
    try {
      await del(`/transactions/${editing.id}`);
      await invalidateLedger(qc);
      void message.success(t('common.deleted'));
      onClose();
    } catch (e) {
      void message.error(errorText(e, t));
    }
  };

  // Cash legs of stock trades belong to the trade; they are edited on the investments page.
  if (editing?.type === 'trade') {
    return (
      <Modal
        open={open}
        onCancel={onClose}
        title={t('tx.types.trade')}
        destroyOnHidden
        footer={
          <Space>
            <Button onClick={onClose}>{t('common.close')}</Button>
            <Button type="primary" onClick={() => (onClose(), navigate('/invest'))}>
              {t('nav.invest')}
            </Button>
          </Space>
        }
      >
        <Alert type="info" showIcon message={t('invest.tradeTx')} />
      </Modal>
    );
  }

  return (
    <Modal
      open={open}
      onCancel={onClose}
      title={editing ? t('tx.edit') : t('tx.add')}
      destroyOnHidden
      width={520}
      footer={
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span>
            {editing && (
              <Popconfirm title={t('common.deleteConfirm')} description={editing.transferGroupId ? t('tx.deleteTransfer') : undefined} onConfirm={remove}>
                <Button danger icon={<DeleteOutlined />}>
                  {t('common.delete')}
                </Button>
              </Popconfirm>
            )}
          </span>
          <span style={{ display: 'flex', gap: 8 }}>
            <Button onClick={onClose}>{t('common.cancel')}</Button>
            <Button type="primary" loading={busy} onClick={() => form.submit()}>
              {t('common.save')}
            </Button>
          </span>
        </div>
      }
    >
      <Form form={form} layout="vertical" requiredMark={false} onFinish={submit} style={{ marginTop: 12 }}>
        <Form.Item name="type" style={{ marginBottom: 16 }}>
          <Segmented block options={(['expense', 'income', 'transfer', 'adjustment'] as const).map((k) => ({ value: k, label: t(`tx.types.${k}`) }))} />
        </Form.Item>

        {type === 'transfer' ? (
          <>
            <Form.Item label={t('tx.from')} required htmlFor="fromAccountId">
              <Space.Compact block>
                <Form.Item name="fromAccountId" noStyle rules={[{ required: true }]}>
                  <Select options={accountOptions} showSearch={{ optionFilterProp: 'label' }} onChange={() => form.setFieldValue('fromCurrency', undefined)} />
                </Form.Item>
                <Form.Item name="fromCurrency" noStyle>
                  <CurrencyPick account={from} />
                </Form.Item>
              </Space.Compact>
            </Form.Item>
            <Form.Item label={t('tx.to')} required htmlFor="toAccountId">
              <Space.Compact block>
                <Form.Item
                  name="toAccountId"
                  noStyle
                  dependencies={['fromAccountId', 'fromCurrency', 'toCurrency']}
                  rules={[
                    { required: true },
                    // The same account is fine when exchanging between two of its currencies.
                    { validator: (_, v) => (v && v === fromId && fromCurrency === toCurrency ? Promise.reject(new Error('≠')) : Promise.resolve()) },
                  ]}
                >
                  <Select options={accountOptions} showSearch={{ optionFilterProp: 'label' }} onChange={() => form.setFieldValue('toCurrency', undefined)} />
                </Form.Item>
                <Form.Item name="toCurrency" noStyle>
                  <CurrencyPick account={to} />
                </Form.Item>
              </Space.Compact>
            </Form.Item>
            <Form.Item name="amount" label={t('common.amount')} rules={[{ required: true }]}>
              <MoneyInput currency={fromCurrency ?? '—'} autoFocus />
            </Form.Item>
            {crossCurrency && (
              <Form.Item name="toAmount" label={t('tx.toAmount')} rules={[{ required: true }]} extra={rate ? t('tx.rate', { from: fromCurrency, rate, to: toCurrency }) : undefined}>
                <MoneyInput currency={toCurrency!} />
              </Form.Item>
            )}
          </>
        ) : (
          <>
            <Form.Item name="accountId" label={t('tx.account')} rules={[{ required: true }]}>
              <Select
                options={accountOptions}
                showSearch={{ optionFilterProp: 'label' }}
                onChange={() => {
                  form.setFieldValue('cardId', null);
                  form.setFieldValue('currency', undefined);
                }}
              />
            </Form.Item>
            <Form.Item label={t('common.amount')} required htmlFor="amount" extra={type === 'adjustment' ? t('tx.adjustmentHint') : undefined}>
              <Space.Compact block>
                <Form.Item name="currency" noStyle>
                  <CurrencyPick account={account} />
                </Form.Item>
                <Form.Item name="amount" noStyle rules={[{ required: true }]}>
                  <MoneyInput currency={currency ?? '—'} allowNegative={type === 'adjustment'} autoFocus />
                </Form.Item>
              </Space.Compact>
            </Form.Item>
            {type !== 'adjustment' && (
              <>
                {cardOptions.length > 0 && (
                  <Form.Item name="cardId" label={t('tx.card')}>
                    <Select allowClear options={cardOptions} placeholder={t('common.optional')} />
                  </Form.Item>
                )}
                <Form.Item name="categoryId" label={t('tx.category')}>
                  <Select allowClear options={categoryOptions} showSearch={{ optionFilterProp: 'label' }} placeholder={t('common.optional')} />
                </Form.Item>
                <Form.Item name="counterparty" label={t('tx.counterparty')}>
                  <Input maxLength={128} />
                </Form.Item>
              </>
            )}
          </>
        )}

        <Form.Item name="occurredAt" label={t('common.date')} rules={[{ required: true }]}>
          <DatePicker style={{ width: '100%' }} allowClear={false} />
        </Form.Item>
        <Form.Item name="tagIds" label={t('tx.tags')} extra={<Typography.Text type="secondary" style={{ fontSize: 12 }}>{t('tx.tagsHint')}</Typography.Text>}>
          <Select mode="tags" options={tagOptions} showSearch={{ optionFilterProp: 'label' }} tokenSeparators={[',', '，']} />
        </Form.Item>
        {/* Shortcut for the "hidden" tag: small spending left out of the list, still in the stats. */}
        <Form.Item noStyle shouldUpdate={(a, b) => a.tagIds !== b.tagIds}>
          {() => {
            const ids: string[] = form.getFieldValue('tagIds') ?? [];
            const isHidden = (x: string) => x === hiddenTag?.id || x.toLowerCase() === HIDDEN_TAG;
            return (
              <Form.Item style={{ marginTop: -8 }}>
                <Checkbox
                  checked={ids.some(isHidden)}
                  onChange={(e) => form.setFieldValue('tagIds', e.target.checked ? [...ids, hiddenTag?.id ?? HIDDEN_TAG] : ids.filter((x) => !isHidden(x)))}
                >
                  {t('tx.markHidden')}
                </Checkbox>
              </Form.Item>
            );
          }}
        </Form.Item>
        <Form.Item name="note" label={t('common.note')}>
          <Input.TextArea autoSize={{ minRows: 1, maxRows: 4 }} maxLength={2000} />
        </Form.Item>
        <Collapse
          ghost
          size="small"
          style={{ margin: '-8px -12px 8px' }}
          activeKey={detailsOpen ? ['details'] : []}
          onChange={(keys) => setDetailsOpen(keys.includes('details'))}
          items={[
            {
              key: 'details',
              label: (
                <span>
                  {t('tx.details')}
                  {detailsFilled > 0 && (
                    <Typography.Text type="secondary" style={{ marginLeft: 8, fontSize: 12 }}>
                      {t('tx.detailsFilled', { n: detailsFilled })}
                    </Typography.Text>
                  )}
                </span>
              ),
              // Kept mounted while collapsed so the values are still submitted.
              forceRender: true,
              children: (
                <>
                  <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: -4 }}>
                    {t('tx.detailsHint')}
                  </Typography.Paragraph>
                  <Row gutter={12}>
                    <Col span={10}>
                      <Form.Item
                        name="occurredTime"
                        label={t('tx.occurredTime')}
                        rules={[{ validator: (_, v?: string) => (!v?.trim() || parseTimeOfDay(v) ? Promise.resolve() : Promise.reject(new Error(t('tx.occurredTimeInvalid')))) }]}
                      >
                        <TimeOfDayInput placeholder={t('tx.occurredTimePlaceholder')} />
                      </Form.Item>
                    </Col>
                    <Col span={14}>
                      <Form.Item name="timeZone" label={t('tx.timeZone')}>
                        <Select allowClear showSearch={{ optionFilterProp: 'label' }} options={zoneOptions} placeholder={t('tx.timeZonePlaceholder')} />
                      </Form.Item>
                    </Col>
                  </Row>
                  <Form.Item name="purpose" label={t('tx.purpose')}>
                    <Input maxLength={500} />
                  </Form.Item>
                  <Row gutter={12}>
                    <Col span={12}>
                      <Form.Item name="paymentChannel" label={t('tx.paymentChannel')}>
                        <Input maxLength={64} placeholder={t('tx.paymentChannelPlaceholder')} />
                      </Form.Item>
                    </Col>
                    <Col span={12}>
                      <Form.Item name="referenceNumber" label={t('tx.referenceNumber')}>
                        <Input maxLength={128} />
                      </Form.Item>
                    </Col>
                  </Row>
                  <Form.Item name="evidenceSource" label={t('tx.evidenceSource')}>
                    <Input maxLength={500} placeholder={t('tx.evidenceSourcePlaceholder')} />
                  </Form.Item>
                  <Form.Item name="verificationStatus" label={t('tx.verificationStatus')} style={{ marginBottom: 8 }}>
                    <Select
                      options={[
                        { value: '', label: t('tx.verification.none') },
                        ...VERIFICATION_STATUSES.map((k) => ({ value: k, label: t(`tx.verification.${k}`) })),
                      ]}
                    />
                  </Form.Item>
                </>
              ),
            },
          ]}
        />
        <CustomFieldInputs entity="transaction" />
      </Form>
    </Modal>
  );
}
