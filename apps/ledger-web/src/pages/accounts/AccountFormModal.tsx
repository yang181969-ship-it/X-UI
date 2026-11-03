import { PlusOutlined } from '@ant-design/icons';
import { Alert, App, Button, DatePicker, Form, Input, InputNumber, Modal, Select, Space } from 'antd';
import {
  ACCOUNT_STATUSES,
  ACCOUNT_TYPES,
  DEPOSIT_KINDS,
  detectSensitive,
  NAME_MAX,
  normalizeNameKey,
  NOTES_MAX,
  numberHintSchema,
  type AccountDto,
  type AccountStatus,
  type AccountType,
  type CountryCode,
  type DepositKind,
} from '@xui/ledger-shared';
import dayjs, { type Dayjs } from 'dayjs';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { createAccount, updateAccount, useAccounts, useRefreshAccounts } from '../../api/accounts.ts';
import { ApiError } from '../../api/client.ts';
import { errorText } from '../../api/hooks.ts';
import { useInstitutions } from '../../api/institutions.ts';
import { InstitutionAvatar } from '../../components/InstitutionAvatar.tsx';
import { regionOptions } from '../../lib/regions.ts';
import { CurrencyListEditor, currencyListProblem, toInput, type CurrencyItem } from './CurrencyListEditor.tsx';
import { InstitutionFormModal } from './InstitutionFormModal.tsx';

interface FormValues {
  institutionId?: string;
  name: string;
  accountType: AccountType;
  depositKind?: DepositKind | null;
  accountCountry?: CountryCode;
  currencies?: CurrencyItem[];
  numberHint?: string;
  status: AccountStatus;
  openedOn?: Dayjs | null;
  closedOn?: Dayjs | null;
  notes?: string;
  sort?: number | null;
}

const DAY = 'YYYY-MM-DD';
const day = (v: string | null) => (v ? dayjs(v, DAY) : null);
const iso = (v?: Dayjs | null) => (v ? v.format(DAY) : null);

/**
 * Create / edit an account. Creating picks an institution (or creates one on the spot), the
 * account jurisdiction (required, never pre-filled) and the currencies; editing can't change the
 * institution or the currencies (those are managed on the detail page). The server is the
 * authority — the same rules run here only for immediate feedback.
 */
export function AccountFormModal({
  open,
  editing,
  initialInstitutionId,
  onClose,
}: {
  open: boolean;
  /** null = create. */
  editing: AccountDto | null;
  /** Pre-selected institution when creating (e.g. from an institution group). */
  initialInstitutionId?: string;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { message } = App.useApp();
  const refresh = useRefreshAccounts();
  const [form] = Form.useForm<FormValues>();
  const [busy, setBusy] = useState(false);
  const [newInstitution, setNewInstitution] = useState(false);
  const countries = useMemo(() => regionOptions(i18n.language), [i18n.language]);
  const { data: institutions = [] } = useInstitutions({ status: 'all' });
  const institutionId = Form.useWatch('institutionId', form);
  const accountType = Form.useWatch('accountType', form);
  const name = Form.useWatch('name', form) ?? '';
  const { data: siblings = [] } = useAccounts({ institutionId, status: 'all' }, open && !!institutionId);
  const sameName =
    !!name.trim() && siblings.some((a) => a.id !== editing?.id && a.institutionId === institutionId && normalizeNameKey(a.name) === normalizeNameKey(name));

  useEffect(() => {
    if (!open) return;
    form.resetFields();
    form.setFieldsValue(
      editing
        ? {
            institutionId: editing.institutionId,
            name: editing.name,
            accountType: editing.accountType,
            depositKind: editing.depositKind,
            accountCountry: editing.accountCountry as CountryCode,
            numberHint: editing.numberHint ?? '',
            status: editing.status,
            openedOn: day(editing.openedOn),
            closedOn: day(editing.closedOn),
            notes: editing.notes ?? '',
            sort: editing.sort,
          }
        : // accountCountry is deliberately left empty: it is never inferred from the institution.
          { institutionId: initialInstitutionId, accountType: 'bank', depositKind: null, currencies: [], status: 'active', sort: 0 },
    );
  }, [open, editing, initialInstitutionId, form]);

  const institutionOptions = useMemo(() => {
    const option = (i: (typeof institutions)[number]) => ({
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
    // New accounts need an active institution: archived ones are shown, but only selectable after
    // being restored. (Editing never changes the institution — the select is disabled then.)
    const archived = institutions.filter((i) => i.status === 'archived').map((i) => ({ ...option(i), disabled: true }));
    return archived.length ? [...active, { label: t('accounts.archivedInstitutions'), options: archived }] : active;
  }, [institutions, t]);
  const isArchived = (id: string | undefined) => institutions.find((i) => i.id === id)?.status === 'archived';

  const noSensitive = { validator: async (_: unknown, v?: string) => (v && detectSensitive(v) ? Promise.reject(new Error(t('accounts.sensitive'))) : undefined) };

  const submit = async () => {
    let v: FormValues;
    try {
      v = await form.validateFields();
    } catch {
      return; // the form shows the field errors
    }
    const fields = {
      name: v.name.trim(),
      accountType: v.accountType,
      depositKind: v.accountType === 'bank' ? (v.depositKind ?? null) : null,
      accountCountry: v.accountCountry!,
      numberHint: v.numberHint?.trim() || null,
      status: v.status,
      openedOn: iso(v.openedOn),
      closedOn: iso(v.closedOn),
      notes: v.notes?.trim() || null,
      sort: v.sort ?? 0,
    };
    setBusy(true);
    try {
      if (editing) await updateAccount(editing.id, fields);
      else await createAccount({ ...fields, institutionId: v.institutionId!, currencies: toInput(v.currencies ?? []) });
      await refresh();
      void message.success(editing ? t('common.saved') : t('accounts.created'));
      onClose();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'INSTITUTION_ARCHIVED') {
        // Archived after the dialog was opened.
        form.setFields([{ name: 'institutionId', errors: [t('errors.codes.INSTITUTION_ARCHIVED')] }]);
      } else if (e instanceof ApiError && e.code === 'SENSITIVE_DATA') {
        const hit = ((e.details as { fields?: { field: string }[] } | undefined)?.fields ?? []).map((f) => f.field);
        form.setFields(hit.filter((f): f is keyof FormValues => ['name', 'notes', 'numberHint'].includes(f)).map((f) => ({ name: f, errors: [t('accounts.sensitive')] })));
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
      title={editing ? t('accounts.edit') : t('accounts.add')}
      onCancel={onClose}
      onOk={submit}
      okText={t('common.save')}
      confirmLoading={busy}
      forceRender
      width={640}
    >
      <Form form={form} name="account" layout="vertical" className="account-form">
        <Form.Item label={t('accounts.institution')} required extra={editing ? t('accounts.institutionLocked') : t('accounts.institutionHint')}>
          <Space.Compact block>
            <Form.Item name="institutionId" noStyle rules={[{ required: true, message: t('accounts.institutionRequired') }]}>
              <Select
                aria-label={t('accounts.institution')}
                disabled={!!editing}
                showSearch={{ optionFilterProp: 'search' }}
                placeholder={t('accounts.selectInstitution')}
                options={institutionOptions}
                notFoundContent={t('accounts.noInstitutions')}
              />
            </Form.Item>
            {!editing && (
              <Button icon={<PlusOutlined />} onClick={() => setNewInstitution(true)}>
                {t('accounts.newInstitution')}
              </Button>
            )}
          </Space.Compact>
        </Form.Item>
        <Form.Item
          name="name"
          label={t('accounts.name')}
          rules={[{ required: true, whitespace: true, message: t('accounts.nameRequired') }, { max: NAME_MAX }, noSensitive]}
          extra={sameName ? <span className="warning-text">{t('accounts.sameName')}</span> : undefined}
        >
          <Input maxLength={NAME_MAX} autoComplete="off" />
        </Form.Item>
        <Space size={16} wrap className="form-pair">
          <Form.Item name="accountType" label={t('accounts.type')} rules={[{ required: true, message: t('accounts.typeRequired') }]}>
            <Select style={{ width: 200 }} options={ACCOUNT_TYPES.map((v) => ({ value: v, label: t(`accounts.types.${v}`) }))} />
          </Form.Item>
          {accountType === 'bank' && (
            <Form.Item name="depositKind" label={t('accounts.depositKind')}>
              <Select style={{ width: 160 }} allowClear options={DEPOSIT_KINDS.map((v) => ({ value: v, label: t(`accounts.depositKinds.${v}`) }))} />
            </Form.Item>
          )}
        </Space>
        <Form.Item name="accountCountry" label={t('accounts.country')} extra={t('accounts.countryHint')} rules={[{ required: true, message: t('accounts.countryRequired') }]}>
          <Select showSearch={{ optionFilterProp: 'label' }} placeholder={t('accounts.countryPlaceholder')} options={countries} />
        </Form.Item>
        {!editing && (
          <Form.Item
            name="currencies"
            label={t('accounts.currencies')}
            extra={t('accounts.currenciesHint')}
            required
            rules={[{ validator: async (_: unknown, v?: CurrencyItem[]) => (currencyListProblem(v, t) ? Promise.reject(new Error(currencyListProblem(v, t)!)) : undefined) }]}
          >
            <CurrencyListEditor />
          </Form.Item>
        )}
        <Space size={16} wrap className="form-pair">
          <Form.Item
            name="numberHint"
            label={t('accounts.numberHint')}
            extra={t('accounts.numberHintHelp')}
            rules={[
              { validator: async (_: unknown, v?: string) => (v?.trim() && !numberHintSchema.safeParse(v.trim()).success ? Promise.reject(new Error(t('accounts.numberHintInvalid'))) : undefined) },
              noSensitive,
            ]}
          >
            <Input maxLength={4} autoComplete="off" style={{ width: 160 }} />
          </Form.Item>
          <Form.Item name="status" label={t('accounts.status')}>
            <Select style={{ width: 160 }} options={ACCOUNT_STATUSES.map((v) => ({ value: v, label: t(`accounts.statuses.${v}`) }))} />
          </Form.Item>
        </Space>
        <Space size={16} wrap className="form-pair">
          <Form.Item name="openedOn" label={t('accounts.openedOn')}>
            <DatePicker format={DAY} />
          </Form.Item>
          <Form.Item
            name="closedOn"
            label={t('accounts.closedOn')}
            dependencies={['openedOn']}
            rules={[
              ({ getFieldValue }) => ({
                validator: async (_: unknown, v?: Dayjs | null) => {
                  const opened = getFieldValue('openedOn') as Dayjs | null | undefined;
                  if (v && opened && v.isBefore(opened, 'day')) throw new Error(t('accounts.closedBeforeOpened'));
                },
              }),
            ]}
          >
            <DatePicker format={DAY} />
          </Form.Item>
        </Space>
        <Form.Item name="notes" label={t('accounts.notes')} extra={t('accounts.notesHint')} rules={[{ max: NOTES_MAX }, noSensitive]}>
          <Input.TextArea rows={3} maxLength={NOTES_MAX} showCount />
        </Form.Item>
        <Form.Item name="sort" label={t('accounts.sort')} extra={t('accounts.sortHint')}>
          <InputNumber precision={0} min={-1_000_000} max={1_000_000} style={{ width: 160 }} />
        </Form.Item>
      </Form>
      {institutions.length === 0 && !editing && <Alert type="info" showIcon title={t('accounts.noInstitutions')} />}
      <InstitutionFormModal
        open={newInstitution}
        editing={null}
        onClose={() => setNewInstitution(false)}
        onSaved={(inst) => form.setFieldsValue({ institutionId: inst.id })}
        onViewExisting={(id) => {
          // The existing institution may be archived: it has to be restored before it can be used.
          if (isArchived(id)) void message.warning(t('errors.codes.INSTITUTION_ARCHIVED'));
          else form.setFieldsValue({ institutionId: id });
          setNewInstitution(false);
        }}
        existingLabel={t('accounts.useExisting')}
      />
    </Modal>
  );
}
