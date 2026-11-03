import { PlusOutlined } from '@ant-design/icons';
import { Alert, App, Button, Checkbox, DatePicker, Form, Input, InputNumber, Modal, Radio, Select, Space } from 'antd';
import {
  CARD_FORMS,
  CARD_NETWORKS,
  CARD_STATUSES,
  CARD_TYPES,
  detectSensitive,
  last4Schema,
  NAME_MAX,
  NOTES_MAX,
  type CardDto,
  type CardForm,
  type CardNetwork,
  type CardStatus,
  type CardType,
  type CountryCode,
  type CurrencyCode,
  type InstitutionListItem,
} from '@xui/ledger-shared';
import dayjs, { type Dayjs } from 'dayjs';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useRefreshAccounts } from '../../api/accounts.ts';
import { createCard, updateCard } from '../../api/cards.ts';
import { ApiError } from '../../api/client.ts';
import { errorText } from '../../api/hooks.ts';
import { useInstitutions } from '../../api/institutions.ts';
import { InstitutionAvatar } from '../../components/InstitutionAvatar.tsx';
import { currencyOptions } from '../../lib/currencies.ts';
import { regionOptions } from '../../lib/regions.ts';
import { InstitutionFormModal } from '../accounts/InstitutionFormModal.tsx';

interface FormValues {
  issuerInstitutionId?: string;
  name: string;
  cardType: CardType;
  network?: CardNetwork;
  form: CardForm;
  last4?: string;
  issuingCountry?: CountryCode;
  expiresOn?: Dayjs | null;
  status: CardStatus;
  notes?: string;
  sort?: number | null;
  createStoredValue?: boolean;
  storedValue?: { name?: string; institutionId?: string; accountCountry?: CountryCode; currency?: CurrencyCode };
}

const MONTH = 'YYYY-MM';

/**
 * Create / edit a debit or prepaid card. There is deliberately no card-number field: only the
 * last four digits (four single-digit boxes). The issuing country is required and never
 * pre-filled; a prepaid card may create its stored-value account in the same request (create
 * only — the account jurisdiction is entered here too, never taken from the card). The server is
 * the authority; the same rules run here only for immediate feedback.
 */
export function CardFormModal({ open, editing, onClose }: { open: boolean; editing: CardDto | null; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const { message } = App.useApp();
  const refresh = useRefreshAccounts();
  const [form] = Form.useForm<FormValues>();
  const [busy, setBusy] = useState(false);
  const [newInstitution, setNewInstitution] = useState(false);
  const countries = useMemo(() => regionOptions(i18n.language), [i18n.language]);
  const currencies = useMemo(() => currencyOptions(i18n.language), [i18n.language]);
  const { data: institutions = [] } = useInstitutions({ status: 'all' });
  const cardType = Form.useWatch('cardType', form);
  const createStoredValue = Form.useWatch('createStoredValue', form);
  const withStoredValue = !editing && cardType === 'prepaid' && !!createStoredValue;

  useEffect(() => {
    if (!open) return;
    form.resetFields();
    form.setFieldsValue(
      editing
        ? {
            issuerInstitutionId: editing.issuerInstitutionId,
            name: editing.name,
            cardType: editing.cardType,
            network: editing.network,
            form: editing.form,
            last4: editing.last4,
            issuingCountry: editing.issuingCountry as CountryCode,
            expiresOn: editing.expiresOn ? dayjs(`${editing.expiresOn}-01`) : null,
            status: editing.status,
            notes: editing.notes ?? '',
            sort: editing.sort,
          }
        : // issuingCountry and network are deliberately left empty: nothing is inferred from the issuer.
          { cardType: 'debit', form: 'physical', status: 'active', sort: 0, createStoredValue: false },
    );
  }, [open, editing, form]);

  /** Active institutions first; archived ones only selectable when they are the card's current issuer. */
  const institutionOptions = (keep?: string) => {
    const option = (i: InstitutionListItem) => ({
      value: i.id,
      label: (
        <span className="institution-option">
          <InstitutionAvatar name={i.name} color={i.color} size={20} />
          {i.name}
          {i.country && <span className="muted">({i.country})</span>}
        </span>
      ),
      search: `${i.name} ${i.country ?? ''}`,
    });
    const active = institutions.filter((i) => i.status === 'active').map(option);
    const archived = institutions.filter((i) => i.status === 'archived').map((i) => ({ ...option(i), disabled: i.id !== keep }));
    return archived.length ? [...active, { label: t('cards.archivedInstitutions'), options: archived }] : active;
  };

  const noSensitive = { validator: async (_: unknown, v?: string) => (v && detectSensitive(v) ? Promise.reject(new Error(t('cards.sensitive'))) : undefined) };

  const submit = async () => {
    let v: FormValues;
    try {
      v = await form.validateFields();
    } catch {
      return; // the form shows the field errors
    }
    const fields = {
      issuerInstitutionId: v.issuerInstitutionId!,
      name: v.name.trim(),
      cardType: v.cardType,
      network: v.network!,
      form: v.form,
      last4: v.last4!,
      issuingCountry: v.issuingCountry!,
      expiresOn: v.expiresOn ? v.expiresOn.format(MONTH) : null,
      status: v.status,
      notes: v.notes?.trim() || null,
      sort: v.sort ?? 0,
    };
    setBusy(true);
    try {
      if (editing) {
        await updateCard(editing.id, fields);
      } else {
        const sv = withStoredValue && v.storedValue ? v.storedValue : null;
        await createCard({
          ...fields,
          ...(sv && {
            createStoredValueAccount: { name: sv.name!.trim(), institutionId: sv.institutionId || undefined, accountCountry: sv.accountCountry!, currency: sv.currency! },
          }),
        });
      }
      await refresh();
      void message.success(editing ? t('common.saved') : withStoredValue ? t('cards.storedValue.created') : t('cards.created'));
      onClose();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'INSTITUTION_ARCHIVED') {
        // Archived after the dialog was opened: mark the field that names it.
        const id = (e.details as { institutionId?: string } | undefined)?.institutionId;
        const svField = withStoredValue && id && id !== v.issuerInstitutionId;
        form.setFields([svField ? { name: ['storedValue', 'institutionId'], errors: [t('cards.issuerArchived')] } : { name: 'issuerInstitutionId', errors: [t('cards.issuerArchived')] }]);
      } else if (e instanceof ApiError && e.code === 'SENSITIVE_DATA') {
        const hit = ((e.details as { fields?: { field: string }[] } | undefined)?.fields ?? []).map((f) => f.field);
        const error = [t('cards.sensitive')];
        form.setFields([
          ...(hit.includes('name') ? [{ name: 'name' as const, errors: error }] : []),
          ...(hit.includes('notes') ? [{ name: 'notes' as const, errors: error }] : []),
          ...(hit.includes('createStoredValueAccount.name') ? [{ name: ['storedValue', 'name'] as ['storedValue', 'name'], errors: error }] : []),
        ]);
        if (!hit.length) void message.error(errorText(e, t));
      } else {
        void message.error(errorText(e, t));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      title={editing ? t('cards.edit') : t('cards.add')}
      onCancel={onClose}
      onOk={submit}
      okText={t('common.save')}
      confirmLoading={busy}
      forceRender
      width={660}
    >
      <Alert type="info" showIcon className="form-alert" title={t('cards.noCardNumber')} />
      <Form form={form} name="card" layout="vertical" className="card-form" autoComplete="off">
        <Form.Item label={t('cards.issuer')} required extra={t('cards.issuerHint')}>
          <Space.Compact block>
            <Form.Item name="issuerInstitutionId" noStyle rules={[{ required: true, message: t('cards.issuerRequired') }]}>
              <Select
                aria-label={t('cards.issuer')}
                showSearch={{ optionFilterProp: 'search' }}
                placeholder={t('cards.selectIssuer')}
                options={institutionOptions(editing?.issuerInstitutionId)}
                notFoundContent={t('cards.noInstitutions')}
              />
            </Form.Item>
            <Button icon={<PlusOutlined />} onClick={() => setNewInstitution(true)}>
              {t('cards.newInstitution')}
            </Button>
          </Space.Compact>
        </Form.Item>
        <Form.Item name="name" label={t('cards.name')} extra={t('cards.nameHint')} rules={[{ required: true, whitespace: true, message: t('cards.nameRequired') }, { max: NAME_MAX }, noSensitive]}>
          <Input maxLength={NAME_MAX} autoComplete="off" />
        </Form.Item>
        <Space size={16} wrap className="form-pair">
          <Form.Item name="cardType" label={t('cards.type')} extra={t('cards.typeHint')} rules={[{ required: true }]}>
            <Radio.Group optionType="button" options={CARD_TYPES.map((v) => ({ value: v, label: t(`cards.types.${v}`) }))} />
          </Form.Item>
          <Form.Item name="form" label={t('cards.form')} rules={[{ required: true }]}>
            <Radio.Group optionType="button" options={CARD_FORMS.map((v) => ({ value: v, label: t(`cards.forms.${v}`) }))} />
          </Form.Item>
        </Space>
        <Space size={16} wrap className="form-pair">
          <Form.Item name="network" label={t('cards.network')} rules={[{ required: true, message: t('cards.networkRequired') }]}>
            <Select aria-label={t('cards.network')} style={{ width: 220 }} options={CARD_NETWORKS.map((v) => ({ value: v, label: t(`cards.networks.${v}`) }))} />
          </Form.Item>
          <Form.Item
            name="last4"
            label={t('cards.last4')}
            className="card-last4"
            rules={[{ validator: async (_: unknown, v?: string) => (last4Schema.safeParse(v ?? '').success ? undefined : Promise.reject(new Error(t('cards.last4Invalid')))) }]}
          >
            <Input.OTP length={4} formatter={(s) => s.replace(/\D/g, '')} autoComplete="off" aria-label={t('cards.last4')} />
          </Form.Item>
        </Space>
        <div className="field-note card-last4-help">{t('cards.last4Help')}</div>
        <Form.Item name="issuingCountry" label={t('cards.issuingCountry')} extra={t('cards.issuingCountryHint')} rules={[{ required: true, message: t('cards.issuingCountryRequired') }]}>
          <Select aria-label={t('cards.issuingCountry')} showSearch={{ optionFilterProp: 'label' }} placeholder={t('cards.countryPlaceholder')} options={countries} />
        </Form.Item>
        <Space size={16} wrap className="form-pair">
          <Form.Item name="expiresOn" label={t('cards.expiresOn')} extra={t('cards.expiresOnHint')}>
            <DatePicker picker="month" format={MONTH} aria-label={t('cards.expiresOn')} />
          </Form.Item>
          <Form.Item name="status" label={t('cards.status')}>
            <Select aria-label={t('cards.status')} style={{ width: 160 }} options={CARD_STATUSES.map((v) => ({ value: v, label: t(`cards.statuses.${v}`) }))} />
          </Form.Item>
        </Space>
        {!editing && cardType === 'prepaid' && (
          <div className="stored-value-box">
            <Form.Item name="createStoredValue" valuePropName="checked" extra={t('cards.storedValue.hint')}>
              <Checkbox>{t('cards.storedValue.create')}</Checkbox>
            </Form.Item>
            {withStoredValue && (
              <>
                <Form.Item name={['storedValue', 'name']} label={t('cards.storedValue.name')} rules={[{ required: true, whitespace: true, message: t('cards.storedValue.nameRequired') }, { max: NAME_MAX }, noSensitive]}>
                  <Input maxLength={NAME_MAX} autoComplete="off" />
                </Form.Item>
                <Form.Item name={['storedValue', 'institutionId']} label={t('cards.storedValue.institution')} extra={t('cards.storedValue.institutionHint')}>
                  <Select aria-label={t('cards.storedValue.institution')} allowClear showSearch={{ optionFilterProp: 'search' }} placeholder={t('cards.storedValue.institutionHint')} options={institutionOptions()} />
                </Form.Item>
                <Space size={16} wrap className="form-pair">
                  <Form.Item
                    name={['storedValue', 'accountCountry']}
                    label={t('cards.storedValue.country')}
                    rules={[{ required: true, message: t('cards.storedValue.countryRequired') }]}
                  >
                    <Select aria-label={t('cards.storedValue.country')} style={{ width: 260 }} showSearch={{ optionFilterProp: 'label' }} placeholder={t('cards.countryPlaceholder')} options={countries} />
                  </Form.Item>
                  <Form.Item name={['storedValue', 'currency']} label={t('cards.storedValue.currency')} rules={[{ required: true, message: t('cards.storedValue.currencyRequired') }]}>
                    <Select aria-label={t('cards.storedValue.currency')} style={{ width: 200 }} showSearch={{ optionFilterProp: 'label' }} options={currencies} />
                  </Form.Item>
                </Space>
                <div className="field-note">{t('accounts.countryHint')}</div>
              </>
            )}
          </div>
        )}
        <Form.Item name="notes" label={t('cards.notes')} extra={t('cards.notesHint')} rules={[{ max: NOTES_MAX }, noSensitive]}>
          <Input.TextArea rows={3} maxLength={NOTES_MAX} showCount />
        </Form.Item>
        <Form.Item name="sort" label={t('cards.sort')} extra={t('cards.sortHint')}>
          <InputNumber precision={0} min={-1_000_000} max={1_000_000} style={{ width: 160 }} />
        </Form.Item>
      </Form>
      {institutions.length === 0 && <Alert type="info" showIcon title={t('cards.noInstitutions')} />}
      <InstitutionFormModal
        open={newInstitution}
        editing={null}
        onClose={() => setNewInstitution(false)}
        onSaved={(inst) => form.setFieldsValue({ issuerInstitutionId: inst.id })}
        onViewExisting={(id) => {
          if (institutions.find((i) => i.id === id)?.status === 'archived') void message.warning(t('cards.issuerArchived'));
          else form.setFieldsValue({ issuerInstitutionId: id });
          setNewInstitution(false);
        }}
        existingLabel={t('cards.useExisting')}
      />
    </Modal>
  );
}
