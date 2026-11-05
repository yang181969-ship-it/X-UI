import { ArrowLeftOutlined } from '@ant-design/icons';
import { useQueryClient } from '@tanstack/react-query';
import { Alert, App, Button, Card, Checkbox, Col, ConfigProvider, DatePicker, Form, Input, Radio, Row, Segmented, Select, Typography } from 'antd';
import {
  latestOccurredOn,
  localDate,
  NAME_MAX,
  NOTES_MAX,
  REASON_MAX,
  TRANSFER_METHODS,
  TXN_TYPES,
  transactionHints,
  type EntryDirection,
  type FactCorrection,
  type TransactionCreate,
  type TransactionDto,
  type TransactionWriteResult,
  type TxnType,
} from '@xui/ledger-shared';
import dayjs from 'dayjs';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Skeleton } from 'antd';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useAccounts, useRefreshAccounts } from '../api/accounts.ts';
import { useSpendingSource } from '../api/cardLinks.ts';
import { useCard, useCards } from '../api/cards.ts';
import { useChannels } from '../api/channels.ts';
import { ApiError } from '../api/client.ts';
import { errorText, useMe } from '../api/hooks.ts';
import { useProfileSettings } from '../api/settings.ts';
import { correctTransaction, createTransaction, TRANSACTIONS, transactionHref, useTransaction } from '../api/transactions.ts';
import { PendingWriteBanner } from '../components/PendingWriteBanner.tsx';
import { AmountInput } from '../components/AmountInput.tsx';
import { PageTop } from '../layouts/PanelLayout.tsx';
import { currencyOptions } from '../lib/currencies.ts';
import { parseAmountInput } from '../lib/money.ts';
import { applyEntryPrefill, spendingSourcePrefill, type EntryPrefill } from '../lib/prefill.ts';
import { regionName, regionOptions } from '../lib/regions.ts';
import {
  buildCreateRequest,
  buildFactCorrectionRequest,
  draftDirections,
  draftFromBody,
  draftFromFactBody,
  draftFromVersion,
  emptyDraft,
  eventAmountMayBeUnknown,
  hasCounterparty,
  isMerchant,
  issuesFromServer,
  UNKNOWN_REGION,
  type CurrencyStatusLookup,
  type DraftIssue,
  type EntryDraft,
  type TxnDraft,
} from '../lib/txnDraft.ts';
import { usePendingWrite } from '../lib/usePendingWrite.ts';
import type { PrepareResult, RunResult } from '../lib/pendingWrite.ts';
import { SpendingSourceExplain } from './links/SpendingSourcePreview.tsx';
import { EntryEditor } from './transactions/form/EntryEditor.tsx';
import { ConflictPanel } from './transactions/lifecycle/useLifecycleWrite.tsx';
import { issueMap, useFieldStatus, useIssueText } from './transactions/form/issues.ts';

const DATE = 'YYYY-MM-DD';
type Touched = Record<EntryDirection, Set<keyof EntryPrefill>>;
type FormError = { code: string; message?: string; transactionId?: string };

/**
 * /transactions/new?type=… — create one of the four approved transaction types (PRODUCT_SPEC §7.2,
 * API_SPEC §5.4; M3-B4-C). The request is built only with the shared schema and rules
 * (lib/txnDraft.ts); the classification is the server's (CONFIRMED_DOMESTIC is its answer,
 * undetermined is saved). Recommendations (spending source) fill untouched fields only; hints
 * (transactionHints) are shown and never change anything.
 *
 * Idempotency (lib/usePendingWrite.ts): the key is made on the first real submit; a retry of the
 * same parsed request reuses the key and body; an unknown outcome (no answer, timeout, 5xx) is
 * retried automatically (1 s, 3 s) and then locks the form until the user retries the original
 * request or — after a warning to check the list first — abandons it. A reload restores it.
 */
export function TransactionFormPage() {
  return <TransactionEditor />;
}

/**
 * /transactions/:id/correct — fact correction (API_SPEC §5.7, kind fact_correction; M3-B4-D) with
 * the same editor as create: the saved type cannot change, recordMode is always sent, a reason is
 * required, the home-region snapshot is carried (only a snapshot correction changes it), notes are
 * not part of it. baseRevision is fixed when the page opens. A voided transaction has no correction.
 */
export function FactCorrectionPage() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const { data, isLoading, isError } = useTransaction(id);
  const txn = data?.id === id ? data : undefined;
  if (isLoading) return <Skeleton active />;
  if (isError || !txn) return <Alert type="error" showIcon className="form-alert" title={t('transactions.detail.notFound')} />;
  if (txn.status !== 'active') {
    return (
      <>
        <PageTop title={t('transactions.lifecycle.factTitle', { n: txn.currentRevision })} />
        <Alert type="info" showIcon className="form-alert txn-voided-no-correction" title={t('transactions.lifecycle.voidedNoChange')} action={<Link to={transactionHref(txn.id)}>{t('transactions.lifecycle.backToDetail')}</Link>} />
      </>
    );
  }
  return <TransactionEditor key={txn.id} correction={txn} />;
}

function TransactionEditor({ correction }: { correction?: TransactionDto }) {
  const { t, i18n } = useTranslation();
  const { message } = App.useApp();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const refreshAccounts = useRefreshAccounts();
  const [params, setParams] = useSearchParams();
  const initialType = (TXN_TYPES as readonly string[]).includes(params.get('type') ?? '') ? (params.get('type') as TxnType) : 'merchant_spend';
  const [draft, setDraft] = useState<TxnDraft>(() => (correction ? draftFromVersion(correction.txnType, correction.event, correction.entries) : emptyDraft(initialType, localDate())));
  // A correction starts from saved facts: they count as the user's own (no recommendation replaces them).
  const touched = useRef<Touched>(correction ? { out: new Set(['accountId', 'currency', 'amountText']), in: new Set(['accountId', 'currency', 'amountText']) } : { out: new Set(), in: new Set() });
  // Fact correction: the version it is based on (fixed at open; changed only by an explicit rebase), its entries (for lawful carry-overs) and the reason.
  const [baseRevision, setBaseRevision] = useState(correction?.currentRevision ?? 0);
  const [baseEntries, setBaseEntries] = useState(correction?.entries ?? []);
  const [reason, setReason] = useState('');
  const [conflict, setConflict] = useState<number | null>(null);
  const [issues, setIssues] = useState<DraftIssue[]>([]);
  // Field problems from the server's last (definitive) answer; cleared when the draft changes.
  const [serverIssues, setServerIssues] = useState<DraftIssue[]>([]);
  const [checked, setChecked] = useState(false);
  const [formError, setFormError] = useState<FormError | null>(null);

  const { data: me } = useMe();
  const userId = me?.user.id;
  const correctionId = correction?.id;
  const send = useMemo(() => (correctionId ? correctTransaction(correctionId) : createTransaction), [correctionId]);
  const writer = usePendingWrite<TransactionWriteResult>({ userId, operation: correctionId ? 'transaction.correct' : 'transaction.create', transactionId: correctionId ?? null, send });
  const { pending, locked } = writer;

  const { data: accounts = [] } = useAccounts({ status: 'all' });
  const { data: cards = [] } = useCards({ status: 'all' });
  const { data: channels = [] } = useChannels({ status: 'all' });
  const { data: settings } = useProfileSettings();
  const merchant = isMerchant(draft.type);
  const { data: cardData } = useCard(merchant && draft.cardId ? draft.cardId : undefined);
  const card = cardData && cardData.id === draft.cardId ? cardData : undefined;
  const channel = channels.find((c) => c.id === draft.paymentChannelId);
  const dirs = draftDirections(draft);

  const currencyStatus: CurrencyStatusLookup = useCallback(
    (accountId, currency) => {
      const a = accounts.find((x) => x.id === accountId);
      if (!a) return undefined;
      return a.currencies.find((c) => c.currency === currency)?.status ?? null;
    },
    [accounts],
  );
  const carried = useCallback((accountId: string, currency: string) => baseEntries.some((e) => e.accountId === accountId && e.currency === currency), [baseEntries]);
  const build = useCallback(
    (d: TxnDraft) =>
      correction ? buildFactCorrectionRequest(d, { now: Date.now(), currencyStatus, carried, baseRevision, reason }) : buildCreateRequest(d, { now: Date.now(), currencyStatus }),
    [correction, currencyStatus, carried, baseRevision, reason],
  );

  // A restored unknown-outcome request is shown exactly as it will be resent.
  // Its fields count as the user's own: a recommendation never replaces them, even after abandoning.
  useEffect(() => {
    if (!writer.restored || !pending) return;
    if (correction) {
      const body = pending.body as FactCorrection;
      if (body.kind !== 'fact_correction') return; // another correction of this transaction is unconfirmed: the banner handles it
      setDraft(draftFromFactBody(body, correction.txnType));
      setReason(body.reason);
      setBaseRevision(body.baseRevision);
    } else setDraft(draftFromBody(pending.body as TransactionCreate));
    touched.current = { out: new Set(['accountId', 'currency', 'amountText']), in: new Set(['accountId', 'currency', 'amountText']) };
  }, [writer.restored, pending]);

  useEffect(() => setServerIssues([]), [draft, reason]);

  // Live issues once the user has tried to submit.
  useEffect(() => {
    if (!checked || locked) return;
    const r = build(draft);
    setIssues(r.ok ? [] : r.issues);
  }, [draft, checked, locked, build]);

  // ---------------------------------------------------------------- spending-source recommendation (merchant spend)
  const recommend = draft.type === 'merchant_spend' && !!draft.cardId && !!draft.eventCurrency;
  const { data: recData, isFetching: recLoading } = useSpendingSource(recommend ? (draft.cardId ?? undefined) : undefined, recommend ? (draft.eventCurrency ?? undefined) : undefined);
  const rec = recommend && recData && recData.eventCurrency === draft.eventCurrency ? recData : undefined;
  const eventParsed = parseAmountInput(draft.eventAmountText, draft.eventCurrency);
  const eventMinor = eventParsed.ok ? eventParsed.minor : null;
  useEffect(() => {
    if (!rec || locked || draft.recordMode !== 'current' || draft.type !== 'merchant_spend') return;
    const patch = spendingSourcePrefill(rec, { recordMode: 'current', eventAmount: eventMinor });
    setDraft((d) => applyPrefill(d, 'out', touched.current.out, patch));
  }, [rec, eventMinor, draft.recordMode, draft.type, locked]);

  /** Backfill: the user applies the recommendation explicitly (it then counts as their own choice). */
  const applyRecommendation = () => {
    if (!rec) return;
    const patch = spendingSourcePrefill(rec, { recordMode: 'current', eventAmount: eventMinor });
    setDraft((d) => applyPrefill(d, 'out', new Set(), patch));
    for (const k of Object.keys(patch) as (keyof EntryPrefill)[]) touched.current.out.add(k);
  };

  // ---------------------------------------------------------------- hints (shared, non-blocking)
  const hints = useMemo(
    () =>
      transactionHints({
        occurredOn: draft.occurredOn,
        recordMode: draft.recordMode,
        today: localDate(),
        entries: dirs.map((dir) => ({ direction: dir, account: accounts.find((a) => a.id === draft.entries[dir].accountId) ?? null, currency: draft.entries[dir].currency })),
        card: merchant && card ? card : null,
        channel: merchant && channel ? channel : null,
      }),
    [draft, dirs, accounts, card, channel, merchant],
  );

  // ---------------------------------------------------------------- submit
  const set = (patch: Partial<TxnDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const setEntry = (dir: EntryDirection) => (patch: Partial<EntryDraft>, keys: (keyof EntryPrefill)[]) => {
    for (const k of keys) touched.current[dir].add(k);
    setDraft((d) => ({ ...d, entries: { ...d.entries, [dir]: { ...d.entries[dir], ...patch } } }));
  };

  const handle = async (r: RunResult<TransactionWriteResult> | Extract<PrepareResult, { ok: false }> | null, body: { entries: readonly { direction: EntryDirection }[] }) => {
    if (!r) return;
    if ('reason' in r) {
      setFormError({ code: r.reason });
      return;
    }
    if (r.outcome.kind === 'success' && r.data) {
      await qc.invalidateQueries({ queryKey: [TRANSACTIONS] });
      void message.success(r.outcome.replayed ? t('transactions.form.savedReplayed') : t(correction ? 'transactions.lifecycle.corrected' : 'transactions.form.saved'));
      navigate(transactionHref(r.data.transactionId), { replace: true });
      return;
    }
    if (r.outcome.kind === 'unknown' || r.outcome.kind === 'aborted') return; // the banner explains and the form stays locked — or the write was abandoned
    const e = r.error;
    if (e instanceof ApiError && e.code === 'IDEMPOTENCY_CONFLICT') {
      setFormError({ code: 'IDEMPOTENCY_CONFLICT', transactionId: (e.details as { transactionId?: string } | undefined)?.transactionId });
      return;
    }
    if (correction && e instanceof ApiError && e.code === 'REVISION_CONFLICT') {
      // Keep the draft; read the latest version; the user decides (ConflictPanel).
      await qc.invalidateQueries({ queryKey: [TRANSACTIONS, 'detail', correction.id] });
      setConflict((e.details as { currentRevision?: number } | undefined)?.currentRevision ?? correction.currentRevision);
      return;
    }
    if (correction && e instanceof ApiError && e.code === 'TRANSACTION_VOIDED') {
      await qc.invalidateQueries({ queryKey: [TRANSACTIONS] });
      void message.warning(t('errors.codes.TRANSACTION_VOIDED'));
      navigate(transactionHref(correction.id), { replace: true });
      return;
    }
    if (e instanceof ApiError && e.code === 'NOT_FOUND') void refreshAccounts();
    const fromServer = e instanceof ApiError ? issuesFromServer(e, body, !!correction) : null;
    if (fromServer) {
      setServerIssues(fromServer);
      setFormError({ code: fromServer.some((i) => i.code === 'confirmedDomestic') ? 'CONFIRMED_DOMESTIC' : fromServer.some((i) => i.code === 'noChange') ? 'noChange' : 'fields' });
      return;
    }
    setFormError({ code: 'other', message: errorText(e, t) });
  };

  const submit = async () => {
    setFormError(null);
    setChecked(true);
    const built = build(draft);
    if (!built.ok) {
      setIssues(built.issues);
      return;
    }
    setIssues([]);
    await handle(await writer.submit(built.body), built.body);
  };

  const retry = async () => {
    setFormError(null);
    const body = pending?.body as { entries: readonly { direction: EntryDirection }[] } | undefined;
    if (body) await handle(await writer.retry(), body);
  };

  const changeType = (type: TxnType) => {
    set({ type });
    setParams({ type }, { replace: true });
  };

  // ---------------------------------------------------------------- render
  const map = issueMap([...issues, ...serverIssues]);
  const status = useFieldStatus(map);
  const issueText = useIssueText();
  const countries = useMemo(() => regionOptions(i18n.language), [i18n.language]);
  const allCurrencies = useMemo(() => currencyOptions(i18n.language), [i18n.language]);
  const unknownOption = { value: UNKNOWN_REGION, label: t('transactions.form.unknownRegion') };
  const latest = latestOccurredOn(Date.now());
  const sending = pending?.state === 'sending';
  const formIssues = map.get('form') ?? [];
  const entryLabel = (dir: EntryDirection) => t(`transactions.form.entryLabels.${labelKey(draft, dir)}`);
  const amountLabel = (dir: EntryDirection) => t(dir === 'out' ? 'transactions.form.amountOut' : 'transactions.form.amountIn');
  const eventLabel = t(`transactions.form.eventLabels.${draft.type === 'third_party_transfer' ? `third_party_${draft.direction}` : draft.type}`);

  return (
    <>
      <PageTop title={correction ? t('transactions.lifecycle.factTitle', { n: baseRevision }) : t('transactions.form.title')} />
      <Link to={correction ? transactionHref(correction.id) : '/transactions'} className="back-link">
        <ArrowLeftOutlined /> {t(correction ? 'transactions.lifecycle.backToDetail' : 'transactions.detail.back')}
      </Link>
      <PendingWriteBanner writer={writer} onRetry={() => void retry()} onAbandoned={() => setFormError(null)} checkHref={correction ? transactionHref(correction.id) : '/transactions'} />
      {correction && conflict !== null && (
        <ConflictPanel
          txn={correction}
          baseRevision={baseRevision}
          currentRevision={conflict}
          onRebase={() => {
            setBaseRevision(correction.currentRevision);
            setBaseEntries(correction.entries);
            setConflict(null);
          }}
        >
          <Button
            onClick={() => {
              setDraft(draftFromVersion(correction.txnType, correction.event, correction.entries));
              setBaseRevision(correction.currentRevision);
              setBaseEntries(correction.entries);
              setConflict(null);
            }}
            className="txn-reload-latest"
          >
            {t('transactions.lifecycle.reloadLatest', { n: correction.currentRevision })}
          </Button>
        </ConflictPanel>
      )}

      {formError && <FormErrorAlert error={formError} formIssues={formIssues.map(issueText)} />}

      <ConfigProvider componentDisabled={locked}>
        <Form layout="vertical" className="txn-form" data-type={draft.type} onFinish={() => void submit()} disabled={locked}>
          <Card className="txn-form-card">
            <Form.Item label={t('transactions.form.type')}>
              <Segmented<TxnType>
                className="txn-type-switch"
                value={draft.type}
                onChange={changeType}
                disabled={locked || !!correction}
                options={TXN_TYPES.map((v) => ({ value: v, label: t(`transactions.types.${v}`) }))}
                block
              />
            </Form.Item>
            {correction && <Typography.Paragraph type="secondary" className="field-note txn-type-fixed">{t('transactions.lifecycle.typeFixed')}</Typography.Paragraph>}
            {draft.type === 'own_transfer' && (
              <Form.Item label={t('transactions.form.ownMode')} extra={t(`transactions.form.ownModeHint.${draft.ownMode}`)}>
                <Radio.Group value={draft.ownMode} onChange={(e) => set({ ownMode: e.target.value })}>
                  <Radio value="both">{t('transactions.form.ownBoth')}</Radio>
                  <Radio value="one">{t('transactions.form.ownOne')}</Radio>
                </Radio.Group>
              </Form.Item>
            )}
            {(draft.type === 'third_party_transfer' || (draft.type === 'own_transfer' && draft.ownMode === 'one')) && (
              <Form.Item label={t('transactions.form.direction')}>
                <Radio.Group value={draft.direction} onChange={(e) => set({ direction: e.target.value })}>
                  <Radio value="out">{t(`transactions.form.directionLabels.${draft.type}.out`)}</Radio>
                  <Radio value="in">{t(`transactions.form.directionLabels.${draft.type}.in`)}</Radio>
                </Radio.Group>
              </Form.Item>
            )}
            <Row gutter={16}>
              <Col xs={24} md={12}>
                <Form.Item label={t('transactions.form.recordMode')} extra={t(`transactions.form.recordModeHint.${draft.recordMode}`)}>
                  <Radio.Group value={draft.recordMode} onChange={(e) => set({ recordMode: e.target.value, declaredHomeRegion: null })}>
                    <Radio value="current">{t('transactions.recordMode.current')}</Radio>
                    <Radio value="backfill">{t('transactions.recordMode.backfill')}</Radio>
                  </Radio.Group>
                </Form.Item>
              </Col>
              {correction && (
                <Col xs={24} md={12}>
                  <Form.Item label={t('transactions.detail.homeRegion')} extra={t('transactions.lifecycle.homeRegionCarried')}>
                    <span data-field="homeRegionCarried">{`${regionName(correction.event.homeRegion, i18n.language)} (${correction.event.homeRegion})`}</span>
                  </Form.Item>
                </Col>
              )}
              {!correction && draft.recordMode === 'backfill' && (
                <Col xs={24} md={12}>
                  <Form.Item
                    label={t('transactions.form.declaredHomeRegion')}
                    extra={t('transactions.form.declaredHomeRegionHint', { region: settings ? `${regionName(settings.homeRegion, i18n.language)} (${settings.homeRegion})` : '…' })}
                  >
                    <Select<string>
                      allowClear
                      showSearch={{ optionFilterProp: 'label' }}
                      aria-label={t('transactions.form.declaredHomeRegion')}
                      placeholder={t('transactions.form.declaredHomeRegionNone')}
                      value={draft.declaredHomeRegion ?? undefined}
                      onChange={(v) => set({ declaredHomeRegion: v ?? null })}
                      options={countries}
                    />
                  </Form.Item>
                </Col>
              )}
            </Row>
            <Row gutter={16}>
              <Col xs={24} md={8}>
                <Form.Item label={t('transactions.detail.occurredOn')} required {...status('occurredOn')}>
                  <DatePicker
                    aria-label={t('transactions.detail.occurredOn')}
                    value={draft.occurredOn ? dayjs(draft.occurredOn) : null}
                    onChange={(v) => set({ occurredOn: v ? v.format(DATE) : null })}
                    disabledDate={(d) => d.format(DATE) > latest}
                    style={{ width: '100%' }}
                    inputReadOnly
                  />
                </Form.Item>
              </Col>
              <Col xs={24} md={8}>
                <Form.Item label={t('transactions.detail.occurredTime')} {...status('occurredTime')}>
                  <Input type="time" aria-label={t('transactions.detail.occurredTime')} value={draft.occurredTime ?? ''} onChange={(e) => set({ occurredTime: e.target.value || null })} />
                </Form.Item>
              </Col>
              <Col xs={24} md={8}>
                <Form.Item label={t('transactions.detail.postedOn')} {...status('postedOn')}>
                  <DatePicker
                    aria-label={t('transactions.detail.postedOn')}
                    value={draft.postedOn ? dayjs(draft.postedOn) : null}
                    onChange={(v) => set({ postedOn: v ? v.format(DATE) : null })}
                    disabledDate={(d) => !!draft.occurredOn && d.format(DATE) < draft.occurredOn}
                    style={{ width: '100%' }}
                    inputReadOnly
                  />
                </Form.Item>
              </Col>
            </Row>
          </Card>

          {merchant && (
            <Card title={t('transactions.form.merchantSection')} className="txn-form-card">
              <Row gutter={16}>
                <Col xs={24} md={12}>
                  <Form.Item label={t('transactions.detail.merchant')} {...status('merchantName')}>
                    <Input aria-label={t('transactions.detail.merchant')} value={draft.merchantName} onChange={(e) => set({ merchantName: e.target.value })} maxLength={NAME_MAX} />
                  </Form.Item>
                </Col>
                <Col xs={24} md={12}>
                  <Form.Item label={t('transactions.detail.merchantCountry')} required {...status('merchantCountry')} extra={t('transactions.form.merchantCountryHint')}>
                    <Select<string>
                      showSearch={{ optionFilterProp: 'label' }}
                      aria-label={t('transactions.detail.merchantCountry')}
                      placeholder={t('transactions.form.chooseRegion')}
                      value={draft.merchantCountry ?? undefined}
                      onChange={(v) => set({ merchantCountry: v })}
                      options={[unknownOption, ...countries]}
                    />
                  </Form.Item>
                </Col>
                <Col xs={24} md={12}>
                  <Form.Item label={t('transactions.detail.card')} extra={t('transactions.form.cardHint')}>
                    <Select<string>
                      allowClear
                      showSearch={{ optionFilterProp: 'label' }}
                      aria-label={t('transactions.detail.card')}
                      placeholder={t('transactions.form.noCard')}
                      value={draft.cardId ?? undefined}
                      onChange={(v) => set({ cardId: v ?? null })}
                      options={cards.map((c) => ({ value: c.id, label: `${c.name} •••• ${c.last4}${c.status !== 'active' ? ` (${t(`cards.statuses.${c.status}`)})` : ''}` }))}
                    />
                  </Form.Item>
                </Col>
                <Col xs={24} md={12}>
                  <Form.Item label={t('transactions.detail.channel')}>
                    <Select<string>
                      allowClear
                      showSearch={{ optionFilterProp: 'label' }}
                      aria-label={t('transactions.detail.channel')}
                      placeholder={t('transactions.form.noChannel')}
                      value={draft.paymentChannelId ?? undefined}
                      onChange={(v) => set({ paymentChannelId: v ?? null })}
                      options={channels.map((c) => ({ value: c.id, label: `${c.name}${c.status !== 'active' ? ` (${t(`channels.statuses.${c.status}`)})` : ''}` }))}
                    />
                  </Form.Item>
                </Col>
              </Row>
            </Card>
          )}

          <Card title={t('transactions.form.amountSection')} className="txn-form-card">
            <Row gutter={16} align="bottom">
              <Col xs={24} md={8}>
                <Form.Item label={t('transactions.form.eventCurrency')} required={!(eventAmountMayBeUnknown(draft) && draft.eventAmountUnknown)} {...status('eventCurrency')}>
                  <Select<string>
                    allowClear
                    showSearch={{ optionFilterProp: 'label' }}
                    aria-label={t('transactions.form.eventCurrency')}
                    placeholder={t('transactions.form.chooseCurrency')}
                    value={draft.eventCurrency ?? undefined}
                    onChange={(v) => set({ eventCurrency: v ?? null })}
                    options={allCurrencies}
                  />
                </Form.Item>
              </Col>
              <Col xs={24} md={8}>
                <Form.Item label={eventLabel} required={!(eventAmountMayBeUnknown(draft) && draft.eventAmountUnknown)} {...status('eventAmount')} extra={t('transactions.form.eventAmountHint')}>
                  <AmountInput aria-label={eventLabel} value={draft.eventAmountText} currency={draft.eventCurrency} disabled={locked || (eventAmountMayBeUnknown(draft) && draft.eventAmountUnknown)} onChange={(v) => set({ eventAmountText: v })} />
                </Form.Item>
              </Col>
              {eventAmountMayBeUnknown(draft) && (
                <Col xs={24} md={8}>
                  <Form.Item>
                    <Checkbox checked={draft.eventAmountUnknown} onChange={(e) => set({ eventAmountUnknown: e.target.checked })}>
                      {t('transactions.eventAmountUnknown')}
                    </Checkbox>
                  </Form.Item>
                </Col>
              )}
            </Row>

            {draft.type === 'merchant_spend' && draft.cardId && draft.eventCurrency && (
              <div className="txn-recommendation" data-match={rec?.match ?? ''} data-mode={draft.recordMode}>
                <Typography.Title level={5}>{t('transactions.form.recommendation')}</Typography.Title>
                {draft.recordMode === 'backfill' && (
                  <Alert type="info" showIcon className="form-alert" title={t('transactions.form.recommendationBackfill')} action={rec && rec.match !== 'no_match' ? <Button size="small" onClick={applyRecommendation} className="txn-apply-rec">{t('transactions.form.applyRecommendation')}</Button> : undefined} />
                )}
                {rec ? <SpendingSourceExplain result={rec} /> : recLoading ? <Typography.Text type="secondary">…</Typography.Text> : null}
              </div>
            )}

            {dirs.map((dir) => (
              <EntryEditor
                key={dir}
                direction={dir}
                entry={draft.entries[dir]}
                accounts={accounts}
                recordMode={draft.recordMode}
                label={entryLabel(dir)}
                amountLabel={dirs.length === 2 ? `${entryLabel(dir)} · ${amountLabel(dir)}` : amountLabel(dir)}
                issues={map}
                onChange={setEntry(dir)}
                disabled={locked}
              />
            ))}
            {!merchant && (
              <Form.Item label={t('transactions.detail.transferMethod')} extra={t('transactions.form.transferMethodHint')}>
                <Select
                  allowClear
                  aria-label={t('transactions.detail.transferMethod')}
                  placeholder={t('transactions.form.noTransferMethod')}
                  value={draft.transferMethod ?? undefined}
                  onChange={(v) => set({ transferMethod: v ?? null })}
                  options={TRANSFER_METHODS.map((m) => ({ value: m, label: t(`transactions.transferMethods.${m}`) }))}
                  style={{ maxWidth: 320 }}
                />
              </Form.Item>
            )}
          </Card>

          {hasCounterparty(draft) && (
            <Card title={t(draft.type === 'own_transfer' ? 'transactions.form.ownOtherSide' : 'transactions.detail.counterparty')} className="txn-form-card txn-counterparty-card">
              <Row gutter={16}>
                <Col xs={24} md={12}>
                  <Form.Item label={t('transactions.form.counterpartyCountry')} required {...status('counterparty.country')} extra={t('transactions.form.counterpartyCountryHint')}>
                    <Select<string>
                      showSearch={{ optionFilterProp: 'label' }}
                      aria-label={t('transactions.form.counterpartyCountry')}
                      placeholder={t('transactions.form.chooseRegion')}
                      value={draft.counterparty.country ?? undefined}
                      onChange={(v) => set({ counterparty: { ...draft.counterparty, country: v } })}
                      options={draft.type === 'third_party_transfer' ? [unknownOption, ...countries] : countries}
                    />
                  </Form.Item>
                </Col>
                <Col xs={24} md={12}>
                  <Form.Item label={t('transactions.detail.counterpartyName')} {...status('counterparty.name')}>
                    <Input aria-label={t('transactions.form.counterpartyName')} value={draft.counterparty.name} onChange={(e) => set({ counterparty: { ...draft.counterparty, name: e.target.value } })} maxLength={NAME_MAX} />
                  </Form.Item>
                </Col>
                <Col xs={24} md={12}>
                  <Form.Item label={t('transactions.detail.counterpartyInstitution')} {...status('counterparty.institution')}>
                    <Input aria-label={t('transactions.form.counterpartyInstitution')} value={draft.counterparty.institution} onChange={(e) => set({ counterparty: { ...draft.counterparty, institution: e.target.value } })} maxLength={NAME_MAX} />
                  </Form.Item>
                </Col>
                <Col xs={24} md={12}>
                  <Form.Item label={t('transactions.detail.counterpartyHint')} {...status('counterparty.accountHint')} extra={t('transactions.form.accountHintHint')}>
                    <Input aria-label={t('transactions.form.counterpartyHint')} value={draft.counterparty.accountHint} onChange={(e) => set({ counterparty: { ...draft.counterparty, accountHint: e.target.value.trim() } })} maxLength={4} autoComplete="off" />
                  </Form.Item>
                </Col>
              </Row>
            </Card>
          )}

          {correction && (
            <Card title={t('transactions.lifecycle.reason')} className="txn-form-card txn-reason-card">
              <Form.Item required {...status('reason')} extra={t('transactions.lifecycle.reasonHint')}>
                <Input.TextArea aria-label={t('transactions.lifecycle.reason')} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={REASON_MAX} showCount autoSize={{ minRows: 2, maxRows: 6 }} disabled={locked} />
              </Form.Item>
            </Card>
          )}
          {!correction && <Card title={t('transactions.detail.notes')} className="txn-form-card">
            <Form.Item {...status('notes')} extra={t('transactions.detail.notesHint')}>
              <Input.TextArea aria-label={t('transactions.detail.notes')} value={draft.notes} onChange={(e) => set({ notes: e.target.value })} maxLength={NOTES_MAX} showCount autoSize={{ minRows: 2, maxRows: 8 }} />
            </Form.Item>
          </Card>}

          {hints.length > 0 && (
            <Alert
              type="info"
              showIcon
              className="form-alert txn-hints"
              title={t('transactions.form.hintsTitle')}
              description={
                <ul>
                  {hints.map((h, i) => (
                    <li key={i} data-hint={h.code}>
                      {t(`transactions.hints.${h.code}`, { side: h.direction ? entryLabel(h.direction) : '', currency: h.currency ?? '', lastDay: h.lastDay ?? '', occurredOn: h.occurredOn ?? '' })}
                    </li>
                  ))}
                </ul>
              }
            />
          )}

          <div className="txn-form-actions">
            <Button onClick={() => navigate(correction ? transactionHref(correction.id) : '/transactions')} disabled={sending} className="txn-cancel">
              {t('transactions.detail.cancel')}
            </Button>
            <Button type="primary" htmlType="submit" loading={sending} disabled={locked} className="txn-submit">
              {t('common.save')}
            </Button>
          </div>
        </Form>
      </ConfigProvider>
    </>
  );

  function FormErrorAlert({ error, formIssues }: { error: FormError; formIssues: string[] }) {
    if (error.code === 'IDEMPOTENCY_CONFLICT') {
      return (
        <Alert
          type="error"
          showIcon
          className="form-alert txn-form-error"
          data-code={error.code}
          title={t('errors.codes.IDEMPOTENCY_CONFLICT')}
          description={error.transactionId ? <Link to={transactionHref(error.transactionId)}>{t('transactions.form.openExisting')}</Link> : undefined}
        />
      );
    }
    if (error.code === 'in_flight' || error.code === 'unknown_outcome') return <Alert type="warning" showIcon className="form-alert txn-form-error" data-code={error.code} title={t(`transactions.form.locked.${error.code}`)} />;
    if (error.code === 'CONFIRMED_DOMESTIC') {
      return (
        <Alert
          type="error"
          showIcon
          className="form-alert txn-form-error"
          data-code={error.code}
          title={t('errors.codes.CONFIRMED_DOMESTIC')}
          description={t(correction ? 'transactions.lifecycle.domesticVoidHint' : 'transactions.form.confirmedDomesticHint')}
          action={
            correction && (
              <Button danger size="small" onClick={() => navigate(`${transactionHref(correction.id)}?action=void`)} className="txn-void-instead">
                {t('transactions.lifecycle.voidInstead')}
              </Button>
            )
          }
        />
      );
    }
    if (error.code === 'noChange') return <Alert type="warning" showIcon className="form-alert txn-form-error" data-code={error.code} title={t('transactions.lifecycle.noChange')} />;
    if (error.code === 'other') return <Alert type="error" showIcon className="form-alert txn-form-error" data-code={error.code} title={error.message} />;
    return <Alert type="error" showIcon className="form-alert txn-form-error" data-code={error.code} title={formIssues[0] ?? t('transactions.form.fixFields')} />;
  }
}

/** The recommendation fills untouched entry fields only. */
function applyPrefill(d: TxnDraft, dir: EntryDirection, touched: ReadonlySet<keyof EntryPrefill>, patch: Partial<EntryPrefill>): TxnDraft {
  const e = d.entries[dir];
  const cur: EntryPrefill = { accountId: e.accountId, currency: e.currency, amountText: e.amountText };
  const next = applyEntryPrefill(cur, touched, patch);
  if (next === cur) return d;
  return { ...d, entries: { ...d.entries, [dir]: { ...e, ...next, closedAck: next.currency === e.currency ? e.closedAck : false } } };
}

function labelKey(d: TxnDraft, dir: EntryDirection): string {
  if (d.type === 'merchant_spend') return 'spend';
  if (d.type === 'merchant_refund') return 'refund';
  if (d.type === 'own_transfer') return d.ownMode === 'both' ? `own_${dir}` : `own_one_${dir}`;
  return `third_${dir}`;
}
