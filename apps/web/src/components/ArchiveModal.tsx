import { useQueryClient } from '@tanstack/react-query';
import { Alert, App, Col, ConfigProvider, DatePicker, Divider, Form, Input, Modal, Row, Select, Space, Typography } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ARCHIVE_RECORD_TYPES,
  DATE_PRECISIONS,
  VERIFICATION_STATUSES,
  archivePeriod,
  parseTimeOfDay,
  type ArchiveRecordType,
  type DatePrecision,
  type HistoricalRecordDto,
  type VerificationStatus,
} from '@z-ui/shared';
import { ApiError, post, put } from '../api/client.ts';
import { errorText, useConfig } from '../api/hooks.ts';
import { useAccountOptions } from '../lib/format.ts';
import { MoneyInput } from './Money.tsx';
import { TimeOfDayInput, timeZoneOptions } from './TransactionModal.tsx';

interface Values {
  title: string;
  recordType: ArchiveRecordType;
  datePrecision: DatePrecision;
  /** One picker per precision; only the one for the chosen precision is read. */
  day?: Dayjs | null;
  month?: Dayjs | null;
  year?: Dayjs | null;
  range?: [Dayjs, Dayjs] | null;
  occurredTime?: string;
  timeZone?: string | null;
  amount?: number | null;
  currency?: string | null;
  accountId?: string | null;
  fromAccountId?: string | null;
  toAccountId?: string | null;
  toAmount?: number | null;
  toCurrency?: string | null;
  assetCode?: string;
  assetQuantity?: string;
  feeAmount?: number | null;
  feeCurrency?: string | null;
  exchangeRate?: string;
  counterparty?: string;
  purpose?: string;
  paymentChannel?: string;
  referenceNumber?: string;
  evidenceSource?: string;
  note?: string;
  verificationStatus: VerificationStatus;
}

const DECIMAL_RE = /^\d{1,20}(\.\d{1,18})?$/;
const isAsset = (type: ArchiveRecordType) => type === 'investment' || type === 'crypto';

/** Pickers hold a Dayjs only to show a calendar; the stored dates are always built from its text. */
function initialValues(r: HistoricalRecordDto | null): Partial<Values> {
  if (!r) return { recordType: 'unknown', datePrecision: 'unknown', verificationStatus: 'pending' };
  const from = r.dateFrom ? dayjs(r.dateFrom) : null;
  return {
    title: r.title,
    recordType: r.recordType,
    datePrecision: r.datePrecision,
    day: r.datePrecision === 'day' ? from : null,
    month: r.datePrecision === 'month' ? from : null,
    year: r.datePrecision === 'year' ? from : null,
    range: r.datePrecision === 'range' && r.dateFrom && r.dateTo ? [dayjs(r.dateFrom), dayjs(r.dateTo)] : null,
    occurredTime: r.occurredTime ?? undefined,
    timeZone: r.timeZone,
    amount: r.amount,
    currency: r.currency,
    accountId: r.accountId,
    fromAccountId: r.fromAccountId,
    toAccountId: r.toAccountId,
    toAmount: r.toAmount,
    toCurrency: r.toCurrency,
    assetCode: r.assetCode ?? undefined,
    assetQuantity: r.assetQuantity ?? undefined,
    feeAmount: r.feeAmount,
    feeCurrency: r.feeCurrency,
    exchangeRate: r.exchangeRate ?? undefined,
    counterparty: r.counterparty ?? undefined,
    purpose: r.purpose ?? undefined,
    paymentChannel: r.paymentChannel ?? undefined,
    referenceNumber: r.referenceNumber ?? undefined,
    evidenceSource: r.evidenceSource ?? undefined,
    note: r.note ?? undefined,
    verificationStatus: r.verificationStatus,
  };
}

/** Stored dates for the chosen precision; nothing is filled in for a part that wasn't picked. */
function datesOf(v: Values): { dateFrom: string | null; dateTo: string | null } {
  const none = { dateFrom: null, dateTo: null };
  switch (v.datePrecision) {
    case 'day':
      return v.day ? archivePeriod('day', v.day.format('YYYY-MM-DD'))! : none;
    case 'month':
      return v.month ? archivePeriod('month', v.month.format('YYYY-MM'))! : none;
    case 'year':
      return v.year ? archivePeriod('year', v.year.format('YYYY'))! : none;
    case 'range':
      return v.range ? { dateFrom: v.range[0].format('YYYY-MM-DD'), dateTo: v.range[1].format('YYYY-MM-DD') } : none;
    default:
      return none;
  }
}

const text = (s?: string) => s?.trim() || null;

export function ArchiveModal({ open, editing, onClose, onSaved }: { open: boolean; editing: HistoricalRecordDto | null; onClose: () => void; onSaved?: (r: HistoricalRecordDto) => void }) {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [form] = Form.useForm<Values>();
  const [busy, setBusy] = useState(false);
  const accountOptions = useAccountOptions();
  const { data: cfg } = useConfig();
  const currencyOptions = useMemo(() => (cfg?.currencies ?? []).map((c) => ({ value: c.code, label: c.code })), [cfg]);
  const zoneOptions = useMemo(() => timeZoneOptions(editing?.timeZone), [editing?.timeZone]);

  const recordType = Form.useWatch('recordType', form) ?? 'unknown';
  const precision = Form.useWatch('datePrecision', form) ?? 'unknown';
  const currency = Form.useWatch('currency', form);
  const toCurrency = Form.useWatch('toCurrency', form);
  const feeCurrency = Form.useWatch('feeCurrency', form);
  const locked = editing?.status === 'converted';

  useEffect(() => {
    if (open) {
      form.resetFields();
      form.setFieldsValue(initialValues(editing) as Values);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editing]);

  const submit = async (v: Values) => {
    setBusy(true);
    try {
      const transfer = v.recordType === 'transfer';
      const day = v.datePrecision === 'day';
      // Full replace: fields that don't apply to the chosen kind or precision are sent as null.
      const payload = {
        title: v.title.trim(),
        recordType: v.recordType,
        datePrecision: v.datePrecision,
        ...datesOf(v),
        occurredTime: day && v.occurredTime?.trim() ? parseTimeOfDay(v.occurredTime) : null,
        timeZone: day ? v.timeZone || null : null,
        amount: v.amount ?? null,
        currency: v.currency || null,
        accountId: transfer ? null : v.accountId || null,
        fromAccountId: transfer ? v.fromAccountId || null : null,
        toAccountId: transfer ? v.toAccountId || null : null,
        toAmount: transfer ? (v.toAmount ?? null) : null,
        toCurrency: transfer ? v.toCurrency || null : null,
        assetCode: isAsset(v.recordType) ? text(v.assetCode) : null,
        assetQuantity: isAsset(v.recordType) ? text(v.assetQuantity) : null,
        feeAmount: v.feeAmount ?? null,
        feeCurrency: v.feeCurrency || null,
        exchangeRate: text(v.exchangeRate),
        counterparty: text(v.counterparty),
        purpose: text(v.purpose),
        paymentChannel: text(v.paymentChannel),
        referenceNumber: text(v.referenceNumber),
        evidenceSource: text(v.evidenceSource),
        note: text(v.note),
        verificationStatus: v.verificationStatus,
      };
      // The version shown: if the record changed since, the server refuses instead of overwriting it.
      const saved = editing ? await put<HistoricalRecordDto>(`/archive/${editing.id}`, { ...payload, version: editing.version }) : await post<HistoricalRecordDto>('/archive', payload);
      await Promise.all([qc.invalidateQueries({ queryKey: ['archive'] }), qc.invalidateQueries({ queryKey: ['archive-record'] })]);
      void message.success(t('common.saved'));
      onSaved?.(saved);
      onClose();
    } catch (e) {
      void message.error(errorText(e, t));
      if (e instanceof ApiError && e.code === 'ARCHIVE_CHANGED') await Promise.all([qc.invalidateQueries({ queryKey: ['archive'] }), qc.invalidateQueries({ queryKey: ['archive-record'] })]);
    } finally {
      setBusy(false);
    }
  };

  const amountNeedsCurrency = (amountField: keyof Values) => ({
    validator: (_: unknown, cur?: string | null) =>
      // A fee of 0 ("known: none") needs no currency.
      form.getFieldValue(amountField) && !cur ? Promise.reject(new Error(t('archive.currencyRequired'))) : Promise.resolve(),
  });
  const decimalRule = { validator: (_: unknown, s?: string) => (!s?.trim() || (DECIMAL_RE.test(s.trim()) && /[1-9]/.test(s)) ? Promise.resolve() : Promise.reject(new Error(t('archive.decimalInvalid')))) };

  /** Currency select + amount (minor units of that currency) on one line. */
  const moneyRow = (label: string, amountName: keyof Values, currencyName: keyof Values, cur: string | null | undefined) => (
    <Form.Item label={label} htmlFor={amountName}>
      <Space.Compact block>
        <Form.Item name={currencyName} noStyle dependencies={[amountName]} rules={[amountNeedsCurrency(amountName)]}>
          <Select allowClear showSearch={{ optionFilterProp: 'label' }} placeholder={t('archive.currency')} options={currencyOptions} style={{ width: 110, flex: '0 0 auto' }} aria-label={`${label} ${t('archive.currency')}`} />
        </Form.Item>
        <Form.Item name={amountName} noStyle>
          <MoneyInput currency={cur ?? '—'} />
        </Form.Item>
      </Space.Compact>
    </Form.Item>
  );

  return (
    <Modal
      open={open}
      onCancel={onClose}
      title={editing ? t('archive.edit') : t('archive.add')}
      destroyOnHidden
      width={600}
      okText={t('common.save')}
      cancelText={t('common.cancel')}
      onOk={() => form.submit()}
      confirmLoading={busy}
    >
      <Form form={form} layout="vertical" requiredMark={false} onFinish={submit} style={{ marginTop: 12 }}>
        {locked && <Alert type="info" showIcon title={t('archive.convertedLocked')} style={{ marginBottom: 16 }} />}
        <Form.Item name="title" label={t('archive.recordTitle')} rules={[{ required: true, whitespace: true }]} extra={locked ? t('archive.titleNotSynced') : undefined}>
          <Input maxLength={200} placeholder={t('archive.recordTitlePlaceholder')} autoFocus />
        </Form.Item>
        <ConfigProvider componentDisabled={locked}>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="recordType" label={t('archive.recordType')}>
                <Select options={ARCHIVE_RECORD_TYPES.map((k) => ({ value: k, label: t(`archive.recordTypes.${k}`) }))} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="verificationStatus" label={t('archive.verification')}>
                <Select options={VERIFICATION_STATUSES.map((k) => ({ value: k, label: t(`tx.verification.${k}`) }))} />
              </Form.Item>
            </Col>
          </Row>
          {isAsset(recordType) && <Alert type="warning" showIcon title={t('archive.deferred')} style={{ marginBottom: 16 }} />}
          <Row gutter={12}>
            <Col span={10}>
              <Form.Item name="datePrecision" label={t('archive.datePrecision')}>
                <Select options={DATE_PRECISIONS.map((k) => ({ value: k, label: t(`archive.precisions.${k}`) }))} />
              </Form.Item>
            </Col>
            <Col span={14}>
              {precision === 'day' && (
                <Form.Item name="day" label={t('archive.date')} rules={[{ required: true }]}>
                  <DatePicker style={{ width: '100%' }} />
                </Form.Item>
              )}
              {precision === 'month' && (
                <Form.Item name="month" label={t('archive.date')} rules={[{ required: true }]}>
                  <DatePicker picker="month" style={{ width: '100%' }} />
                </Form.Item>
              )}
              {precision === 'year' && (
                <Form.Item name="year" label={t('archive.date')} rules={[{ required: true }]}>
                  <DatePicker picker="year" style={{ width: '100%' }} />
                </Form.Item>
              )}
              {precision === 'range' && (
                <Form.Item name="range" label={t('archive.date')} rules={[{ required: true }]}>
                  <DatePicker.RangePicker style={{ width: '100%' }} />
                </Form.Item>
              )}
              {precision === 'unknown' && (
                <Form.Item label={t('archive.date')}>
                  <Typography.Text type="secondary">{t('archive.unknownDate')}</Typography.Text>
                </Form.Item>
              )}
            </Col>
          </Row>
          {precision === 'day' && (
            <Row gutter={12}>
              <Col span={10}>
                <Form.Item
                  name="occurredTime"
                  label={t('tx.occurredTime')}
                  extra={<span style={{ fontSize: 12 }}>{t('archive.timeHint')}</span>}
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
          )}

          <Divider titlePlacement="start" plain style={{ margin: '4px 0 12px' }}>
            {t('archive.money')}
          </Divider>
          {moneyRow(t('archive.amount'), 'amount', 'currency', currency)}
          {recordType === 'transfer' ? (
            <>
              <Row gutter={12}>
                <Col span={12}>
                  <Form.Item name="fromAccountId" label={t('archive.fromAccount')}>
                    <Select allowClear options={accountOptions} showSearch={{ optionFilterProp: 'label' }} placeholder={t('common.optional')} />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item name="toAccountId" label={t('archive.toAccount')}>
                    <Select allowClear options={accountOptions} showSearch={{ optionFilterProp: 'label' }} placeholder={t('common.optional')} />
                  </Form.Item>
                </Col>
              </Row>
              {moneyRow(t('archive.toAmount'), 'toAmount', 'toCurrency', toCurrency)}
            </>
          ) : (
            <Form.Item name="accountId" label={t('archive.account')}>
              <Select allowClear options={accountOptions} showSearch={{ optionFilterProp: 'label' }} placeholder={t('common.optional')} />
            </Form.Item>
          )}
          {isAsset(recordType) && (
            <Row gutter={12}>
              <Col span={10}>
                <Form.Item name="assetCode" label={t('archive.assetCode')}>
                  <Input maxLength={32} placeholder={t('archive.assetCodePlaceholder')} />
                </Form.Item>
              </Col>
              <Col span={14}>
                <Form.Item name="assetQuantity" label={t('archive.assetQuantity')} rules={[decimalRule]}>
                  <Input inputMode="decimal" maxLength={40} />
                </Form.Item>
              </Col>
            </Row>
          )}
          <Row gutter={12}>
            <Col span={14}>
              {moneyRow(t('archive.fee'), 'feeAmount', 'feeCurrency', feeCurrency)}
              <Typography.Text type="secondary" style={{ display: 'block', fontSize: 12, marginTop: -16, marginBottom: 16 }}>
                {t('archive.feeHint')}
              </Typography.Text>
            </Col>
            <Col span={10}>
              <Form.Item name="exchangeRate" label={t('archive.exchangeRate')} rules={[decimalRule]}>
                <Input inputMode="decimal" maxLength={32} />
              </Form.Item>
            </Col>
          </Row>
        </ConfigProvider>

        <Divider titlePlacement="start" plain style={{ margin: '4px 0 12px' }}>
          {t('archive.source')}
        </Divider>
        <Row gutter={12}>
          <Col span={12}>
            <Form.Item name="counterparty" label={t('tx.counterparty')}>
              <Input maxLength={128} />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="paymentChannel" label={t('tx.paymentChannel')}>
              <Input maxLength={64} placeholder={t('tx.paymentChannelPlaceholder')} />
            </Form.Item>
          </Col>
        </Row>
        <Form.Item name="purpose" label={t('tx.purpose')}>
          <Input maxLength={500} />
        </Form.Item>
        <Row gutter={12}>
          <Col span={12}>
            <Form.Item name="referenceNumber" label={t('tx.referenceNumber')}>
              <Input maxLength={128} />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="evidenceSource" label={t('tx.evidenceSource')}>
              <Input maxLength={500} placeholder={t('tx.evidenceSourcePlaceholder')} />
            </Form.Item>
          </Col>
        </Row>
        <Form.Item name="note" label={t('common.note')} style={{ marginBottom: 0 }}>
          <Input.TextArea autoSize={{ minRows: 1, maxRows: 4 }} maxLength={2000} />
        </Form.Item>
      </Form>
    </Modal>
  );
}
