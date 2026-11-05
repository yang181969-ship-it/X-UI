import { ArrowLeftOutlined, CameraOutlined, CheckCircleOutlined, EditOutlined, StopOutlined } from '@ant-design/icons';
import { Alert, Button, Card, Empty, Skeleton, Space, Typography } from 'antd';
import type { TransactionDto } from '@xui/ledger-shared';
import { useMemo } from 'react';
import dayjs from 'dayjs';
import { useTranslation } from 'react-i18next';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import { useMe } from '../api/hooks.ts';
import { browserSessionStorage, listPendingWrites, type PendingWrite } from '../lib/pendingWrite.ts';
import { pendingEntries } from '../lib/lifecycle.ts';
import { SettlementDrawer } from './transactions/lifecycle/SettlementDrawer.tsx';
import { SnapshotDrawer } from './transactions/lifecycle/SnapshotDrawer.tsx';
import { VoidModal } from './transactions/lifecycle/VoidModal.tsx';
import { correctionHref, transactionHref, useTransaction } from '../api/transactions.ts';
import { TxnStatusTags } from '../components/TxnStatusTags.tsx';
import { PageTop } from '../layouts/PanelLayout.tsx';
import { NotesEditor } from './transactions/NotesEditor.tsx';
import { RevisionDrawer } from './transactions/RevisionDrawer.tsx';
import { RevisionTimeline } from './transactions/RevisionTimeline.tsx';
import { CurrentSummary, FactsView } from './transactions/TxnFacts.tsx';
import { dateOf, EventAmount, subjectOf, typeLabel } from './transactions/txnDisplay.tsx';

const at = (ms: number) => dayjs(ms).format('YYYY-MM-DD HH:mm');

/**
 * /transactions/:id (and /transactions/:id/revisions/:revision with the version drawer open) —
 * PRODUCT_SPEC §7.10, API_SPEC §5.5 / §5.6. The current version's saved facts and snapshots, the
 * current summaries of its accounts, card and channel (kept apart), the version history and the
 * notes. Read-only apart from the notes in M3-B4-B: no correction, void or delete here, and history
 * can never be edited or deleted.
 */
export function TransactionDetailPage() {
  const { t } = useTranslation();
  const { id, revision } = useParams<{ id: string; revision?: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const { data, isLoading, isError } = useTransaction(id);
  const txn = data?.id === id ? data : undefined;
  // Back to the list with the filters it had (passed by the list); the plain list otherwise.
  const from = (location.state as { from?: string } | null)?.from;
  // The open lifecycle dialog lives in the URL (?action=settle|snapshot|void): the correction page's
  // "void instead" and a restored unconfirmed write open it directly.
  const [params, setParams] = useSearchParams();
  const action = params.get('action');
  const openAction = (a: Action | null) => setParams(a ? { action: a } : {}, { replace: true, state: location.state });

  return (
    <>
      <PageTop title={t('transactions.detail.title')} />
      <Link to={`/transactions${from ?? ''}`} className="back-link">
        <ArrowLeftOutlined /> {t('transactions.detail.back')}
      </Link>
      {isLoading && <Skeleton active />}
      {isError && !txn && (
        <Card>
          <Empty description={t('transactions.detail.notFound')} />
        </Card>
      )}
      {txn && (
        <div className={`txn-detail ${txn.status === 'voided' ? 'is-voided' : ''}`} data-txn={txn.id} data-status={txn.status}>
          <Card className="txn-head">
            <div className="txn-head-main">
              <div className="row-main">
                <Typography.Title level={3} style={{ margin: 0 }} className="txn-head-title">
                  {typeLabel(txn, t)}
                </Typography.Title>
                <div className="row-sub">
                  {subjectOf(txn, t) ?? '—'} · <span className="num">{dateOf(txn.event)}</span>
                </div>
              </div>
              <div className="txn-head-amount">
                <span className="muted">{t('transactions.eventAmount')}</span>
                <EventAmount event={txn.event} />
              </div>
            </div>
            <Space size={[8, 4]} wrap className="txn-head-meta">
              <TxnStatusTags txn={txn} />
              <span className="muted">{t('transactions.detail.currentRevision', { n: txn.currentRevision })}</span>
              <span className="muted">
                {t('transactions.detail.createdAt')} {at(txn.createdAt)}
              </span>
              <span className="muted">
                {t('transactions.detail.updatedAt')} {at(txn.updatedAt)}
              </span>
              {txn.voidedAt !== null && <span className="muted">{t('transactions.detail.voidedAt', { at: at(txn.voidedAt) })}</span>}
            </Space>
            <LifecycleActions txn={txn} onAction={openAction} onFact={() => navigate(correctionHref(txn.id), { state: location.state })} />
          </Card>
          <UnresolvedWrites txn={txn} key={action ?? 'none'} onOpen={(a) => (a === 'fact' ? navigate(correctionHref(txn.id), { state: location.state }) : openAction(a))} />
          <FactsView txnType={txn.txnType} revision={txn.currentRevision} event={txn.event} entries={txn.entries} refs={{ card: txn.card, channel: txn.paymentChannel }} />
          <CurrentSummary txn={txn} />
          <RevisionTimeline txn={txn} />
          <NotesEditor txn={txn} />
          <RevisionDrawer txn={txn} revision={revision} onClose={() => navigate(transactionHref(txn.id), { state: location.state })} />
          <SettlementDrawer txn={txn} open={action === 'settle'} onClose={() => openAction(null)} />
          <SnapshotDrawer txn={txn} open={action === 'snapshot'} onClose={() => openAction(null)} onVoid={() => openAction('void')} />
          <VoidModal txn={txn} open={action === 'void'} onClose={() => openAction(null)} />
        </div>
      )}
    </>
  );
}

type Action = 'settle' | 'snapshot' | 'void';

/**
 * Financial changes (M3-B4-D) — active transactions only: settle pending amounts (when some are
 * pending), fact correction, snapshot correction, void. A voided transaction shows none of them;
 * its notes and every version stay available.
 */
function LifecycleActions({ txn, onAction, onFact }: { txn: TransactionDto; onAction: (a: Action) => void; onFact: () => void }) {
  const { t } = useTranslation();
  if (txn.status !== 'active') return null;
  return (
    <Space wrap className="txn-actions">
      {pendingEntries(txn.entries).length > 0 && (
        <Button icon={<CheckCircleOutlined />} onClick={() => onAction('settle')} className="txn-action-settle">
          {t('transactions.lifecycle.settle')}
        </Button>
      )}
      <Button icon={<EditOutlined />} onClick={onFact} className="txn-action-fact">
        {t('transactions.lifecycle.fact')}
      </Button>
      <Button icon={<CameraOutlined />} onClick={() => onAction('snapshot')} className="txn-action-snapshot">
        {t('transactions.lifecycle.snapshot')}
      </Button>
      <Button danger icon={<StopOutlined />} onClick={() => onAction('void')} className="txn-action-void">
        {t('transactions.lifecycle.void')}
      </Button>
    </Space>
  );
}

/** Unconfirmed corrections / voids of this transaction kept in this tab (after a reload or a closed dialog). */
function UnresolvedWrites({ txn, onOpen }: { txn: TransactionDto; onOpen: (a: Action | 'fact') => void }) {
  const { t } = useTranslation();
  const { data: me } = useMe();
  // Re-read when the page re-renders it (a dialog closing changes its key).
  const writes = useMemo(() => (me ? listPendingWrites(browserSessionStorage(), me.user.id).filter((p) => p.transactionId === txn.id) : []), [me, txn.id]);
  if (writes.length === 0) return null;
  const target = (p: PendingWrite): Action | 'fact' => {
    if (p.operation === 'transaction.void') return 'void';
    const kind = (p.body as { kind?: string }).kind;
    return kind === 'settlement' ? 'settle' : kind === 'snapshot_correction' ? 'snapshot' : 'fact';
  };
  return (
    <>
      {writes.map((p) => (
        <Alert
          key={p.operation}
          type="warning"
          showIcon
          className="form-alert txn-unresolved"
          data-target={target(p)}
          title={t('transactions.lifecycle.unresolved', { what: t(`transactions.lifecycle.kinds.${target(p)}`) })}
          action={
            <Button size="small" onClick={() => onOpen(target(p))} className="txn-unresolved-open">
              {t('transactions.form.unresolvedOpen')}
            </Button>
          }
        />
      ))}
    </>
  );
}
