import { CheckOutlined } from '@ant-design/icons';
import { useQueryClient } from '@tanstack/react-query';
import { Alert, App, Button, Form, Input, InputNumber, Modal, Select } from 'antd';
import { detectSensitive, INSTITUTION_TYPES, NAME_MAX, NOTES_MAX, websiteSchema, WEBSITE_MAX, type CountryCode, type InstitutionDto, type InstitutionType } from '@xui/ledger-shared';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../api/client.ts';
import { errorText } from '../../api/hooks.ts';
import { createInstitution, INSTITUTIONS, updateInstitution } from '../../api/institutions.ts';
import { InstitutionAvatar } from '../../components/InstitutionAvatar.tsx';
import { regionOptions } from '../../lib/regions.ts';

/** Avatar colours offered in the form (null = automatic colour from the name). */
export const AVATAR_COLORS = ['#1677ff', '#2f54eb', '#722ed1', '#eb2f96', '#f5222d', '#fa541c', '#fa8c16', '#faad14', '#52c41a', '#13c2c2', '#08979c', '#595959'];

interface FormValues {
  name: string;
  institutionType: InstitutionType;
  country?: CountryCode | null;
  website?: string;
  color?: string | null;
  notes?: string;
  sort?: number | null;
}

function ColorSwatches({ value, onChange, name }: { value?: string | null; onChange?: (v: string | null) => void; name: string }) {
  const { t } = useTranslation();
  return (
    <div className="color-swatches" role="radiogroup" aria-label={t('institutions.color')}>
      <button type="button" role="radio" aria-checked={!value} aria-label={t('institutions.colorAuto')} className={`color-swatch is-auto ${!value ? 'is-selected' : ''}`} onClick={() => onChange?.(null)}>
        <InstitutionAvatar name={name || '?'} color={null} size={28} />
      </button>
      {AVATAR_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={value === c}
          aria-label={c}
          className={`color-swatch ${value === c ? 'is-selected' : ''}`}
          style={{ background: c }}
          onClick={() => onChange?.(c)}
        >
          {value === c && <CheckOutlined />}
        </button>
      ))}
    </div>
  );
}

/**
 * Create / edit an institution. The server is the authority (strict schema, duplicate check,
 * sensitive-data scan); the same rules run here first only to give immediate feedback.
 */
export function InstitutionFormModal({
  open,
  editing,
  onClose,
  onSaved,
  onViewExisting,
}: {
  open: boolean;
  /** null = create. */
  editing: InstitutionDto | null;
  onClose: () => void;
  onSaved?: (inst: InstitutionDto) => void;
  onViewExisting: (id: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [form] = Form.useForm<FormValues>();
  const [busy, setBusy] = useState(false);
  const [duplicateId, setDuplicateId] = useState<string | null>(null);
  const name = Form.useWatch('name', form) ?? '';
  const countries = useMemo(() => regionOptions(i18n.language), [i18n.language]);

  useEffect(() => {
    if (!open) return;
    setDuplicateId(null);
    form.resetFields();
    form.setFieldsValue(
      editing
        ? {
            name: editing.name,
            institutionType: editing.institutionType,
            country: editing.country as CountryCode | null,
            website: editing.website ?? '',
            color: editing.color,
            notes: editing.notes ?? '',
            sort: editing.sort,
          }
        : { institutionType: 'bank', country: null, color: null, sort: 0 },
    );
  }, [open, editing, form]);

  const noSensitive = { validator: async (_: unknown, v?: string) => (v && detectSensitive(v) ? Promise.reject(new Error(t('institutions.sensitive'))) : undefined) };

  const submit = async () => {
    let v: FormValues;
    try {
      v = await form.validateFields();
    } catch {
      return; // the form shows the field errors
    }
    const body = {
      name: v.name.trim(),
      institutionType: v.institutionType,
      country: v.country ?? null,
      website: v.website?.trim() || null,
      color: v.color ?? null,
      notes: v.notes?.trim() || null,
      sort: v.sort ?? 0,
    };
    setBusy(true);
    setDuplicateId(null);
    try {
      const saved = editing ? await updateInstitution(editing.id, body) : await createInstitution(body);
      await qc.invalidateQueries({ queryKey: [INSTITUTIONS] });
      void message.success(editing ? t('common.saved') : t('institutions.created'));
      onSaved?.(saved);
      onClose();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'DUPLICATE') {
        setDuplicateId((e.details as { existingId?: string } | undefined)?.existingId ?? null);
      } else if (e instanceof ApiError && e.code === 'SENSITIVE_DATA') {
        const fields = ((e.details as { fields?: { field: string }[] } | undefined)?.fields ?? []).map((f) => f.field);
        form.setFields(fields.filter((f): f is keyof FormValues => ['name', 'notes', 'website'].includes(f)).map((f) => ({ name: f, errors: [t('institutions.sensitive')] })));
        if (!fields.length) void message.error(errorText(e, t));
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
      title={editing ? t('institutions.edit') : t('institutions.add')}
      onCancel={onClose}
      onOk={submit}
      okText={t('common.save')}
      confirmLoading={busy}
      forceRender
      // Above the details drawer it can be opened from.
      zIndex={1100}
      width={560}
    >
      {duplicateId !== null && (
        <Alert
          className="form-alert"
          type="warning"
          showIcon
          title={t('institutions.duplicate')}
          description={t('institutions.duplicateHint')}
          action={
            duplicateId && (
              <Button size="small" onClick={() => onViewExisting(duplicateId)}>
                {t('institutions.viewExisting')}
              </Button>
            )
          }
        />
      )}
      <Form form={form} layout="vertical">
        <Form.Item
          name="name"
          label={t('institutions.name')}
          rules={[{ required: true, whitespace: true, message: t('institutions.nameRequired') }, { max: NAME_MAX }, noSensitive]}
        >
          <Input maxLength={NAME_MAX} autoComplete="off" onChange={() => setDuplicateId(null)} />
        </Form.Item>
        <Form.Item name="institutionType" label={t('institutions.type')} rules={[{ required: true, message: t('institutions.typeRequired') }]}>
          <Select options={INSTITUTION_TYPES.map((v) => ({ value: v, label: t(`institutions.types.${v}`) }))} />
        </Form.Item>
        <Form.Item name="country" label={t('institutions.country')} extra={t('institutions.countryHint')}>
          <Select
            showSearch={{ optionFilterProp: 'label' }}
            allowClear
            placeholder={t('institutions.noCountry')}
            options={countries}
            onChange={() => setDuplicateId(null)}
          />
        </Form.Item>
        <Form.Item
          name="website"
          label={t('institutions.website')}
          extra={t('institutions.websiteHint')}
          rules={[
            {
              validator: async (_: unknown, v?: string) => (v?.trim() && !websiteSchema.safeParse(v.trim()).success ? Promise.reject(new Error(t('institutions.websiteInvalid'))) : undefined),
            },
            noSensitive,
          ]}
        >
          <Input placeholder="https://" maxLength={WEBSITE_MAX} autoComplete="off" inputMode="url" />
        </Form.Item>
        <Form.Item name="color" label={t('institutions.color')}>
          <ColorSwatches name={name} />
        </Form.Item>
        <Form.Item name="notes" label={t('institutions.notes')} extra={t('institutions.notesHint')} rules={[{ max: NOTES_MAX }, noSensitive]}>
          <Input.TextArea rows={3} maxLength={NOTES_MAX} showCount />
        </Form.Item>
        <Form.Item name="sort" label={t('institutions.sort')} extra={t('institutions.sortHint')}>
          <InputNumber precision={0} min={-1_000_000} max={1_000_000} style={{ width: 160 }} />
        </Form.Item>
      </Form>
    </Modal>
  );
}
