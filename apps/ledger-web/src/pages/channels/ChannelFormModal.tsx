import { Alert, App, Button, Form, Input, InputNumber, Modal, Radio, Select, Tag } from 'antd';
import {
  BALANCE_ACCOUNT_TYPES,
  CHANNEL_TYPES,
  detectSensitive,
  NAME_MAX,
  NOTES_MAX,
  type ChannelType,
  type ChannelTypeChangeDetails,
  type CountryCode,
  type DuplicateDetails,
  type PaymentChannelDetail,
  type PaymentChannelDto,
} from '@xui/ledger-shared';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { useAccounts, useRefreshAccounts } from '../../api/accounts.ts';
import { channelHref, createChannel, updateChannel, useChannels } from '../../api/channels.ts';
import { ApiError } from '../../api/client.ts';
import { errorText } from '../../api/hooks.ts';
import { useInstitutions } from '../../api/institutions.ts';
import { InstitutionAvatar } from '../../components/InstitutionAvatar.tsx';
import { regionOptions } from '../../lib/regions.ts';

interface FormValues {
  name: string;
  channelType: ChannelType;
  providerInstitutionId?: string | null;
  balanceAccountId?: string | null;
  region?: CountryCode | null;
  notes?: string;
  sort?: number | null;
}

const noSensitive = (message: string) => ({ validator: async (_: unknown, v?: string) => (v && detectSensitive(v) ? Promise.reject(new Error(message)) : undefined) });

/**
 * Create / edit a payment channel. A funds account (the API's balance account) is only offered for
 * payment services and only e-money / stored-value accounts; accounts that already back another
 * channel are listed but disabled. A newly chosen provider must be active — archived institutions
 * are only shown when they are the channel's current provider. The server is the authority; the
 * same rules run here only for immediate feedback.
 */
export function ChannelFormModal({ open, editing, onClose }: { open: boolean; editing: PaymentChannelDto | null; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const { message } = App.useApp();
  const navigate = useNavigate();
  const refresh = useRefreshAccounts();
  const [form] = Form.useForm<FormValues>();
  const [busy, setBusy] = useState(false);
  const [duplicate, setDuplicate] = useState<string | null>(null);
  const countries = useMemo(() => regionOptions(i18n.language), [i18n.language]);
  const { data: institutions = [] } = useInstitutions({ status: 'all' });
  const { data: accounts = [] } = useAccounts({ status: 'all' }, open);
  const { data: channels = [] } = useChannels({ status: 'all' }, open);
  const channelType = Form.useWatch('channelType', form);
  // Account sources (active or ended) keep a channel from becoming a device wallet: their history is
  // kept as recorded, so the advice is a new device-wallet channel — never deleting history.
  const typeChangeRefusal = (d: Pick<ChannelTypeChangeDetails, 'activeAccountSources' | 'endedAccountSources'> | undefined) =>
    d && d.activeAccountSources === 0 && d.endedAccountSources > 0
      ? t('channels.sourceKindHistory', { n: d.endedAccountSources })
      : t('channels.sourceKindActive', { n: d?.activeAccountSources ?? 0 });
  // Known up front on the detail page (which passes the channel with its sources).
  const accountSources = editing && 'sources' in editing ? (editing as PaymentChannelDetail).sources.filter((s) => s.accountId) : [];
  const blocked =
    channelType === 'device_wallet' && editing?.channelType !== 'device_wallet' && accountSources.length > 0
      ? typeChangeRefusal({
          activeAccountSources: accountSources.filter((s) => s.status === 'active').length,
          endedAccountSources: accountSources.filter((s) => s.status === 'ended').length,
        })
      : null;

  useEffect(() => {
    if (!open) return;
    form.resetFields();
    setDuplicate(null);
    form.setFieldsValue(
      editing
        ? {
            name: editing.name,
            channelType: editing.channelType,
            providerInstitutionId: editing.providerInstitutionId,
            balanceAccountId: editing.balanceAccountId,
            region: editing.region as CountryCode | null,
            notes: editing.notes ?? '',
            sort: editing.sort,
          }
        : { channelType: 'payment_service', providerInstitutionId: null, balanceAccountId: null, region: null, sort: 0 },
    );
  }, [open, editing, form]);

  const providerOptions = institutions
    .filter((i) => i.status === 'active' || i.id === editing?.providerInstitutionId)
    .map((i) => ({
      value: i.id,
      search: i.name,
      label: (
        <span className="institution-option">
          <InstitutionAvatar name={i.name} color={i.color} size={20} />
          {i.name}
          {i.status === 'archived' && <Tag>{t('institutions.statuses.archived')}</Tag>}
        </span>
      ),
    }));
  // Which channel already uses each account as its funds account (one channel per account).
  const usedBy = new Map(channels.filter((c) => c.balanceAccountId && c.id !== editing?.id).map((c) => [c.balanceAccountId!, c.name]));
  const balanceOptions = accounts
    .filter((a) => (BALANCE_ACCOUNT_TYPES as readonly string[]).includes(a.accountType))
    .map((a) => ({
      value: a.id,
      search: `${a.name} ${a.institution.name}`,
      disabled: usedBy.has(a.id),
      label: (
        <span className="institution-option">
          <InstitutionAvatar name={a.institution.name} color={a.institution.color} size={20} />
          {a.name}
          <span className="muted">
            {a.institution.name} · {t(`accounts.types.${a.accountType}`)}
          </span>
          {a.status !== 'active' && <Tag>{t(`accounts.statuses.${a.status}`)}</Tag>}
          {usedBy.has(a.id) && <span className="muted">{t('channels.balanceUsedBy', { name: usedBy.get(a.id) })}</span>}
        </span>
      ),
    }));

  const submit = async () => {
    let v: FormValues;
    try {
      v = await form.validateFields();
    } catch {
      return;
    }
    setBusy(true);
    setDuplicate(null);
    const body = {
      name: v.name.trim(),
      channelType: v.channelType,
      providerInstitutionId: v.providerInstitutionId ?? null,
      // Only payment services have one: switching the type releases it.
      balanceAccountId: v.channelType === 'payment_service' ? (v.balanceAccountId ?? null) : null,
      region: v.region ?? null,
      notes: v.notes?.trim() || null,
      sort: v.sort ?? 0,
    };
    try {
      if (editing) await updateChannel(editing.id, body);
      else await createChannel(body);
      await refresh();
      void message.success(editing ? t('common.saved') : t('channels.created'));
      onClose();
    } catch (e) {
      const code = e instanceof ApiError ? e.code : undefined;
      if (code === 'DUPLICATE') {
        // One DUPLICATE code for two rules: the name, or the funds account already backing another channel.
        const existingId = ((e as ApiError).details as DuplicateDetails | undefined)?.existingId ?? '';
        const holder = channels.find((c) => c.id === existingId);
        if (holder && body.balanceAccountId && holder.balanceAccountId === body.balanceAccountId) form.setFields([{ name: 'balanceAccountId', errors: [t('channels.duplicateBalance', { name: holder.name })] }]);
        else setDuplicate(existingId);
      } else if (code === 'BALANCE_ACCOUNT_KIND') form.setFields([{ name: 'balanceAccountId', errors: [t('channels.balanceKind')] }]);
      else if (code === 'CHANNEL_SOURCE_KIND') form.setFields([{ name: 'channelType', errors: [typeChangeRefusal((e as ApiError).details as ChannelTypeChangeDetails | undefined)] }]);
      else if (code === 'INSTITUTION_ARCHIVED') form.setFields([{ name: 'providerInstitutionId', errors: [t('channels.providerArchived')] }]);
      else if (code === 'SENSITIVE_DATA') {
        const fields = (((e as ApiError).details as { fields?: { field: string }[] } | undefined)?.fields ?? []).map((f) => f.field);
        form.setFields((fields.length ? fields : ['notes']).map((name) => ({ name: name as keyof FormValues, errors: [t('channels.sensitive')] })));
      } else void message.error(errorText(e, t));
      if (e instanceof ApiError && e.status === 404) await refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} title={editing ? t('channels.edit') : t('channels.add')} onCancel={onClose} onOk={submit} okText={t('common.save')} confirmLoading={busy} forceRender width={620} className="channel-form-modal">
      <Form form={form} name="paymentChannel" layout="vertical" autoComplete="off">
        <Form.Item name="name" label={t('channels.name')} rules={[{ required: true, whitespace: true, max: NAME_MAX }, noSensitive(t('channels.sensitive'))]}>
          <Input maxLength={NAME_MAX} aria-label={t('channels.name')} />
        </Form.Item>
        <Form.Item name="channelType" label={t('channels.type')} extra={channelType ? t(`channels.typeHints.${channelType}`) : undefined} rules={[{ required: true }]}>
          <Radio.Group options={CHANNEL_TYPES.map((v) => ({ value: v, label: t(`channels.types.${v}`) }))} />
        </Form.Item>
        {blocked && <Alert type="warning" showIcon className="form-alert channel-type-blocked" title={blocked} />}
        <Form.Item name="providerInstitutionId" label={t('channels.provider')} extra={t('channels.providerHint')}>
          <Select allowClear aria-label={t('channels.provider')} placeholder={t('channels.noProvider')} showSearch={{ optionFilterProp: 'search' }} options={providerOptions} notFoundContent={t('accounts.none')} />
        </Form.Item>
        {channelType === 'payment_service' && (
          <Form.Item name="balanceAccountId" label={t('channels.balanceAccount')} extra={t('channels.balanceHint')}>
            <Select allowClear aria-label={t('channels.balanceAccount')} placeholder={t('channels.noBalance')} showSearch={{ optionFilterProp: 'search' }} options={balanceOptions} notFoundContent={t('accounts.none')} />
          </Form.Item>
        )}
        <Form.Item name="region" label={t('channels.region')} extra={t('channels.regionHint')}>
          <Select allowClear aria-label={t('channels.region')} placeholder={t('channels.noRegion')} showSearch={{ optionFilterProp: 'label' }} options={countries} />
        </Form.Item>
        <Form.Item name="notes" label={t('channels.notes')} rules={[{ max: NOTES_MAX }, noSensitive(t('channels.sensitive'))]}>
          <Input.TextArea rows={2} maxLength={NOTES_MAX} showCount aria-label={t('channels.notes')} />
        </Form.Item>
        <Form.Item name="sort" label={t('channels.sort')}>
          <InputNumber aria-label={t('channels.sort')} precision={0} min={-1_000_000} max={1_000_000} style={{ width: 160 }} />
        </Form.Item>
      </Form>
      {duplicate !== null && (
        <Alert
          type="warning"
          showIcon
          className="form-alert channel-duplicate"
          title={t('channels.duplicateName')}
          action={
            duplicate ? (
              <Button
                size="small"
                onClick={() => {
                  onClose();
                  navigate(channelHref(duplicate));
                }}
              >
                {t('channels.viewExisting')}
              </Button>
            ) : undefined
          }
        />
      )}
    </Modal>
  );
}
