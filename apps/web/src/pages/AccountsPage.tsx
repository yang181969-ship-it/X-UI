import { DeleteOutlined, EditOutlined, InboxOutlined, MinusCircleOutlined, MoreOutlined, PlusOutlined, StarFilled, StarOutlined } from '@ant-design/icons';
import {
  App,
  Button,
  Card,
  Col,
  ColorPicker,
  DatePicker,
  Descriptions,
  Drawer,
  Dropdown,
  Empty,
  Form,
  Input,
  Modal,
  Pagination,
  Row,
  Select,
  Skeleton,
  Space,
  Switch,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router';
import { ACCOUNT_TYPES, INSTITUTION_TYPES, type AccountDto, type InstitutionDto, type TransactionDto } from '@z-ui/shared';
import { del, patch, post } from '../api/client.ts';
import { useAccounts, useAction, useConfig, useInstitutions, useTransactions } from '../api/hooks.ts';
import { CreditUsage, InvestmentLine } from '../components/AccountExtras.tsx';
import { CardModal } from '../components/CardModal.tsx';
import { CardTile } from '../components/CardTile.tsx';
import { CustomFieldInputs, FieldValue, useCustomFields, useCustomFieldTabs } from '../components/CustomFields.tsx';
import { MoneyInput, MoneyText } from '../components/Money.tsx';
import { TransactionModal } from '../components/TransactionModal.tsx';
import { TxRow } from '../components/TxRow.tsx';
import { PageTop } from '../layouts/PanelLayout.tsx';
import { colorFor, initials, useCountry, useLookups, visibleBalances } from '../lib/format.ts';
import { orderCards } from './CardsPage.tsx';

// ---------------------------------------------------------------- modals

function InstitutionModal({ open, editing, onClose }: { open: boolean; editing: InstitutionDto | null; onClose: () => void }) {
  const { t } = useTranslation();
  const { data: cfg } = useConfig();
  const [form] = Form.useForm();
  useEffect(() => {
    if (open) {
      form.resetFields();
      form.setFieldsValue(editing ?? { type: 'bank', country: cfg?.app.defaultCountry ?? cfg?.countries[0]?.code, extra: {} });
    }
  }, [open, editing, form, cfg]);
  const save = useAction(async (v: Record<string, unknown>) => {
    const color = typeof v.color === 'string' ? v.color : (v.color as { toHexString?: () => string } | undefined)?.toHexString?.();
    const body = { ...v, color: color ?? null };
    if (editing) await patch(`/institutions/${editing.id}`, body);
    else await post('/institutions', body);
    onClose();
  });
  return (
    <Modal open={open} title={editing ? t('institution.edit') : t('institution.add')} onCancel={onClose} onOk={() => form.submit()} confirmLoading={save.isPending} destroyOnHidden>
      <Form form={form} layout="vertical" requiredMark={false} onFinish={(v) => save.mutate(v)} style={{ marginTop: 12 }}>
        <Form.Item name="name" label={t('common.name')} rules={[{ required: true, max: 64 }]}>
          <Input autoFocus placeholder="Chase / HSBC HK / Wise" />
        </Form.Item>
        <Row gutter={12}>
          <Col span={12}>
            <Form.Item name="country" label={t('common.country')} rules={[{ required: true }]}>
              <Select showSearch={{ optionFilterProp: 'label' }} options={cfg?.countries.map((c) => ({ value: c.code, label: `${c.flag ?? ''} ${c.name}` }))} />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="type" label={t('common.type')} rules={[{ required: true }]}>
              <Select options={INSTITUTION_TYPES.map((k) => ({ value: k, label: t(`institution.types.${k}`) }))} />
            </Form.Item>
          </Col>
        </Row>
        <Row gutter={12}>
          <Col span={8}>
            <Form.Item name="color" label={t('common.color')}>
              <ColorPicker disabledAlpha presets={[{ label: '', colors: ['#c8102e', '#db0011', '#1677ff', '#003a70', '#00a651', '#722ed1', '#fa8c16', '#13c2c2'] }]} />
            </Form.Item>
          </Col>
          <Col span={16}>
            <Form.Item name="website" label={t('institution.website')}>
              <Input placeholder="https://" />
            </Form.Item>
          </Col>
        </Row>
        <Form.Item name="note" label={t('common.note')}>
          <Input.TextArea autoSize={{ minRows: 1, maxRows: 4 }} />
        </Form.Item>
        <CustomFieldInputs entity="institution" />
      </Form>
    </Modal>
  );
}

interface CurrencyRow {
  currency: string;
  openingBalance: number;
  /** End of this day = the balance above; null = every transaction counts. */
  balanceDate?: Dayjs | null;
  includeInTotal: boolean;
}

interface AccountForm extends Omit<Partial<AccountDto>, 'openingDate' | 'currencies'> {
  openingDate?: Dayjs;
  currencies?: CurrencyRow[];
}

/** One row per currency held: currency, opening balance, "count in totals". The first row is primary. */
function CurrencyRows({ editing }: { editing: AccountDto | null }) {
  const { t } = useTranslation();
  const { data: cfg } = useConfig();
  const form = Form.useFormInstance<AccountForm>();
  const rows = (Form.useWatch('currencies', form) ?? []) as CurrencyRow[];
  const used = (cur: string) => (editing?.currencies.find((c) => c.currency === cur)?.transactionCount ?? 0) > 0;
  return (
    <Form.List name="currencies">
      {(fields, { add, remove, move }) => (
        <div className="currency-rows">
          {fields.map(({ key, name }, i) => {
            const cur = rows[i]?.currency;
            return (
              <div key={key} className="currency-row">
                <Tooltip title={i === 0 ? t('account.primary') : t('account.setPrimary')}>
                  <Button type="text" size="small" icon={i === 0 ? <StarFilled style={{ color: '#faad14' }} /> : <StarOutlined />} onClick={() => i > 0 && move(i, 0)} />
                </Tooltip>
                <Form.Item name={[name, 'currency']} rules={[{ required: true }]} style={{ marginBottom: 0, width: 110 }}>
                  <Select
                    showSearch={{ optionFilterProp: 'label' }}
                    disabled={!!cur && used(cur)}
                    options={cfg?.currencies.map((c) => ({ value: c.code, label: c.code, disabled: rows.some((r, j) => j !== i && r?.currency === c.code) }))}
                  />
                </Form.Item>
                <Form.Item name={[name, 'openingBalance']} style={{ marginBottom: 0, flex: 1, minWidth: 110 }}>
                  <MoneyInput currency={cur ?? '—'} allowNegative />
                </Form.Item>
                <Tooltip title={t('account.balanceDateHint')}>
                  <Form.Item name={[name, 'balanceDate']} style={{ marginBottom: 0, width: 132 }}>
                    <DatePicker placeholder={t('account.allTransactions')} aria-label={t('account.balanceDate')} style={{ width: '100%' }} />
                  </Form.Item>
                </Tooltip>
                <Tooltip title={t('account.includeInTotal')}>
                  <Form.Item name={[name, 'includeInTotal']} valuePropName="checked" style={{ marginBottom: 0 }}>
                    <Switch size="small" checkedChildren="Σ" unCheckedChildren="Σ" />
                  </Form.Item>
                </Tooltip>
                <Tooltip title={cur && used(cur) ? t('account.currencyInUse') : undefined}>
                  <Button type="text" size="small" danger icon={<MinusCircleOutlined />} disabled={fields.length === 1 || (!!cur && used(cur))} onClick={() => remove(name)} />
                </Tooltip>
              </div>
            );
          })}
          <Button type="dashed" size="small" icon={<PlusOutlined />} onClick={() => add({ currency: undefined, openingBalance: 0, balanceDate: dayjs(), includeInTotal: true })}>
            {t('account.addCurrency')}
          </Button>
        </div>
      )}
    </Form.List>
  );
}

function AccountModal({ open, editing, institutionId, onClose }: { open: boolean; editing: AccountDto | null; institutionId?: string; onClose: () => void }) {
  const { t } = useTranslation();
  const { data: cfg } = useConfig();
  const { data: institutions = [] } = useInstitutions();
  const [form] = Form.useForm<AccountForm>();
  const type = Form.useWatch('type', form);
  const currencies = (Form.useWatch('currencies', form) ?? []) as CurrencyRow[];
  const primary = currencies[0]?.currency ?? cfg?.app.defaultCurrency ?? 'USD';
  useEffect(() => {
    if (open) {
      form.resetFields();
      form.setFieldsValue(
        editing
          ? {
              ...editing,
              openingDate: dayjs(editing.openingDate),
              currencies: editing.currencies.map(({ currency, openingBalance, balanceDate, includeInTotal }) => ({
                currency,
                openingBalance,
                balanceDate: balanceDate ? dayjs(balanceDate) : null,
                includeInTotal,
              })),
            }
          : {
              institutionId,
              type: 'checking',
              currencies: [{ currency: cfg?.app.defaultCurrency ?? 'USD', openingBalance: 0, balanceDate: dayjs(), includeInTotal: true }],
              openingDate: dayjs(),
              extra: {},
            },
      );
    }
  }, [open, editing, institutionId, form, cfg]);
  const save = useAction(async (v: AccountForm) => {
    const body = {
      ...v,
      openingDate: (v.openingDate ?? dayjs()).format('YYYY-MM-DD'),
      currencies: v.currencies?.map((c) => ({ ...c, balanceDate: c.balanceDate ? c.balanceDate.format('YYYY-MM-DD') : null })),
      creditLimit: v.type === 'credit' ? (v.creditLimit ?? null) : null,
      numberLast4: v.numberLast4 || null,
    };
    if (editing) await patch(`/accounts/${editing.id}`, body);
    else await post('/accounts', body);
    onClose();
  });
  return (
    <Modal open={open} title={editing ? t('account.edit') : t('account.add')} onCancel={onClose} onOk={() => form.submit()} confirmLoading={save.isPending} destroyOnHidden width={560}>
      <Form form={form} layout="vertical" requiredMark={false} onFinish={(v) => save.mutate(v)} style={{ marginTop: 12 }}>
        <Row gutter={12}>
          <Col span={12}>
            <Form.Item name="institutionId" label={t('account.institution')} rules={[{ required: true }]}>
              <Select options={institutions.filter((i) => !i.archived).map((i) => ({ value: i.id, label: i.name }))} />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="type" label={t('common.type')} rules={[{ required: true }]}>
              <Select options={ACCOUNT_TYPES.map((k) => ({ value: k, label: t(`account.types.${k}`) }))} />
            </Form.Item>
          </Col>
        </Row>
        <Form.Item name="name" label={t('common.name')} rules={[{ required: true, max: 64 }]}>
          <Input autoFocus placeholder="Checking / One account / Multi-currency" />
        </Form.Item>
        <Form.Item label={t('account.currencies')} extra={t('account.openingBalanceHint')} required>
          <CurrencyRows editing={editing} />
        </Form.Item>
        {/* Kept for the record only; each currency's balance date decides what counts. */}
        <Form.Item name="openingDate" hidden>
          <DatePicker />
        </Form.Item>
        <Row gutter={12}>
          {type === 'credit' && (
            <Col span={12}>
              <Form.Item name="creditLimit" label={t('account.creditLimit')}>
                <MoneyInput currency={primary} />
              </Form.Item>
            </Col>
          )}
          <Col span={12}>
            <Form.Item name="numberLast4" label={t('account.numberLast4')} rules={[{ pattern: /^\d{4}$/ }]}>
              <Input maxLength={4} inputMode="numeric" />
            </Form.Item>
          </Col>
        </Row>
        <Form.Item name="note" label={t('common.note')}>
          <Input.TextArea autoSize={{ minRows: 1, maxRows: 4 }} />
        </Form.Item>
        <CustomFieldInputs entity="account" />
      </Form>
    </Modal>
  );
}

// ---------------------------------------------------------------- balances

/** Non-zero balances, one per line; excluded-from-totals balances are marked. */
export function Balances({ account, size = 'md' }: { account: AccountDto; size?: 'md' | 'lg' }) {
  const { t } = useTranslation();
  return (
    <div className={`balances balances-${size}`}>
      {visibleBalances(account).map((c) => (
        <div key={c.currency} className={c.includeInTotal ? '' : 'excluded'} title={c.includeInTotal ? undefined : t('account.excluded')}>
          <MoneyText minor={c.balance} currency={c.currency} colored={c.balance < 0} animated />
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- account drawer

function AccountTransactions({ account, onEdit }: { account: AccountDto; onEdit: (tx: TransactionDto) => void }) {
  const [page, setPage] = useState(1);
  // The account's own ledger lists everything (stock cash legs, hidden spending) so the balance adds up.
  const { t } = useTranslation();
  const accountId = account.id;
  const { data, isLoading } = useTransactions({ accountId, page, pageSize: 15, hidden: '1', trades: '1' });
  // On or before the currency's balance date: already in the synced balance, not counted again.
  const counted = (tx: TransactionDto) => {
    const d = account.currencies.find((c) => c.currency === tx.currency)?.balanceDate;
    return !d || tx.occurredAt > d;
  };
  if (isLoading) return <Skeleton active />;
  if (!data?.items.length) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  return (
    <>
      {data.items.map((tx) =>
        counted(tx) ? (
          <TxRow key={tx.id} tx={tx} onClick={() => onEdit(tx)} />
        ) : (
          <Tooltip key={tx.id} title={t('account.beforeBalanceDate')} placement="left">
            <div className="tx-not-counted">
              <TxRow tx={tx} onClick={() => onEdit(tx)} />
            </div>
          </Tooltip>
        ),
      )}
      {data.total > 15 && <Pagination size="small" style={{ marginTop: 12, textAlign: 'center' }} current={page} total={data.total} pageSize={15} onChange={setPage} showSizeChanger={false} />}
    </>
  );
}

function AccountDrawer({ account, onClose, onEdit }: { account: AccountDto | null; onClose: () => void; onEdit: (a: AccountDto) => void }) {
  const { t } = useTranslation();
  const { modal } = App.useApp();
  const L = useLookups();
  const navigate = useNavigate();
  const location = useLocation();
  const [tx, setTx] = useState<{ open: boolean; editing: TransactionDto | null }>({ open: false, editing: null });
  const [cardModal, setCardModal] = useState(false);
  const [tab, setTab] = useState('tx');
  const cfTabs = useCustomFieldTabs('account', account?.extra);
  const archive = useAction((a: AccountDto) => patch(`/accounts/${a.id}`, { archived: !a.archived }));
  const remove = useAction((a: AccountDto) => del(`/accounts/${a.id}`), { success: t('common.deleted') });
  useEffect(() => setTab('tx'), [account?.id]);
  if (!account) return <Drawer open={false} />;
  const inst = L.inst.get(account.institutionId);
  const cards = orderCards(L.cards.filter((c) => c.accountId === account.id));
  return (
    <Drawer
      open={!!account}
      onClose={onClose}
      size={560}
      title={
        <span>
          {inst?.name} · {account.name} {account.archived && <Tag>{t('common.archived')}</Tag>}
        </span>
      }
      extra={
        <Space>
          <Button icon={<EditOutlined />} onClick={() => onEdit(account)}>
            {t('common.edit')}
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setTx({ open: true, editing: null })}>
            {t('tx.add')}
          </Button>
          <Dropdown
            menu={{
              items: [
                { key: 'archive', icon: <InboxOutlined />, label: account.archived ? t('common.unarchive') : t('common.archive'), onClick: () => archive.mutate(account) },
                {
                  key: 'delete',
                  icon: <DeleteOutlined />,
                  danger: true,
                  label: t('common.delete'),
                  disabled: account.transactionCount > 0 || account.cardCount > 0,
                  onClick: () =>
                    modal.confirm({ title: t('common.deleteConfirm'), okButtonProps: { danger: true }, onOk: () => remove.mutateAsync(account).then(onClose) }),
                },
              ],
            }}
          >
            <Button icon={<MoreOutlined />} />
          </Dropdown>
        </Space>
      }
    >
      <div style={{ marginBottom: 16 }}>
        <div className="muted" style={{ fontSize: 12 }}>
          {t('account.balance')} {account.currencies.length > 1 && <Tag style={{ marginLeft: 4 }}>{t('account.multiCurrency')}</Tag>}
        </div>
        <Balances account={account} size="lg" />
        {account.investment && (
          <div>
            <InvestmentLine account={account} />{' '}
            <Link to="/invest" style={{ fontSize: 12 }}>
              {t('nav.invest')}
            </Link>
          </div>
        )}
        {account.creditUsage ? (
          <div style={{ maxWidth: 360, marginTop: 6 }}>
            <CreditUsage usage={account.creditUsage} currency={account.currency} />
          </div>
        ) : (
          account.creditLimit !== null && (
            <div className="muted" style={{ fontSize: 12 }}>
              {t('account.creditLimit')} <MoneyText minor={account.creditLimit} currency={account.currency} />
            </div>
          )
        )}
      </div>
      <Tabs
        activeKey={tab}
        onChange={setTab}
        items={[
          {
            key: 'tx',
            label: t('nav.transactions'),
            children: <AccountTransactions account={account} onEdit={(e) => setTx({ open: true, editing: e })} />,
          },
          {
            key: 'cards',
            label: `${t('nav.cards')} (${cards.length})`,
            children: (
              <>
                {cards.map(({ card, indent }) => (
                  <CardTile
                    key={card.id}
                    card={card}
                    indent={indent}
                    onClick={() => navigate(`/cards?card=${card.id}`, { state: { from: `${location.pathname}${location.search}` } })}
                  />
                ))}
                <Button type="dashed" block icon={<PlusOutlined />} style={{ marginTop: 8 }} onClick={() => setCardModal(true)}>
                  {t('card.addToAccount')}
                </Button>
              </>
            ),
          },
          {
            key: 'info',
            label: t('common.details'),
            children: (
              <Descriptions
                column={1}
                size="small"
                items={[
                  { key: 'type', label: t('common.type'), children: t(`account.types.${account.type}`) },
                  {
                    key: 'cur',
                    label: t('account.currencies'),
                    children: (
                      <Space wrap size={4}>
                        {account.currencies.map((c, i) => (
                          <Tag key={c.currency} color={i === 0 ? 'gold' : undefined}>
                            {c.currency}
                            {!c.includeInTotal && ` · ${t('account.excluded')}`}
                          </Tag>
                        ))}
                      </Space>
                    ),
                  },
                  {
                    key: 'ob',
                    label: t('account.openingBalance'),
                    children: (
                      <Space orientation="vertical" size={0}>
                        {account.currencies.map((c) => (
                          <MoneyText key={c.currency} minor={c.openingBalance} currency={c.currency} />
                        ))}
                      </Space>
                    ),
                  },
                  {
                    key: 'bd',
                    label: t('account.balanceDate'),
                    children: (
                      <Space orientation="vertical" size={0}>
                        {account.currencies.map((c) => (
                          <span key={c.currency}>
                            {c.currency} · {c.balanceDate ?? <span className="muted">{t('account.allTransactions')}</span>}
                          </span>
                        ))}
                      </Space>
                    ),
                  },
                  { key: 'no', label: t('account.numberLast4'), children: account.numberLast4 ? `•••• ${account.numberLast4}` : '—' },
                  { key: 'n', label: t('common.note'), children: account.note || '—' },
                ]}
              />
            ),
          },
          ...cfTabs,
        ]}
      />
      <TransactionModal open={tx.open} editing={tx.editing} defaults={{ accountId: account.id }} onClose={() => setTx({ open: false, editing: null })} />
      <CardModal open={cardModal} editing={null} defaultAccountId={account.id} onClose={() => setCardModal(false)} />
    </Drawer>
  );
}

// ---------------------------------------------------------------- page

export function AccountsPage() {
  const { t } = useTranslation();
  const { modal } = App.useApp();
  const { data: cfg } = useConfig();
  const { data: institutions, isLoading } = useInstitutions();
  const { data: accounts = [] } = useAccounts();
  const country = useCountry();
  const accountFields = useCustomFields('account').filter((f) => f.showInTable);
  const [params, setParams] = useSearchParams();
  const [showArchived, setShowArchived] = useState(false);
  const [instModal, setInstModal] = useState<{ open: boolean; editing: InstitutionDto | null }>({ open: false, editing: null });
  const [accModal, setAccModal] = useState<{ open: boolean; editing: AccountDto | null; institutionId?: string }>({ open: false, editing: null });

  const archiveInst = useAction((i: InstitutionDto) => patch(`/institutions/${i.id}`, { archived: !i.archived }));
  const deleteInst = useAction((i: InstitutionDto) => del(`/institutions/${i.id}`), { success: t('common.deleted') });

  const openAccount = accounts.find((a) => a.id === params.get('account')) ?? null;

  const groups = useMemo(() => {
    const list = (institutions ?? []).filter((i) => showArchived || !i.archived);
    const order = new Map(cfg?.countries.map((c, i) => [c.code, i]));
    const byCountry = new Map<string, InstitutionDto[]>();
    for (const i of list) byCountry.set(i.country, [...(byCountry.get(i.country) ?? []), i]);
    return [...byCountry].sort((a, b) => (order.get(a[0]) ?? 99) - (order.get(b[0]) ?? 99));
  }, [institutions, showArchived, cfg]);

  return (
    <>
      <PageTop
        title={t('nav.accounts')}
        extra={
          <>
            <Space size={6} className="muted" style={{ fontSize: 13 }}>
              <Switch size="small" checked={showArchived} onChange={setShowArchived} />
              {t('common.archived')}
            </Space>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setInstModal({ open: true, editing: null })}>
              {t('institution.add')}
            </Button>
          </>
        }
      />
      {isLoading && <Skeleton active />}
      {!isLoading && groups.length === 0 && (
        <Card>
          <Empty description={t('dashboard.getStartedDesc')}>
            <Button type="primary" onClick={() => setInstModal({ open: true, editing: null })}>
              {t('institution.add')}
            </Button>
          </Empty>
        </Card>
      )}
      {groups.map(([code, list]) => {
        const c = country(code);
        return (
          <section key={code} style={{ marginBottom: 24 }}>
            <Typography.Title level={5} style={{ margin: '0 0 12px' }}>
              {c.flag} {c.name}
            </Typography.Title>
            <Row gutter={[16, 16]}>
              <AnimatePresence initial={false}>
                {list.map((inst) => {
                  const accs = accounts.filter((a) => a.institutionId === inst.id && (showArchived || !a.archived));
                  return (
                    <Col key={inst.id} xs={24} md={12} xl={8}>
                      <motion.div layout initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.97 }}>
                        <Card
                          hoverable
                          style={{ opacity: inst.archived ? 0.6 : 1 }}
                          title={
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
                              <span className="avatar-icon" style={{ background: inst.color ?? colorFor(inst.name), width: 30, height: 30, flexBasis: 30, fontSize: 13 }}>
                                {initials(inst.name)}
                              </span>
                              <span>
                                {inst.name}
                                <div className="muted" style={{ fontSize: 11, fontWeight: 400 }}>
                                  {t(`institution.types.${inst.type}`)}
                                </div>
                              </span>
                            </span>
                          }
                          extra={
                            <Space size={0}>
                              <Tooltip title={t('institution.edit')}>
                                <Button type="text" icon={<EditOutlined />} onClick={() => setInstModal({ open: true, editing: inst })} />
                              </Tooltip>
                              <Dropdown
                                menu={{
                                  items: [
                                    { key: 'add', icon: <PlusOutlined />, label: t('account.add'), onClick: () => setAccModal({ open: true, editing: null, institutionId: inst.id }) },
                                    { key: 'archive', icon: <InboxOutlined />, label: inst.archived ? t('common.unarchive') : t('common.archive'), onClick: () => archiveInst.mutate(inst) },
                                    {
                                      key: 'delete',
                                      icon: <DeleteOutlined />,
                                      danger: true,
                                      disabled: inst.accountCount > 0,
                                      label: t('common.delete'),
                                      onClick: () =>
                                        modal.confirm({ title: t('common.deleteConfirm'), okButtonProps: { danger: true }, onOk: () => deleteInst.mutateAsync(inst) }),
                                    },
                                  ],
                                }}
                              >
                                <Button type="text" icon={<MoreOutlined />} />
                              </Dropdown>
                            </Space>
                          }
                          styles={{ body: { paddingTop: 6, paddingBottom: 10 } }}
                        >
                          {accs.map((a) => (
                            <div key={a.id} className="row-item clickable account-row" style={{ opacity: a.archived ? 0.55 : 1 }} onClick={() => setParams({ account: a.id })}>
                              <div className="row-main">
                                <div className="row-title">
                                  {a.name} {a.numberLast4 && <span className="muted" style={{ fontWeight: 400 }}>•••• {a.numberLast4}</span>}
                                </div>
                                <div className="row-sub">
                                  {t(`account.types.${a.type}`)}
                                  {a.cardCount > 0 && ` · ${t('account.cardsN', { n: a.cardCount })}`}
                                  {accountFields
                                    .filter((f) => a.extra[f.key] !== undefined && a.extra[f.key] !== null && a.extra[f.key] !== '')
                                    .map((f) => (
                                      <span key={f.key} style={{ marginLeft: 6 }}>
                                        <FieldValue field={f} value={a.extra[f.key]} />
                                      </span>
                                    ))}
                                </div>
                                {/* Own line, so it never covers the name or type text. */}
                                {a.creditUsage && (
                                  <div className="row-extra">
                                    <CreditUsage usage={a.creditUsage} currency={a.currency} compact />
                                  </div>
                                )}
                                {a.investment && (
                                  <div className="row-extra">
                                    <InvestmentLine account={a} />
                                  </div>
                                )}
                              </div>
                              <Tooltip title={t('account.edit')}>
                                <Button
                                  className="row-edit"
                                  type="text"
                                  size="small"
                                  icon={<EditOutlined />}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setAccModal({ open: true, editing: a });
                                  }}
                                />
                              </Tooltip>
                              <Balances account={a} />
                            </div>
                          ))}
                          <Button type="dashed" block icon={<PlusOutlined />} style={{ marginTop: 10 }} onClick={() => setAccModal({ open: true, editing: null, institutionId: inst.id })}>
                            {t('account.add')}
                          </Button>
                        </Card>
                      </motion.div>
                    </Col>
                  );
                })}
              </AnimatePresence>
            </Row>
          </section>
        );
      })}

      <InstitutionModal open={instModal.open} editing={instModal.editing} onClose={() => setInstModal({ open: false, editing: null })} />
      <AccountModal open={accModal.open} editing={accModal.editing} institutionId={accModal.institutionId} onClose={() => setAccModal({ open: false, editing: null })} />
      <AccountDrawer account={openAccount} onClose={() => setParams({})} onEdit={(a) => setAccModal({ open: true, editing: a })} />
    </>
  );
}
