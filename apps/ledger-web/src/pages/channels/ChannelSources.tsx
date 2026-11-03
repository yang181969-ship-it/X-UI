import { CreditCardOutlined, DeleteOutlined, PlusOutlined, WalletOutlined } from '@ant-design/icons';
import { Alert, App, Button, Card, Checkbox, Empty, Form, Input, Modal, Radio, Select, Space, Tag, Typography } from 'antd';
import { detectSensitive, NOTES_MAX, type ChannelSourceDto, type PaymentChannelDetail } from '@xui/ledger-shared';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { useAccounts, useRefreshAccounts } from '../../api/accounts.ts';
import { useCards } from '../../api/cards.ts';
import { createSource, deleteSource, endSource, updateSource } from '../../api/channels.ts';
import { ApiError } from '../../api/client.ts';
import { errorText } from '../../api/hooks.ts';
import { InstitutionAvatar } from '../../components/InstitutionAvatar.tsx';
import { regionName } from '../../lib/regions.ts';

/**
 * The funding sources of one payment channel (API_SPEC §3.6): the cards or accounts behind it.
 * Current (active) sources first, ended ones in a history section. "End" keeps the record as
 * history (and clears the default); "delete" is only for correcting a mistake. A device wallet is
 * funded by cards only. Sources describe the channel — they are not charges, and future
 * transactions keep the source actually used at the time.
 */
export function ChannelSourcesPanel({ channel }: { channel: PaymentChannelDetail }) {
  const { t } = useTranslation();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<ChannelSourceDto | null>(null);
  const actions = useSourceActions();
  const current = channel.sources.filter((s) => s.status === 'active');
  const ended = channel.sources.filter((s) => s.status === 'ended');
  const row = (s: ChannelSourceDto) => <SourceRow key={s.id} source={s} onEdit={() => setEditing(s)} actions={actions} />;

  return (
    <Card
      title={t('channels.sources')}
      className="channel-sources"
      extra={
        <Button size="small" type="primary" icon={<PlusOutlined />} onClick={() => setAdding(true)}>
          {t('channels.source.add')}
        </Button>
      }
    >
      {channel.sources.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('channels.source.empty')} />}
      {current.length > 0 && (
        <section className="ref-section source-current">
          <Typography.Title level={5}>
            {t('channels.source.current')} <span className="muted">({current.length})</span>
          </Typography.Title>
          {current.map(row)}
        </section>
      )}
      {ended.length > 0 && (
        <section className="ref-section source-history">
          <Typography.Title level={5}>
            {t('channels.source.history')} <span className="muted">({ended.length})</span>
          </Typography.Title>
          <Typography.Text type="secondary" className="field-note">
            {t('channels.source.historyHint')}
          </Typography.Text>
          {ended.map(row)}
        </section>
      )}
      <Typography.Paragraph type="secondary" className="field-note">
        {t('channels.source.note')}
      </Typography.Paragraph>
      <SourceFormModal open={adding} channel={channel} onClose={() => setAdding(false)} />
      <SourceNotesModal source={editing} onClose={() => setEditing(null)} />
    </Card>
  );
}

/** "•••• 1234" name of a source, for messages. */
const sourceName = (s: ChannelSourceDto) => (s.card ? `${s.card.name} •••• ${s.card.last4}` : (s.account?.name ?? ''));

function SourceRow({ source: s, onEdit, actions }: { source: ChannelSourceDto; onEdit: () => void; actions: SourceActions }) {
  const { t, i18n } = useTranslation();
  const ended = s.status === 'ended';
  const target = s.card ?? s.account;
  return (
    <div className={`row-item link-row source-row ${ended ? 'is-closed' : ''}`} data-source={s.id} data-status={s.status}>
      <div className="row-main">
        <div className="row-title">
          {s.card ? (
            <>
              <CreditCardOutlined /> <Link to={`/cards/${encodeURIComponent(s.card.id)}`}>{s.card.name}</Link> <span className="muted">•••• {s.card.last4}</span>
            </>
          ) : (
            s.account && (
              <>
                <WalletOutlined /> <Link to={`/accounts/${encodeURIComponent(s.account.id)}`}>{s.account.name}</Link>
              </>
            )
          )}
        </div>
        <div className="row-sub">
          <span className="source-kind">{t(`channels.source.kinds.${s.card ? 'card' : 'account'}`)}</span>
          {s.card && ` · ${t(`cards.networks.${s.card.network}`)} · ${t(`cards.types.${s.card.cardType}`)}`}
          {s.account && ` · ${t('cards.accountCountry')}: ${regionName(s.account.accountCountry, i18n.language)} (${s.account.accountCountry})`}
        </div>
        {s.notes && <div className="row-sub pre-wrap">{s.notes}</div>}
      </div>
      <Space size={4} wrap className="link-tags">
        {s.isDefault && <Tag color="blue">{t('accounts.defaultSource')}</Tag>}
        {ended && <Tag>{t('accounts.linkStatuses.ended')}</Tag>}
        {target && target.status !== 'active' && <Tag color="red">{t(s.card ? `cards.statuses.${s.card.status}` : `accounts.statuses.${s.account!.status}`)}</Tag>}
      </Space>
      <Space size={4} wrap className="link-actions">
        {!ended && !s.isDefault && (
          <Button size="small" onClick={() => actions.setDefault(s, true)}>
            {t('channels.source.makeDefault')}
          </Button>
        )}
        {s.isDefault && (
          <Button size="small" onClick={() => actions.setDefault(s, false)}>
            {t('channels.source.unsetDefault')}
          </Button>
        )}
        <Button size="small" onClick={onEdit}>
          {t('channels.source.editNotes')}
        </Button>
        {!ended && (
          <Button size="small" onClick={() => actions.end(s)}>
            {t('channels.source.end')}
          </Button>
        )}
        <Button size="small" danger icon={<DeleteOutlined />} aria-label={t('channels.source.delete')} title={t('channels.source.delete')} onClick={() => actions.remove(s)} />
      </Space>
    </div>
  );
}

type SourceActions = ReturnType<typeof useSourceActions>;

/** Default on / off, end (confirmation: keeps history) and delete (confirmation: correcting mistakes). */
function useSourceActions() {
  const { t } = useTranslation();
  const { message, modal } = App.useApp();
  const refresh = useRefreshAccounts();

  const run = async (fn: () => Promise<unknown>, done: string) => {
    try {
      await fn();
      void message.success(done);
    } catch (e) {
      void message.error(errorText(e, t));
    } finally {
      // Refresh either way: a 404 / 409 means someone else changed the source meanwhile.
      await refresh();
    }
  };

  return {
    setDefault: (s: ChannelSourceDto, isDefault: boolean) => run(() => updateSource(s.id, { isDefault }), t(isDefault ? 'channels.source.defaultDone' : 'channels.source.unsetDone')),
    end: (s: ChannelSourceDto) =>
      modal.confirm({
        className: 'source-end-dialog',
        title: t('channels.source.endTitle'),
        content: (
          <>
            <Typography.Paragraph strong>{sourceName(s)}</Typography.Paragraph>
            <Typography.Paragraph>{t('channels.source.endContent')}</Typography.Paragraph>
          </>
        ),
        okText: t('channels.source.end'),
        onOk: () => run(() => endSource(s.id), t('channels.source.endDone')),
      }),
    remove: (s: ChannelSourceDto) =>
      modal.confirm({
        className: 'source-delete-dialog',
        title: t('channels.source.deleteTitle'),
        content: (
          <>
            <Typography.Paragraph strong>{sourceName(s)}</Typography.Paragraph>
            <Typography.Paragraph>{t('channels.source.deleteContent')}</Typography.Paragraph>
          </>
        ),
        okText: t('channels.source.delete'),
        okButtonProps: { danger: true },
        onOk: () => run(() => deleteSource(s.id), t('common.deleted')),
      }),
  };
}

const noSensitive = (message: string) => ({ validator: async (_: unknown, v?: string) => (v && detectSensitive(v) ? Promise.reject(new Error(message)) : undefined) });

interface CreateValues {
  kind: 'card' | 'account';
  cardId?: string;
  accountId?: string;
  isDefault: boolean;
  notes?: string;
}

/** Add a card or (except for device wallets) an account as a funding source. */
function SourceFormModal({ open, channel, onClose }: { open: boolean; channel: PaymentChannelDetail; onClose: () => void }) {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const refresh = useRefreshAccounts();
  const [form] = Form.useForm<CreateValues>();
  const [busy, setBusy] = useState(false);
  const [duplicate, setDuplicate] = useState(false);
  const cardsOnly = channel.channelType === 'device_wallet';
  // Every card / account of the user (closed ones too: a source may record history).
  const { data: cards = [] } = useCards({ status: 'all' }, open);
  const { data: accounts = [] } = useAccounts({ status: 'all' }, open && !cardsOnly);
  const kind = Form.useWatch('kind', form);
  const cardId = Form.useWatch('cardId', form);
  const accountId = Form.useWatch('accountId', form);

  useEffect(() => {
    if (!open) return;
    form.resetFields();
    setDuplicate(false);
    form.setFieldsValue({ kind: 'card', isDefault: false });
  }, [open, form]);

  // One active record per source: those already active on this channel are listed but disabled.
  const activeCards = new Set(channel.sources.filter((s) => s.status === 'active' && s.cardId).map((s) => s.cardId));
  const activeAccounts = new Set(channel.sources.filter((s) => s.status === 'active' && s.accountId).map((s) => s.accountId));
  const cardOptions = cards.map((c) => ({
    value: c.id,
    search: `${c.name} ${c.last4} ${c.issuer.name}`,
    disabled: activeCards.has(c.id),
    label: (
      <span className="institution-option">
        {c.name} <span className="muted">•••• {c.last4}</span>
        {c.status !== 'active' && <Tag>{t(`cards.statuses.${c.status}`)}</Tag>}
        {activeCards.has(c.id) && <span className="muted">{t('channels.source.alreadyActive')}</span>}
      </span>
    ),
  }));
  const accountOptions = accounts.map((a) => ({
    value: a.id,
    search: `${a.name} ${a.institution.name}`,
    disabled: activeAccounts.has(a.id),
    label: (
      <span className="institution-option">
        <InstitutionAvatar name={a.institution.name} color={a.institution.color} size={20} />
        {a.name}
        <span className="muted">
          {a.institution.name} · {a.accountCountry}
        </span>
        {a.status !== 'active' && <Tag>{t(`accounts.statuses.${a.status}`)}</Tag>}
        {activeAccounts.has(a.id) && <span className="muted">{t('channels.source.alreadyActive')}</span>}
      </span>
    ),
  }));
  const picked = kind === 'account' ? accounts.find((a) => a.id === accountId) : cards.find((c) => c.id === cardId);
  const replaces = channel.sources.find((s) => s.isDefault);

  const submit = async () => {
    let v: CreateValues;
    try {
      v = await form.validateFields();
    } catch {
      return;
    }
    setBusy(true);
    setDuplicate(false);
    try {
      await createSource(channel.id, { ...(v.kind === 'card' ? { cardId: v.cardId! } : { accountId: v.accountId! }), isDefault: v.isDefault, notes: v.notes?.trim() || null });
      await refresh();
      void message.success(t('channels.source.created'));
      onClose();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'DUPLICATE') setDuplicate(true);
      else if (e instanceof ApiError && e.code === 'SENSITIVE_DATA') form.setFields([{ name: 'notes', errors: [t('channels.sensitive')] }]);
      else void message.error(errorText(e, t));
      if (e instanceof ApiError && (e.status === 404 || e.code === 'CHANNEL_SOURCE_KIND' || e.code === 'DUPLICATE')) await refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} title={t('channels.source.add')} onCancel={onClose} onOk={submit} okText={t('common.save')} confirmLoading={busy} forceRender width={600} className="source-form-modal">
      <Form form={form} name="channelSource" layout="vertical" autoComplete="off">
        <Form.Item name="kind" label={t('channels.source.kind')} extra={cardsOnly ? t('channels.source.walletCardsOnly') : undefined}>
          <Radio.Group
            options={[
              { value: 'card', label: t('channels.source.kinds.card') },
              { value: 'account', label: t('channels.source.kinds.account'), disabled: cardsOnly },
            ]}
          />
        </Form.Item>
        {kind !== 'account' ? (
          <Form.Item name="cardId" label={t('channels.source.card')} rules={[{ required: true, message: t('channels.source.cardRequired') }]}>
            <Select aria-label={t('channels.source.card')} showSearch={{ optionFilterProp: 'search' }} options={cardOptions} notFoundContent={t('accounts.none')} />
          </Form.Item>
        ) : (
          <Form.Item name="accountId" label={t('channels.source.account')} rules={[{ required: true, message: t('channels.source.accountRequired') }]}>
            <Select aria-label={t('channels.source.account')} showSearch={{ optionFilterProp: 'search' }} options={accountOptions} notFoundContent={t('accounts.none')} />
          </Form.Item>
        )}
        {picked && picked.status !== 'active' && <Alert type="warning" showIcon className="form-alert" title={t('channels.source.inactive')} />}
        <Form.Item name="isDefault" valuePropName="checked" extra={replaces ? t('channels.source.defaultReplaces', { name: sourceName(replaces) }) : t('channels.source.defaultHint')}>
          <Checkbox>{t('channels.source.isDefault')}</Checkbox>
        </Form.Item>
        <Form.Item name="notes" label={t('channels.source.notes')} rules={[{ max: NOTES_MAX }, noSensitive(t('channels.sensitive'))]}>
          <Input.TextArea rows={2} maxLength={NOTES_MAX} showCount aria-label={t('channels.source.notes')} />
        </Form.Item>
      </Form>
      {duplicate && <Alert type="warning" showIcon className="form-alert source-duplicate" title={t('channels.source.duplicate')} />}
    </Modal>
  );
}

/** Notes only — any status (an ended source keeps its notes editable). */
function SourceNotesModal({ source, onClose }: { source: ChannelSourceDto | null; onClose: () => void }) {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const refresh = useRefreshAccounts();
  const [form] = Form.useForm<{ notes?: string }>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!source) return;
    form.resetFields();
    form.setFieldsValue({ notes: source.notes ?? '' });
  }, [source, form]);

  const submit = async () => {
    if (!source) return;
    let v: { notes?: string };
    try {
      v = await form.validateFields();
    } catch {
      return;
    }
    setBusy(true);
    try {
      await updateSource(source.id, { notes: v.notes?.trim() || null });
      await refresh();
      void message.success(t('common.saved'));
      onClose();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'SENSITIVE_DATA') form.setFields([{ name: 'notes', errors: [t('channels.sensitive')] }]);
      else {
        void message.error(errorText(e, t));
        await refresh();
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={!!source} title={t('channels.source.editNotes')} onCancel={onClose} onOk={submit} okText={t('common.save')} confirmLoading={busy} forceRender className="source-notes-modal">
      {source && <Typography.Paragraph className="muted">{sourceName(source)}</Typography.Paragraph>}
      <Form form={form} name="channelSourceNotes" layout="vertical" autoComplete="off">
        <Form.Item name="notes" label={t('channels.source.notes')} rules={[{ max: NOTES_MAX }, noSensitive(t('channels.sensitive'))]}>
          <Input.TextArea rows={2} maxLength={NOTES_MAX} showCount aria-label={t('channels.source.notes')} />
        </Form.Item>
      </Form>
    </Modal>
  );
}
