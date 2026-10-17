import { ArrowDownOutlined, ArrowUpOutlined, DeleteOutlined, EditOutlined, ImportOutlined, MinusCircleOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { useQueryClient } from '@tanstack/react-query';
import {
  App,
  AutoComplete,
  Button,
  Card,
  Checkbox,
  Col,
  ColorPicker,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Row,
  Segmented,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
  type TableColumnsType,
} from 'antd';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CUSTOM_FIELD_ENTITIES,
  CUSTOM_FIELD_TYPES,
  summarizeConfigChange,
  type AppConfig,
  type CategoryDto,
  type CategoryKind,
  type CustomField,
  type CustomFieldEntity,
  type TagDto,
} from '@z-ui/shared';
import { del, patch, post, put } from '../api/client.ts';
import { errorText, useAction, useCategories, useConfig, useMe, useTags } from '../api/hooks.ts';
import { PageTop } from '../layouts/PanelLayout.tsx';

const colorValue = (c: unknown): string | null =>
  typeof c === 'string' ? c : ((c as { toHexString?: () => string } | null)?.toHexString?.() ?? null);

// ---------------------------------------------------------------- categories & tags (per user)

function CategoryList({ kind, items }: { kind: CategoryKind; items: CategoryDto[] }) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState<CategoryDto | 'new' | null>(null);
  const [form] = Form.useForm();
  useEffect(() => {
    if (editing) form.setFieldsValue(editing === 'new' ? { name: '', color: '#1677ff' } : editing);
  }, [editing, form]);
  const save = useAction(async (v: { name: string; color: unknown }) => {
    const body = { name: v.name, color: colorValue(v.color) };
    if (editing === 'new') await post('/categories', { ...body, kind });
    else if (editing) await patch(`/categories/${editing.id}`, body);
    setEditing(null);
  });
  const remove = useAction((c: CategoryDto) => del(`/categories/${c.id}`));
  const restore = useAction((c: CategoryDto) => patch(`/categories/${c.id}`, { archived: false }));
  return (
    <Card title={t(kind === 'expense' ? 'settings.expenseCats' : 'settings.incomeCats')} extra={<Button size="small" icon={<PlusOutlined />} onClick={() => setEditing('new')} />}>
      <AnimatePresence initial={false}>
        {items.map((c) => (
          <motion.div key={c.id} layout initial={{ opacity: 0 }} animate={{ opacity: c.archived ? 0.5 : 1 }} exit={{ opacity: 0 }}>
            <div className="row-item">
              <span className="dot" style={{ background: c.color ?? '#8c8c8c' }} />
              <div className="row-main">
                {c.name} {c.archived && <Tag>{t('common.archived')}</Tag>}
              </div>
              <Button size="small" type="text" icon={<EditOutlined />} onClick={() => setEditing(c)} />
              {c.archived ? (
                <Button size="small" type="text" onClick={() => restore.mutate(c)}>
                  {t('common.unarchive')}
                </Button>
              ) : (
                <Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={() => remove.mutate(c)} />
              )}
            </div>
          </motion.div>
        ))}
      </AnimatePresence>
      <Modal open={!!editing} title={t('settings.addCategory')} onCancel={() => setEditing(null)} onOk={() => form.submit()} confirmLoading={save.isPending} destroyOnHidden width={360}>
        <Form form={form} layout="vertical" onFinish={(v) => save.mutate(v)} requiredMark={false}>
          <Form.Item name="name" label={t('common.name')} rules={[{ required: true, max: 32 }]}>
            <Input autoFocus />
          </Form.Item>
          <Form.Item name="color" label={t('common.color')}>
            <ColorPicker disabledAlpha />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}

function CategoriesTab() {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const { data = [] } = useCategories();
  const importDefaults = useAction(() => post<{ added: number }>('/categories/import-defaults'), { success: false });
  return (
    <Row gutter={[16, 16]}>
      <Col xs={24}>
        <Space wrap>
          <Button
            icon={<ImportOutlined />}
            loading={importDefaults.isPending}
            onClick={() => importDefaults.mutate(undefined, { onSuccess: (r) => void message.success(t('settings.imported', { n: r.added })) })}
          >
            {t('settings.importDefaults')}
          </Button>
          <span className="muted" style={{ fontSize: 12 }}>
            {t('settings.importHint')}
          </span>
        </Space>
      </Col>
      <Col xs={24} lg={12}>
        <CategoryList kind="expense" items={data.filter((c) => c.kind === 'expense')} />
      </Col>
      <Col xs={24} lg={12}>
        <CategoryList kind="income" items={data.filter((c) => c.kind === 'income')} />
      </Col>
    </Row>
  );
}

function TagsTab() {
  const { t } = useTranslation();
  const { data = [] } = useTags();
  const [name, setName] = useState('');
  const add = useAction(async () => {
    await post('/tags', { name: name.trim() });
    setName('');
  });
  const rename = useAction((v: { tag: TagDto; name: string }) => patch(`/tags/${v.tag.id}`, { name: v.name }));
  const recolor = useAction((v: { tag: TagDto; color: string | null }) => patch(`/tags/${v.tag.id}`, { color: v.color }), { success: false });
  const remove = useAction((tag: TagDto) => del(`/tags/${tag.id}`), { success: false });
  return (
    <Card>
      <Space.Compact style={{ maxWidth: 360, width: '100%', marginBottom: 16 }}>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('settings.addTag')} onPressEnter={() => name.trim() && add.mutate(undefined)} maxLength={32} />
        <Button type="primary" icon={<PlusOutlined />} disabled={!name.trim()} onClick={() => add.mutate(undefined)} />
      </Space.Compact>
      {data.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} />}
      {data.map((tag) => (
        <div key={tag.id} className="row-item">
          <ColorPicker size="small" disabledAlpha value={tag.color ?? '#8c8c8c'} onChangeComplete={(c) => recolor.mutate({ tag, color: c.toHexString() })} />
          <Typography.Text className="row-main" editable={{ onChange: (v) => v.trim() && v !== tag.name && rename.mutate({ tag, name: v.trim() }) }}>
            {tag.name}
          </Typography.Text>
          <span className="muted" style={{ fontSize: 12 }}>
            {t('settings.usage', { n: tag.count })}
          </span>
          <Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={() => remove.mutate(tag)} />
        </div>
      ))}
    </Card>
  );
}

// ---------------------------------------------------------------- custom fields (shared config)

function suggestKey(label: string, taken: Set<string>): string {
  const ascii = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^[^a-z]+/, '');
  let base = ascii.slice(0, 28) || 'field';
  if (!ascii) {
    let n = 1;
    while (taken.has(`field_${n}`)) n++;
    return `field_${n}`;
  }
  let key = base;
  for (let n = 2; taken.has(key); n++) key = `${base}_${n}`;
  return key;
}

function FieldModal({
  open,
  field,
  taken,
  tabs,
  onSave,
  onClose,
}: {
  open: boolean;
  field: CustomField | null;
  taken: Set<string>;
  tabs: string[];
  onSave: (f: CustomField) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [form] = Form.useForm<CustomField>();
  const type = Form.useWatch('type', form);
  const [keyTouched, setKeyTouched] = useState(false);
  useEffect(() => {
    if (!open) return;
    form.resetFields();
    form.setFieldsValue(field ?? { type: 'select', showInTable: true, required: false, options: [{ value: 'active', label: '正常' }], order: 0 });
    setKeyTouched(!!field);
  }, [open, field, form]);
  return (
    <Modal open={open} title={field ? t('settings.editField') : t('settings.addField')} onCancel={onClose} onOk={() => form.submit()} destroyOnHidden width={520}>
      <Form
        form={form}
        layout="vertical"
        requiredMark={false}
        style={{ marginTop: 12 }}
        onValuesChange={(changed) => {
          if ('label' in changed && !keyTouched && !field) form.setFieldValue('key', suggestKey(changed.label ?? '', taken));
        }}
        onFinish={(v) => {
          const needsOptions = v.type === 'select' || v.type === 'multiselect';
          onSave({
            ...v,
            tab: v.tab?.trim() || undefined,
            description: v.description?.trim() || undefined,
            options: needsOptions ? v.options : undefined,
            order: field?.order ?? 999,
          });
        }}
      >
        <Row gutter={12}>
          <Col span={14}>
            <Form.Item name="label" label={t('settings.fieldLabel')} rules={[{ required: true, max: 32 }]}>
              <Input autoFocus placeholder="账户状态" />
            </Form.Item>
          </Col>
          <Col span={10}>
            <Form.Item name="type" label={t('settings.fieldType')}>
              <Select options={CUSTOM_FIELD_TYPES.map((k) => ({ value: k, label: t(`settings.fieldTypes.${k}`) }))} />
            </Form.Item>
          </Col>
        </Row>
        <Form.Item
          name="key"
          label={t('settings.fieldKey')}
          extra={t('settings.fieldKeyHint')}
          rules={[
            { required: true, pattern: /^[a-z][a-z0-9_]{0,31}$/ },
            { validator: (_, v) => (v && v !== field?.key && taken.has(v) ? Promise.reject(new Error('duplicate')) : Promise.resolve()) },
          ]}
        >
          <Input onChange={() => setKeyTouched(true)} style={{ fontFamily: 'ui-monospace, Menlo, monospace' }} />
        </Form.Item>
        <Form.Item name="tab" label={t('settings.fieldTab')} extra={t('settings.fieldTabHint')}>
          <AutoComplete options={tabs.map((x) => ({ value: x }))} placeholder="账户状态" allowClear />
        </Form.Item>
        {(type === 'select' || type === 'multiselect') && (
          <Form.Item label={t('settings.fieldOptions')} required>
            <Form.List name="options" rules={[{ validator: (_, v) => (v?.length ? Promise.resolve() : Promise.reject(new Error('≥ 1'))) }]}>
              {(items, { add, remove }, { errors }) => (
                <>
                  {items.map(({ key, name }) => (
                    <Space key={key} align="baseline" style={{ display: 'flex', marginBottom: 4 }}>
                      <Form.Item name={[name, 'label']} rules={[{ required: true }]} style={{ marginBottom: 4 }}>
                        <Input placeholder={t('settings.optionLabel')} style={{ width: 150 }} />
                      </Form.Item>
                      <Form.Item name={[name, 'value']} rules={[{ required: true, max: 64 }]} style={{ marginBottom: 4 }}>
                        <Input placeholder={t('settings.optionValue')} style={{ width: 130, fontFamily: 'ui-monospace, Menlo, monospace' }} />
                      </Form.Item>
                      <Form.Item name={[name, 'color']} style={{ marginBottom: 4 }}>
                        <Select
                          allowClear
                          style={{ width: 96 }}
                          placeholder={t('common.color')}
                          options={['green', 'blue', 'orange', 'red', 'purple', 'cyan', 'gold', 'magenta'].map((c) => ({ value: c, label: <Tag color={c}>{c}</Tag> }))}
                        />
                      </Form.Item>
                      <MinusCircleOutlined onClick={() => remove(name)} />
                    </Space>
                  ))}
                  <Button type="dashed" onClick={() => add({ value: '', label: '' })} icon={<PlusOutlined />} size="small">
                    {t('settings.addOption')}
                  </Button>
                  <Form.ErrorList errors={errors} />
                </>
              )}
            </Form.List>
          </Form.Item>
        )}
        <Form.Item name="description" label={t('common.note')}>
          <Input maxLength={200} />
        </Form.Item>
        <Space size={24}>
          <Form.Item name="showInTable" valuePropName="checked" noStyle>
            <Checkbox>{t('settings.showInTable')}</Checkbox>
          </Form.Item>
          <Form.Item name="required" valuePropName="checked" noStyle>
            <Checkbox>{t('settings.required')}</Checkbox>
          </Form.Item>
        </Space>
      </Form>
    </Modal>
  );
}

function CustomFieldsTab({ draft, setDraft }: { draft: AppConfig; setDraft: (c: AppConfig) => void }) {
  const { t } = useTranslation();
  const [entity, setEntity] = useState<CustomFieldEntity>('account');
  const [modal, setModal] = useState<{ open: boolean; field: CustomField | null }>({ open: false, field: null });
  const fields = useMemo(() => [...draft.customFields[entity]].sort((a, b) => a.order - b.order), [draft, entity]);
  const tabs = useMemo(() => [...new Set(CUSTOM_FIELD_ENTITIES.flatMap((e) => draft.customFields[e].map((f) => f.tab).filter((x): x is string => !!x)))], [draft]);

  const update = (list: CustomField[]) =>
    setDraft({ ...draft, customFields: { ...draft.customFields, [entity]: list.map((f, i) => ({ ...f, order: i })) } });
  const move = (i: number, d: -1 | 1) => {
    const list = [...fields];
    const [x] = list.splice(i, 1);
    list.splice(i + d, 0, x!);
    update(list);
  };

  const columns: TableColumnsType<CustomField> = [
    {
      key: 'label',
      title: t('settings.fieldLabel'),
      render: (_, f) => (
        <span>
          <span style={{ fontWeight: 500 }}>{f.label}</span> {f.required && <Tag color="red">{t('settings.required')}</Tag>}
          <div className="muted" style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12 }}>
            {f.key}
          </div>
        </span>
      ),
    },
    { key: 'type', title: t('settings.fieldType'), render: (_, f) => <Tag>{t(`settings.fieldTypes.${f.type}`)}</Tag> },
    {
      key: 'options',
      title: t('settings.fieldOptions'),
      responsive: ['md'],
      render: (_, f) =>
        f.options?.map((o) => (
          <Tag key={o.value} color={o.color}>
            {o.label}
          </Tag>
        )) ?? '—',
    },
    { key: 'tab', title: t('settings.fieldTab'), render: (_, f) => (f.tab ? <Tag color="geekblue">{f.tab}</Tag> : '—') },
    { key: 'table', title: t('settings.showInTable'), responsive: ['lg'], render: (_, f) => (f.showInTable ? t('common.yes') : t('common.no')) },
    {
      key: 'actions',
      title: '',
      width: 150,
      render: (_, f, i) => (
        <Space size={2}>
          <Button size="small" type="text" icon={<ArrowUpOutlined />} disabled={i === 0} onClick={() => move(i, -1)} />
          <Button size="small" type="text" icon={<ArrowDownOutlined />} disabled={i === fields.length - 1} onClick={() => move(i, 1)} />
          <Button size="small" type="text" icon={<EditOutlined />} onClick={() => setModal({ open: true, field: f })} />
          <Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={() => update(fields.filter((x) => x.key !== f.key))} />
        </Space>
      ),
    },
  ];

  return (
    <Card>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
        <Segmented value={entity} onChange={(v) => setEntity(v as CustomFieldEntity)} options={CUSTOM_FIELD_ENTITIES.map((e) => ({ value: e, label: t(`settings.entities.${e}`) }))} />
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setModal({ open: true, field: null })}>
          {t('settings.addField')}
        </Button>
      </div>
      <Table<CustomField> rowKey="key" columns={columns} dataSource={fields} pagination={false} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('settings.noFields')} /> }} scroll={{ x: 560 }} />
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 12, marginBottom: 0 }}>
        {t('settings.removeFieldNote')}
      </Typography.Paragraph>
      <FieldModal
        open={modal.open}
        field={modal.field}
        taken={new Set(fields.map((f) => f.key))}
        tabs={tabs}
        onClose={() => setModal({ open: false, field: null })}
        onSave={(f) => {
          const exists = fields.some((x) => x.key === (modal.field?.key ?? f.key));
          update(exists ? fields.map((x) => (x.key === (modal.field?.key ?? f.key) ? f : x)) : [...fields, f]);
          setModal({ open: false, field: null });
        }}
      />
    </Card>
  );
}

// ---------------------------------------------------------------- currencies, countries, reminders, maintenance

function ListEditor<T extends Record<string, unknown>>({
  items,
  onChange,
  columns,
  blank,
  addLabel,
}: {
  items: T[];
  onChange: (items: T[]) => void;
  columns: { key: keyof T & string; title: string; width?: number; render?: (v: T[keyof T], set: (v: unknown) => void) => React.ReactNode }[];
  blank: T;
  addLabel: string;
}) {
  const set = (i: number, k: keyof T, v: unknown) => onChange(items.map((it, j) => (j === i ? { ...it, [k]: v } : it)));
  return (
    <>
      <Table<T & { _i: number }>
        size="small"
        rowKey="_i"
        pagination={false}
        dataSource={items.map((it, i) => ({ ...it, _i: i }))}
        scroll={{ x: 420 }}
        columns={[
          ...columns.map((c) => ({
            key: c.key,
            title: c.title,
            width: c.width,
            render: (_: unknown, row: T & { _i: number }) =>
              c.render ? c.render(row[c.key], (v) => set(row._i, c.key, v)) : <Input size="small" value={String(row[c.key] ?? '')} onChange={(e) => set(row._i, c.key, e.target.value)} />,
          })),
          {
            key: '_del',
            width: 40,
            render: (_: unknown, row: T & { _i: number }) => (
              <Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={() => onChange(items.filter((_x, j) => j !== row._i))} />
            ),
          },
        ]}
      />
      <Button type="dashed" size="small" icon={<PlusOutlined />} style={{ marginTop: 8 }} onClick={() => onChange([...items, { ...blank }])}>
        {addLabel}
      </Button>
    </>
  );
}

function CurrenciesTab({ draft, setDraft }: { draft: AppConfig; setDraft: (c: AppConfig) => void }) {
  const { t } = useTranslation();
  return (
    <Row gutter={[16, 16]}>
      <Col xs={24} xl={13}>
        <Card title={t('settings.currencies')}>
          <Form layout="inline" style={{ marginBottom: 12 }}>
            <Form.Item label={t('settings.defaultCurrency')}>
              <Select
                style={{ width: 120 }}
                value={draft.app.defaultCurrency}
                onChange={(v) => setDraft({ ...draft, app: { ...draft.app, defaultCurrency: v } })}
                options={draft.currencies.map((c) => ({ value: c.code, label: c.code }))}
              />
            </Form.Item>
            <Form.Item label={t('settings.summaryCurrency')} tooltip={t('settings.summaryCurrencyHint')}>
              <Select
                style={{ width: 120 }}
                value={draft.app.summaryCurrency}
                onChange={(v) => setDraft({ ...draft, app: { ...draft.app, summaryCurrency: v } })}
                options={draft.currencies.map((c) => ({ value: c.code, label: c.code }))}
              />
            </Form.Item>
          </Form>
          <ListEditor
            items={draft.currencies}
            onChange={(currencies) => setDraft({ ...draft, currencies })}
            blank={{ code: '', name: '', symbol: '', decimals: 2 }}
            addLabel={t('settings.addCurrency')}
            columns={[
              { key: 'code', title: t('settings.code'), width: 90, render: (v, set) => <Input size="small" maxLength={3} value={String(v)} onChange={(e) => set(e.target.value.toUpperCase())} /> },
              { key: 'name', title: t('common.name') },
              { key: 'symbol', title: t('settings.symbol'), width: 90 },
              { key: 'decimals', title: t('settings.decimals'), width: 90, render: (v, set) => <InputNumber size="small" min={0} max={4} value={Number(v)} onChange={(n) => set(n ?? 0)} /> },
            ]}
          />
        </Card>
      </Col>
      <Col xs={24} xl={11}>
        <Card title={t('common.country')}>
          <ListEditor
            items={draft.countries}
            onChange={(countries) => setDraft({ ...draft, countries })}
            blank={{ code: '', name: '', flag: '' }}
            addLabel={t('settings.addCountry')}
            columns={[
              { key: 'code', title: t('settings.code'), width: 80, render: (v, set) => <Input size="small" maxLength={2} value={String(v)} onChange={(e) => set(e.target.value.toUpperCase())} /> },
              { key: 'name', title: t('common.name') },
              { key: 'flag', title: t('settings.flag'), width: 80 },
            ]}
          />
        </Card>
      </Col>
    </Row>
  );
}

function RemindersTab({ draft, setDraft }: { draft: AppConfig; setDraft: (c: AppConfig) => void }) {
  const { t } = useTranslation();
  const set = (k: keyof AppConfig['reminders'], v: number | null) => setDraft({ ...draft, reminders: { ...draft.reminders, [k]: v ?? 0 } });
  return (
    <Card>
      <Form layout="vertical" style={{ maxWidth: 360 }}>
        <Form.Item label={t('settings.reminderDefault')}>
          <InputNumber min={0} max={60} value={draft.reminders.defaultDaysBefore} onChange={(v) => set('defaultDaysBefore', v)} />
        </Form.Item>
        <Form.Item label={t('settings.reminderLookahead')}>
          <InputNumber min={1} max={120} value={draft.reminders.lookaheadDays} onChange={(v) => set('lookaheadDays', v)} />
        </Form.Item>
        <Form.Item label={t('settings.cardExpiry')}>
          <InputNumber min={0} max={365} value={draft.reminders.cardExpiryDays} onChange={(v) => set('cardExpiryDays', v)} />
        </Form.Item>
      </Form>
    </Card>
  );
}

function MaintenanceTab() {
  const { t } = useTranslation();
  const recalc = useAction(() => post('/accounts/recalc'), { success: t('settings.recalcDone') });
  return (
    <Card style={{ maxWidth: 640 }}>
      <Typography.Paragraph type="secondary">{t('settings.recalcHint')}</Typography.Paragraph>
      <Button icon={<ReloadOutlined />} loading={recalc.isPending} onClick={() => recalc.mutate(undefined)}>
        {t('settings.recalc')}
      </Button>
    </Card>
  );
}

// ---------------------------------------------------------------- page

function DiffView({ diff }: { diff: string }) {
  return (
    <div className="diff-view">
      {diff.split('\n').map((line, i) => (
        <span key={i} className={line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : 'ctx'}>
          {line || ' '}
        </span>
      ))}
    </div>
  );
}

export function SettingsPage() {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const qc = useQueryClient();
  const { data: me } = useMe();
  const { data: cfg } = useConfig();
  const isAdmin = me?.user.role === 'admin';
  const [draft, setDraft] = useState<AppConfig | null>(null);
  const [preview, setPreview] = useState<{ diff: string; summary: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<string | null>(null);

  useEffect(() => {
    if (cfg && !draft) setDraft(structuredClone(cfg));
  }, [cfg, draft]);

  const dirty = !!cfg && !!draft && JSON.stringify(cfg) !== JSON.stringify(draft);
  const summary = dirty ? summarizeConfigChange(cfg!, draft!) : '';

  const openPreview = async () => {
    try {
      const r = await post<{ diff: string; summary: string }>('/config/preview', { config: draft });
      setPreview(r);
    } catch (e) {
      void message.error(errorText(e, t));
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      await put('/config', { config: draft });
      await qc.invalidateQueries({ queryKey: ['config'] });
      setDraft(null); // re-initialised from the fresh config
      setPreview(null);
      void message.success(t('settings.savedDb'));
    } catch (e) {
      void message.error(errorText(e, t));
    } finally {
      setSaving(false);
    }
  };

  const adminTabs =
    isAdmin && draft
      ? [
          { key: 'fields', label: t('settings.customFields'), children: <CustomFieldsTab draft={draft} setDraft={setDraft} /> },
          { key: 'currencies', label: t('settings.currencies'), children: <CurrenciesTab draft={draft} setDraft={setDraft} /> },
          { key: 'reminders', label: t('settings.reminders'), children: <RemindersTab draft={draft} setDraft={setDraft} /> },
          { key: 'maintenance', label: t('settings.maintenance'), children: <MaintenanceTab /> },
        ]
      : [];

  return (
    <>
      <PageTop title={t('settings.title')} />
      <Typography.Paragraph type="secondary" style={{ marginTop: -8 }}>
        {isAdmin ? t('settings.configNote') : t('settings.adminOnly')}
      </Typography.Paragraph>
      <Tabs
        activeKey={tab ?? (isAdmin ? 'fields' : 'categories')}
        onChange={setTab}
        items={[
          ...adminTabs,
          { key: 'categories', label: t('settings.categories'), children: <CategoriesTab /> },
          { key: 'tags', label: t('settings.tags'), children: <TagsTab /> },
        ]}
      />
      <AnimatePresence>
        {dirty && (
          <motion.div className="save-bar" initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 24 }} transition={{ duration: 0.25 }}>
            <span>
              <Tag color="processing">{t('settings.pending')}</Tag>
              <span className="muted">{summary}</span>
            </span>
            <Space>
              <Button onClick={() => setDraft(structuredClone(cfg!))}>{t('settings.discard')}</Button>
              <Button type="primary" onClick={openPreview}>
                {t('settings.preview')}
              </Button>
            </Space>
          </motion.div>
        )}
      </AnimatePresence>
      <Modal
        open={!!preview}
        title={t('settings.previewTitle')}
        onCancel={() => setPreview(null)}
        onOk={save}
        okText={t('common.save')}
        confirmLoading={saving}
        width={760}
        destroyOnHidden
      >
        {preview && <DiffView diff={preview.diff} />}
      </Modal>
    </>
  );
}
