import { Alert, App, Button, Input, Modal, Typography } from 'antd';
import type { CardDto, CardStatus } from '@xui/ledger-shared';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useRefreshAccounts } from '../../api/accounts.ts';
import { deleteCard, updateCard, useCard } from '../../api/cards.ts';
import { ApiError } from '../../api/client.ts';
import { errorText } from '../../api/hooks.ts';

type Target = Pick<CardDto, 'id' | 'name' | 'status' | 'last4'>;

/**
 * Freeze / unfreeze, deactivate / restore and delete, shared by the list and the detail page. A
 * status change never touches the card's links. Deleting asks first in a dialog of its own
 * (deleteDialog): it lists what goes with the card (link and channel-source records by status) and
 * what does not. When the card has any, deactivating is the suggested (primary) action and deleting
 * needs the last four digits typed — a guard against mistakes, not identity verification.
 */
export function useCardActions() {
  const { t } = useTranslation();
  const { message, modal } = App.useApp();
  const refresh = useRefreshAccounts();
  const [deleting, setDeleting] = useState<{ card: Target; onDeleted?: () => void } | null>(null);

  const setStatus = async (card: Target, status: CardStatus) => {
    try {
      await updateCard(card.id, { status });
      await refresh();
      void message.success(t(status === 'frozen' ? 'cards.frozenDone' : status === 'closed' ? 'cards.closedDone' : 'cards.activeDone'));
    } catch (e) {
      void message.error(errorText(e, t));
    }
  };

  const close = (card: Target) =>
    modal.confirm({
      title: t('cards.closeTitle', { name: card.name }),
      content: t('cards.closeContent'),
      okText: t('cards.close'),
      onOk: () => setStatus(card, 'closed'),
    });

  const deleteDialog = (
    <CardDeleteDialog
      target={deleting?.card ?? null}
      onClose={() => setDeleting(null)}
      onDeleted={async () => {
        deleting?.onDeleted?.();
        setDeleting(null);
        await refresh();
      }}
      onDeactivate={(card) => {
        setDeleting(null);
        void setStatus(card, 'closed');
      }}
    />
  );

  return {
    freeze: (card: Target) => setStatus(card, 'frozen'),
    activate: (card: Target) => setStatus(card, 'active'),
    close,
    remove: (card: Target, onDeleted?: () => void) => setDeleting({ card, onDeleted }),
    /** Render once wherever the actions are used. */
    deleteDialog,
  };
}

function CardDeleteDialog({ target, onClose, onDeleted, onDeactivate }: { target: Target | null; onClose: () => void; onDeleted: () => Promise<void>; onDeactivate: (card: Target) => void }) {
  const { t } = useTranslation();
  const { message } = App.useApp();
  // The detail lists every link (ended ones too) and counts every channel-source record: exactly what the delete removes with the card.
  const { data, isError } = useCard(target?.id);
  const detail = target && data?.id === target.id ? data : undefined;
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => setTyped(''), [target?.id]);

  const linkCount = (status?: string) => detail?.links.filter((l) => !status || l.status === status).length ?? 0;
  const links = { total: linkCount(), active: linkCount('active'), suspended: linkCount('suspended'), ended: linkCount('ended') };
  const sourceCounts = detail?.channelSourceCounts ?? { active: 0, ended: 0 };
  const sources = { ...sourceCounts, total: sourceCounts.active + sourceCounts.ended };
  const referenced = links.total + sources.total > 0;
  // With references, deactivating is the suggested action and deleting the secondary one.
  const suggestDeactivate = !!target && referenced && target.status !== 'closed';
  const ready = !!detail && (!referenced || typed === target?.last4);

  const submit = async () => {
    if (!target || !ready) return;
    setBusy(true);
    try {
      await deleteCard(target.id);
      void message.success(t('common.deleted'));
      await onDeleted();
    } catch (e) {
      // Already gone (deleted elsewhere): nothing left to do.
      if (e instanceof ApiError && e.status === 404) await onDeleted();
      void message.error(errorText(e, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={!!target}
      className="card-delete-dialog"
      title={target ? t('cards.deleteTitle', { name: target.name }) : ''}
      onCancel={onClose}
      onOk={submit}
      okText={t('cards.delete')}
      okButtonProps={{ danger: true, disabled: !ready, type: suggestDeactivate ? 'default' : 'primary' }}
      confirmLoading={busy}
      footer={(_, { OkBtn, CancelBtn }) => (
        <>
          {suggestDeactivate && (
            <Button type="primary" onClick={() => onDeactivate(target)}>
              {t('cards.deleteInstead')}
            </Button>
          )}
          <CancelBtn />
          <OkBtn />
        </>
      )}
    >
      <Typography.Paragraph>{t('cards.deleteContent')}</Typography.Paragraph>
      {isError && !detail && <Alert type="error" showIcon title={t('cards.notFound')} />}
      {target && referenced && (
        <>
          <Alert
            type="warning"
            showIcon
            className="form-alert delete-impact"
            title={t('cards.deleteImpact')}
            description={
              <ul>
                {links.total > 0 && <li data-impact="links">{t('cards.deleteImpactLinks', links)}</li>}
                {sources.total > 0 && <li data-impact="sources">{t('cards.deleteImpactSources', sources)}</li>}
              </ul>
            }
          />
          <Typography.Paragraph type="secondary" className="delete-keeps">
            {t('cards.deleteKeeps')}
          </Typography.Paragraph>
          {suggestDeactivate && <Typography.Paragraph className="delete-suggest">{t('cards.deleteSuggest')}</Typography.Paragraph>}
          <label className="delete-confirm-label">
            {t('cards.deleteConfirmLast4', { last4: target.last4 })}
            <Input value={typed} onChange={(e) => setTyped(e.target.value.trim())} maxLength={4} inputMode="numeric" autoComplete="off" aria-label={t('cards.deleteConfirmLast4', { last4: target.last4 })} />
            <span className="field-note">{t('cards.deleteConfirmHint')}</span>
          </label>
        </>
      )}
    </Modal>
  );
}
