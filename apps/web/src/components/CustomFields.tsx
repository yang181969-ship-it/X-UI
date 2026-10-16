import { Checkbox, DatePicker, Descriptions, Divider, Form, Input, InputNumber, Select, Space, Tag, type TableColumnType } from 'antd';
import dayjs from 'dayjs';
import { useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { fieldsFor, type CustomField, type CustomFieldEntity } from '@z-ui/shared';
import { useConfig } from '../api/hooks.ts';
import { useMoney } from '../lib/format.ts';
import { MoneyInput } from './Money.tsx';

/**
 * Custom fields are defined in config/app.config.json (Settings → 自定义栏位) and stored per
 * record in its `extra` JSON. These helpers render them in forms, tables and detail tabs.
 */

export function useCustomFields(entity: CustomFieldEntity): CustomField[] {
  const { data: cfg } = useConfig();
  return useMemo(() => (cfg ? fieldsFor(cfg, entity) : []), [cfg, entity]);
}

function MoneyFieldInput({ id, value, onChange }: { id?: string; value?: { amount: number; currency: string } | null; onChange?: (v: unknown) => void }) {
  const { data: cfg } = useConfig();
  const currency = value?.currency ?? cfg?.app.defaultCurrency ?? 'USD';
  return (
    <Space.Compact block>
      <Select
        style={{ width: 96 }}
        value={currency}
        options={cfg?.currencies.map((c) => ({ value: c.code, label: c.code }))}
        onChange={(cur) => onChange?.(value ? { ...value, currency: cur } : null)}
      />
      <MoneyInput
        id={id}
        currency={currency}
        allowNegative
        value={value?.amount ?? null}
        onChange={(amount) => onChange?.(amount === null ? null : { amount, currency })}
      />
    </Space.Compact>
  );
}

function DateFieldInput({ id, value, onChange }: { id?: string; value?: string | null; onChange?: (v: string | null) => void }) {
  return <DatePicker id={id} style={{ width: '100%' }} value={value ? dayjs(value) : null} onChange={(d) => onChange?.(d ? d.format('YYYY-MM-DD') : null)} />;
}

function inputFor(field: CustomField): ReactNode {
  const options = field.options?.map((o) => ({ value: o.value, label: o.label }));
  switch (field.type) {
    case 'text':
      return <Input allowClear maxLength={1000} />;
    case 'number':
      return <InputNumber style={{ width: '100%' }} />;
    case 'select':
      return <Select allowClear options={options} />;
    case 'multiselect':
      return <Select mode="multiple" allowClear options={options} />;
    case 'date':
      return <DateFieldInput />;
    case 'boolean':
      return <Checkbox />;
    case 'money':
      return <MoneyFieldInput />;
  }
}

/** Form items for an entity's custom fields (values live under the form's `extra`). */
export function CustomFieldInputs({ entity }: { entity: CustomFieldEntity }) {
  const fields = useCustomFields(entity);
  const { t } = useTranslation();
  if (fields.length === 0) return null;
  const groups = new Map<string, CustomField[]>();
  for (const f of fields) groups.set(f.tab ?? '', [...(groups.get(f.tab ?? '') ?? []), f]);
  return (
    <>
      {[...groups].map(([tab, list]) => (
        <div key={tab}>
          <Divider titlePlacement="start" plain style={{ margin: '8px 0 12px' }}>
            {tab || t('settings.customFields')}
          </Divider>
          {list.map((f) => (
            <Form.Item
              key={f.key}
              name={['extra', f.key]}
              label={f.label}
              tooltip={f.description}
              valuePropName={f.type === 'boolean' ? 'checked' : 'value'}
              rules={f.required ? [{ required: true }] : undefined}
            >
              {inputFor(f)}
            </Form.Item>
          ))}
        </div>
      ))}
    </>
  );
}

export function FieldValue({ field, value }: { field: CustomField; value: unknown }) {
  const money = useMoney();
  const { t } = useTranslation();
  if (value === undefined || value === null || value === '') return <span className="muted">—</span>;
  const opt = (v: string) => field.options?.find((o) => o.value === v);
  switch (field.type) {
    case 'select': {
      const o = opt(String(value));
      return <Tag color={o?.color}>{o?.label ?? String(value)}</Tag>;
    }
    case 'multiselect':
      return (
        <>
          {(value as string[]).map((v) => (
            <Tag key={v} color={opt(v)?.color}>
              {opt(v)?.label ?? v}
            </Tag>
          ))}
        </>
      );
    case 'boolean':
      return <>{value ? t('common.yes') : t('common.no')}</>;
    case 'money': {
      const m = value as { amount: number; currency: string };
      return <span className="num">{money(m.amount, m.currency)}</span>;
    }
    default:
      return <>{String(value)}</>;
  }
}

/** Table columns for custom fields marked "show in table". */
export function useCustomColumns<T extends { extra: Record<string, unknown> }>(entity: CustomFieldEntity): TableColumnType<T>[] {
  const fields = useCustomFields(entity);
  return useMemo(
    () =>
      fields
        .filter((f) => f.showInTable)
        .map((f) => ({
          key: `extra.${f.key}`,
          title: f.label,
          render: (_: unknown, row: T) => <FieldValue field={f} value={row.extra?.[f.key]} />,
        })),
    [fields],
  );
}

/** Extra tabs for a detail drawer: one per distinct `tab` name (fields without one go to a default tab). */
export function useCustomFieldTabs(entity: CustomFieldEntity, extra: Record<string, unknown> | undefined) {
  const fields = useCustomFields(entity);
  const { t } = useTranslation();
  return useMemo(() => {
    const groups = new Map<string, CustomField[]>();
    for (const f of fields) groups.set(f.tab ?? '', [...(groups.get(f.tab ?? '') ?? []), f]);
    return [...groups].map(([tab, list]) => ({
      key: `cf:${tab}`,
      label: tab || t('settings.customFields'),
      children: (
        <Descriptions
          column={1}
          size="small"
          items={list.map((f) => ({ key: f.key, label: f.label, children: <FieldValue field={f} value={extra?.[f.key]} /> }))}
        />
      ),
    }));
  }, [fields, extra, t]);
}
