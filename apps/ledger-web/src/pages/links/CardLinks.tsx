import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { Alert, App, Button, Card, Checkbox, DatePicker, Empty, Form, Input, InputNumber, Modal, Radio, Select, Space, Tag, Typography } from 'antd';
import {
  CARD_LINK_ROLES,
  detectSensitive,
  localDate,
  NOTES_MAX,
  type AccountCurrencyDto,
  type AccountDto,
  type CardDto,
  type CardLinkDto,
  type CardLinkRole,
  type CurrencyCode,
  type DuplicateDetails,
} from '@xui/ledger-shared';
import dayjs, { type Dayjs } from 'dayjs';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { useAccounts, useRefreshAccounts } from '../../api/accounts.ts';
import { createLink, deleteLink, endLink, setDefaultLink, updateLink } from '../../api/cardLinks.ts';
import { useCards } from '../../api/cards.ts';
import { ApiError } from '../../api/client.ts';
import { errorText } from '../../api/hooks.ts';
import { InstitutionAvatar } from '../../components/InstitutionAvatar.tsx';
import { currencyName } from '../../lib/currencies.ts';
import { regionName } from '../../lib/regions.ts';

/**
 * The card ↔ account links of one card or one account (PRODUCT_SPEC §4.4, §4.5): the same component
 * on both detail pages, so both sides look and behave alike and refresh together. Current links
 * (active, suspended) come first — on the account side grouped by currency scope — and ended links
 * in a history section. "End" keeps the record as history; "delete" is only for correcting a
 * mistake. A link's role describes the relationship (spending source, top-up source, other); it is
 * not a transaction category.
 */

type Side = 'card' | 'account';
type Owner = { side: 'card'; card: CardDto } | { side: 'account'; account: AccountDto };

const DATE = 'YYYY-MM-DD';
/** Select value for "every currency of the account" (currency = null). */
const ALL = '*';

export function CardLinksPanel({ owner, links }: { owner: Owner; links: CardLinkDto[] }) {
  const { t } = useTranslation();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<CardLinkDto | null>(null);
  const actions = useLinkActions();
  const current = links.filter((l) => l.status !== 'ended');
  const ended = links.filter((l) => l.status === 'ended');
  const side = owner.side;

  const row = (l: CardLinkDto) => <LinkRow key={l.id} link={l} side={side} onEdit={() => setEditing(l)} actions={actions} />;
  // The account side groups current links by currency scope ("all currencies" first).
  const scopes = side === 'account' ? [...new Set(current.map((l) => l.currency))].sort((a, b) => (a === null ? -1 : b === null ? 1 : a.localeCompare(b))) : [];

  return (
    <Card
      title={t(side === 'card' ? 'cards.linkedAccounts' : 'accounts.cardLinks')}
      className={side === 'card' ? 'card-links' : 'account-links'}
      extra={
        <Button size="small" type="primary" icon={<PlusOutlined />} onClick={() => setAdding(true)}>
          {t(side === 'card' ? 'links.addAccount' : 'links.addCard')}
        </Button>
      }
    >
      {links.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t(side === 'card' ? 'cards.linkedAccountsEmpty' : 'accounts.cardLinksEmpty')} />}
      {side === 'card' && current.length > 0 && (
        <section className="ref-section link-current">
          <Typography.Title level={5}>
            {t('links.current')} <span className="muted">({current.length})</span>
          </Typography.Title>
          {current.map(row)}
        </section>
      )}
      {scopes.map((scope) => (
        <section key={scope ?? ALL} className="ref-section link-current" data-scope={scope ?? ALL}>
          <Typography.Title level={5}>{scope ?? t('accounts.scopeAll')}</Typography.Title>
          {current.filter((l) => l.currency === scope).map(row)}
        </section>
      ))}
      {ended.length > 0 && (
        <section className="ref-section link-history">
          <Typography.Title level={5}>
            {t('links.history')} <span className="muted">({ended.length})</span>
          </Typography.Title>
          <Typography.Text type="secondary" className="field-note">
            {t('links.historyHint')}
          </Typography.Text>
          {ended.map(row)}
        </section>
      )}
      <Typography.Paragraph type="secondary" className="field-note">
        {t('links.roleNote')}
      </Typography.Paragraph>
      <LinkFormModal open={adding} owner={owner} links={links} onClose={() => setAdding(false)} />
      <LinkEditModal link={editing} onClose={() => setEditing(null)} />
      {actions.endDialog}
    </Card>
  );
}

function LinkRow({ link: l, side, onEdit, actions }: { link: CardLinkDto; side: Side; onEdit: () => void; actions: LinkActions }) {
  const { t, i18n } = useTranslation();
  const ended = l.status === 'ended';
  const canDefault = l.role === 'spending_source' && l.status === 'active' && !l.isDefault;
  const other = side === 'card' ? l.account : l.card;
  return (
    <div className={`row-item link-row ${ended ? 'is-closed' : ''}`} data-link={l.id} data-status={l.status}>
      <div className="row-main">
        <div className="row-title">
          {side === 'card' ? (
            <Link to={`/accounts/${encodeURIComponent(l.accountId)}`}>{l.account.name}</Link>
          ) : (
            <>
              <Link to={`/cards/${encodeURIComponent(l.cardId)}`}>{l.card.name}</Link> <span className="muted">•••• {l.card.last4}</span>
            </>
          )}
        </div>
        <div className="row-sub">
          <span className="link-role">{t(`accounts.roles.${l.role}`)}</span>
          {' · '}
          <span className="link-scope">{l.currency ? `${l.currency} ${currencyName(l.currency, i18n.language)}` : t('accounts.scopeAll')}</span>
          {l.priority !== null && ` · ${t('links.priorityValue', { n: l.priority })}`}
          {side === 'card' && ` · ${t('cards.accountCountry')}: ${regionName(l.account.accountCountry, i18n.language)} (${l.account.accountCountry})`}
          {(l.startedOn || l.endedOn) && ` · ${l.startedOn ?? '…'} – ${l.endedOn ?? ''}`}
        </div>
        {l.notes && <div className="row-sub pre-wrap">{l.notes}</div>}
      </div>
      <Space size={4} wrap className="link-tags">
        {l.isDefault && <Tag color="blue">{t('accounts.defaultSource')}</Tag>}
        {l.status === 'suspended' && <Tag color="orange">{t('accounts.linkStatuses.suspended')}</Tag>}
        {ended && <Tag>{t('accounts.linkStatuses.ended')}</Tag>}
        {other.status !== 'active' && <Tag color="red">{t(side === 'card' ? `accounts.statuses.${l.account.status}` : `cards.statuses.${l.card.status}`)}</Tag>}
      </Space>
      <Space size={4} wrap className="link-actions">
        {canDefault && (
          <Button size="small" onClick={() => actions.makeDefault(l)}>
            {t('links.makeDefault')}
          </Button>
        )}
        <Button size="small" onClick={onEdit}>
          {t(ended ? 'links.editNotes' : 'links.edit')}
        </Button>
        {l.status === 'active' && (
          <Button size="small" onClick={() => actions.setStatus(l, 'suspended')}>
            {t('links.suspend')}
          </Button>
        )}
        {l.status === 'suspended' && (
          <Button size="small" onClick={() => actions.setStatus(l, 'active')}>
            {t('links.resume')}
          </Button>
        )}
        {!ended && (
          <Button size="small" onClick={() => actions.end(l)}>
            {t('links.end')}
          </Button>
        )}
        <Button size="small" danger icon={<DeleteOutlined />} aria-label={t('links.delete')} title={t('links.delete')} onClick={() => actions.remove(l)} />
      </Space>
    </div>
  );
}

type LinkActions = ReturnType<typeof useLinkActions>;

/** Set default, suspend / resume, end (dialog with the end date) and delete (confirmation). */
function useLinkActions() {
  const { t } = useTranslation();
  const { message, modal } = App.useApp();
  const refresh = useRefreshAccounts();
  const [ending, setEnding] = useState<CardLinkDto | null>(null);

  const run = async (fn: () => Promise<unknown>, done: string) => {
    try {
      await fn();
      void message.success(done);
    } catch (e) {
      void message.error(errorText(e, t));
    } finally {
      // Refresh either way: a 404 / 409 means someone else changed the link meanwhile.
      await refresh();
    }
  };

  return {
    makeDefault: (l: CardLinkDto) => run(() => setDefaultLink(l.id), t('links.defaultDone')),
    setStatus: (l: CardLinkDto, status: 'active' | 'suspended') => run(() => updateLink(l.id, { status }), t(status === 'suspended' ? 'links.suspendDone' : 'links.resumeDone')),
    end: (l: CardLinkDto) => setEnding(l),
    remove: (l: CardLinkDto) =>
      modal.confirm({
        title: t('links.deleteTitle'),
        content: t('links.deleteContent'),
        okText: t('links.delete'),
        okButtonProps: { danger: true },
        onOk: () => run(() => deleteLink(l.id), t('common.deleted')),
      }),
    endDialog: <EndDialog link={ending} onClose={() => setEnding(null)} onEnd={(l, endedOn) => run(() => endLink(l.id, { endedOn }), t('links.endDone'))} />,
  };
}

function EndDialog({ link, onClose, onEnd }: { link: CardLinkDto | null; onClose: () => void; onEnd: (l: CardLinkDto, endedOn: string) => Promise<void> }) {
  const { t } = useTranslation();
  const [date, setDate] = useState<Dayjs | null>(null);
  const [busy, setBusy] = useState(false);
  // The user's own calendar day (the server accepts it within a day of UTC's).
  useEffect(() => setDate(link ? dayjs(localDate()) : null), [link]);
  const startedOn = link?.startedOn ? dayjs(link.startedOn) : null;
  return (
    <Modal
      open={!!link}
      className="link-end-dialog"
      title={t('links.endTitle')}
      okText={t('links.end')}
      onCancel={onClose}
      confirmLoading={busy}
      okButtonProps={{ disabled: !date }}
      onOk={async () => {
        if (!link || !date) return;
        setBusy(true);
        try {
          await onEnd(link, date.format(DATE));
          onClose();
        } finally {
          setBusy(false);
        }
      }}
    >
      <Typography.Paragraph>{t('links.endContent')}</Typography.Paragraph>
      <label className="delete-confirm-label">
        {t('links.endedOn')}
        <DatePicker
          value={date}
          onChange={setDate}
          format={DATE}
          allowClear={false}
          aria-label={t('links.endedOn')}
          disabledDate={(d) => d.isAfter(dayjs(localDate()), 'day') || (!!startedOn && d.isBefore(startedOn, 'day'))}
        />
      </label>
    </Modal>
  );
}

interface CreateValues {
  otherId?: string;
  currency: string;
  role: CardLinkRole;
  isDefault: boolean;
  priority?: number | null;
  startedOn?: Dayjs | null;
  notes?: string;
}

const noSensitive = (message: string) => ({ validator: async (_: unknown, v?: string) => (v && detectSensitive(v) ? Promise.reject(new Error(message)) : undefined) });

/** New link from a card (pick the account) or from an account (pick the card). */
function LinkFormModal({ open, owner, links, onClose }: { open: boolean; owner: Owner; links: CardLinkDto[]; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const { message } = App.useApp();
  const refresh = useRefreshAccounts();
  const [form] = Form.useForm<CreateValues>();
  const [busy, setBusy] = useState(false);
  const [duplicate, setDuplicate] = useState<string | null>(null);
  // Every account / card of the user (closed ones too: links may record history), cached with the lists.
  const { data: accounts = [] } = useAccounts({ status: 'all' }, open && owner.side === 'card');
  const { data: cards = [] } = useCards({ status: 'all' }, open && owner.side === 'account');
  const otherId = Form.useWatch('otherId', form);
  const role = Form.useWatch('role', form);

  useEffect(() => {
    if (!open) return;
    form.resetFields();
    setDuplicate(null);
    form.setFieldsValue({ currency: ALL, role: 'spending_source', isDefault: false, priority: null, startedOn: dayjs(localDate()) });
  }, [open, form]);

  const account: AccountDto | undefined = owner.side === 'account' ? owner.account : accounts.find((a) => a.id === otherId);
  // A currency scope must be an active currency of the account (closed ones are listed, disabled).
  const scopeOptions = useMemo(() => {
    const list: AccountCurrencyDto[] = account?.currencies ?? [];
    return [
      { value: ALL, label: t('links.scopeAllHint') },
      ...list.map((c) => ({ value: c.currency, label: `${c.currency} · ${currencyName(c.currency, i18n.language)}${c.status === 'closed' ? ` (${t('accounts.currency.closed')})` : ''}`, disabled: c.status !== 'active' })),
    ];
  }, [account, i18n.language, t]);
  useEffect(() => {
    if (open && owner.side === 'card') form.setFieldsValue({ currency: ALL });
  }, [otherId, open, owner.side, form]);
  useEffect(() => {
    if (role && role !== 'spending_source') form.setFieldsValue({ isDefault: false });
  }, [role, form]);

  const otherOptions =
    owner.side === 'card'
      ? accounts.map((a) => ({
          value: a.id,
          search: `${a.name} ${a.institution.name}`,
          label: (
            <span className="institution-option">
              <InstitutionAvatar name={a.institution.name} color={a.institution.color} size={20} />
              {a.name}
              <span className="muted">
                {a.institution.name} · {a.accountCountry}
              </span>
              {a.status !== 'active' && <Tag>{t(`accounts.statuses.${a.status}`)}</Tag>}
            </span>
          ),
        }))
      : cards.map((c) => ({
          value: c.id,
          search: `${c.name} ${c.last4} ${c.issuer.name}`,
          label: (
            <span className="institution-option">
              {c.name} <span className="muted">•••• {c.last4}</span>
              {c.status !== 'active' && <Tag>{t(`cards.statuses.${c.status}`)}</Tag>}
            </span>
          ),
        }));
  const other = owner.side === 'card' ? accounts.find((a) => a.id === otherId) : cards.find((c) => c.id === otherId);

  const submit = async () => {
    let v: CreateValues;
    try {
      v = await form.validateFields();
    } catch {
      return;
    }
    setBusy(true);
    setDuplicate(null);
    try {
      await createLink({
        cardId: owner.side === 'card' ? owner.card.id : v.otherId!,
        accountId: owner.side === 'account' ? owner.account.id : v.otherId!,
        currency: v.currency === ALL ? null : (v.currency as CurrencyCode),
        role: v.role,
        isDefault: v.role === 'spending_source' && v.isDefault,
        priority: v.priority ?? null,
        startedOn: v.startedOn ? v.startedOn.format(DATE) : null,
        notes: v.notes?.trim() || null,
      });
      await refresh();
      void message.success(t('links.created'));
      onClose();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'DUPLICATE') setDuplicate((e.details as DuplicateDetails | undefined)?.existingId ?? '');
      else if (e instanceof ApiError && e.code === 'CURRENCY_NOT_ON_ACCOUNT') form.setFields([{ name: 'currency', errors: [t('errors.codes.CURRENCY_NOT_ON_ACCOUNT')] }]);
      else if (e instanceof ApiError && e.code === 'SENSITIVE_DATA') form.setFields([{ name: 'notes', errors: [t('links.sensitive')] }]);
      else void message.error(errorText(e, t));
      if (e instanceof ApiError && e.status === 404) await refresh();
    } finally {
      setBusy(false);
    }
  };

  const existing = duplicate ? links.find((l) => l.id === duplicate) : undefined;
  // Defaults are per card and currency scope: say which link the new default would replace.
  const scope = Form.useWatch('currency', form);
  const replaces = owner.side === 'card' ? links.find((l) => l.isDefault && (l.currency ?? ALL) === scope) : undefined;

  return (
    <Modal open={open} title={t(owner.side === 'card' ? 'links.addAccount' : 'links.addCard')} onCancel={onClose} onOk={submit} okText={t('common.save')} confirmLoading={busy} forceRender width={620} className="link-form-modal">
      <Form form={form} name="cardLink" layout="vertical" autoComplete="off">
        <Form.Item
          name="otherId"
          label={t(owner.side === 'card' ? 'links.account' : 'links.card')}
          rules={[{ required: true, message: t(owner.side === 'card' ? 'links.accountRequired' : 'links.cardRequired') }]}
        >
          <Select aria-label={t(owner.side === 'card' ? 'links.account' : 'links.card')} showSearch={{ optionFilterProp: 'search' }} options={otherOptions} notFoundContent={t('accounts.none')} />
        </Form.Item>
        {other && other.status !== 'active' && <Alert type="warning" showIcon className="form-alert" title={t('links.inactiveOther')} />}
        <Form.Item name="currency" label={t('links.scope')} extra={t('links.scopeHint')} rules={[{ required: true }]}>
          <Select aria-label={t('links.scope')} options={scopeOptions} disabled={!account} />
        </Form.Item>
        <Form.Item name="role" label={t('links.role')} extra={t('links.roleHint')}>
          <Radio.Group options={CARD_LINK_ROLES.map((r) => ({ value: r, label: t(`accounts.roles.${r}`) }))} />
        </Form.Item>
        <Form.Item name="isDefault" valuePropName="checked" extra={replaces ? t('links.defaultReplaces', { name: replaces.account.name }) : t('links.defaultHint')}>
          <Checkbox disabled={role !== 'spending_source'}>{t('links.isDefault')}</Checkbox>
        </Form.Item>
        <Space size={16} wrap className="form-pair">
          <Form.Item name="priority" label={t('links.priority')} extra={t('links.priorityHint')}>
            <InputNumber aria-label={t('links.priority')} precision={0} min={1} max={1_000_000} style={{ width: 160 }} />
          </Form.Item>
          <Form.Item name="startedOn" label={t('links.startedOn')}>
            <DatePicker format={DATE} aria-label={t('links.startedOn')} />
          </Form.Item>
        </Space>
        <Form.Item name="notes" label={t('links.notes')} rules={[{ max: NOTES_MAX }, noSensitive(t('links.sensitive'))]}>
          <Input.TextArea rows={2} maxLength={NOTES_MAX} showCount aria-label={t('links.notes')} />
        </Form.Item>
      </Form>
      {duplicate !== null && (
        <Alert
          type="warning"
          showIcon
          className="form-alert link-duplicate"
          title={t('links.duplicate')}
          description={existing ? `${existing.account.name} · ${existing.card.name} · ${t(`accounts.roles.${existing.role}`)} · ${existing.currency ?? t('accounts.scopeAll')}` : undefined}
        />
      )}
    </Modal>
  );
}

interface EditValues {
  role: CardLinkRole;
  priority?: number | null;
  notes?: string;
}

/** Role, priority and notes. Card, account and currency scope are fixed: end the link and create another to change them. Ended links: notes only. */
function LinkEditModal({ link, onClose }: { link: CardLinkDto | null; onClose: () => void }) {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const refresh = useRefreshAccounts();
  const [form] = Form.useForm<EditValues>();
  const [busy, setBusy] = useState(false);
  const ended = link?.status === 'ended';
  const role = Form.useWatch('role', form);

  useEffect(() => {
    if (!link) return;
    form.resetFields();
    form.setFieldsValue({ role: link.role, priority: link.priority, notes: link.notes ?? '' });
  }, [link, form]);

  const submit = async () => {
    if (!link) return;
    let v: EditValues;
    try {
      v = await form.validateFields();
    } catch {
      return;
    }
    setBusy(true);
    try {
      await updateLink(link.id, ended ? { notes: v.notes?.trim() || null } : { role: v.role, priority: v.priority ?? null, notes: v.notes?.trim() || null });
      await refresh();
      void message.success(t('common.saved'));
      onClose();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'SENSITIVE_DATA') form.setFields([{ name: 'notes', errors: [t('links.sensitive')] }]);
      else {
        void message.error(errorText(e, t));
        await refresh();
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={!!link} title={t(ended ? 'links.editNotes' : 'links.edit')} onCancel={onClose} onOk={submit} okText={t('common.save')} confirmLoading={busy} forceRender className="link-edit-modal">
      {link && (
        <Typography.Paragraph className="muted">
          {link.card.name} •••• {link.card.last4} → {link.account.name} · {link.currency ?? t('accounts.scopeAll')}
        </Typography.Paragraph>
      )}
      <Form form={form} name="cardLinkEdit" layout="vertical" autoComplete="off">
        <Form.Item name="role" label={t('links.role')} extra={link?.isDefault && role !== 'spending_source' ? t('links.roleClearsDefault') : t('links.fixedFields')}>
          <Radio.Group disabled={ended} options={CARD_LINK_ROLES.map((r) => ({ value: r, label: t(`accounts.roles.${r}`) }))} />
        </Form.Item>
        <Form.Item name="priority" label={t('links.priority')} extra={t('links.priorityHint')}>
          <InputNumber aria-label={t('links.priority')} disabled={ended} precision={0} min={1} max={1_000_000} style={{ width: 160 }} />
        </Form.Item>
        <Form.Item name="notes" label={t('links.notes')} rules={[{ max: NOTES_MAX }, noSensitive(t('links.sensitive'))]}>
          <Input.TextArea rows={2} maxLength={NOTES_MAX} showCount aria-label={t('links.notes')} />
        </Form.Item>
      </Form>
    </Modal>
  );
}
