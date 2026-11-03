import { App, Typography } from 'antd';
import { useQueryClient } from '@tanstack/react-query';
import type { ChannelStatus, PaymentChannelDetail, PaymentChannelDto } from '@xui/ledger-shared';
import { useTranslation } from 'react-i18next';
import { useRefreshAccounts } from '../../api/accounts.ts';
import { CHANNELS, deleteChannel, updateChannel } from '../../api/channels.ts';
import { get } from '../../api/client.ts';
import { errorText } from '../../api/hooks.ts';

/** Archive / restore / delete a payment channel, shared by the list and the detail page. */
export function useChannelActions() {
  const { t } = useTranslation();
  const { message, modal } = App.useApp();
  const qc = useQueryClient();
  // Accounts, cards and institutions embed channel summaries: refresh them too.
  const refresh = useRefreshAccounts();

  const setStatus = async (ch: Pick<PaymentChannelDto, 'id'>, status: ChannelStatus) => {
    try {
      await updateChannel(ch.id, { status });
      void message.success(t(status === 'archived' ? 'channels.archived' : 'channels.restored'));
    } catch (e) {
      void message.error(errorText(e, t));
    } finally {
      await refresh();
    }
  };

  /** Delete is for correcting mistakes: say what goes with it (its source records) and what stays. */
  const remove = async (ch: Pick<PaymentChannelDto, 'id' | 'name' | 'status'>, onDeleted?: () => void) => {
    let detail: PaymentChannelDetail;
    try {
      detail = await qc.fetchQuery({ queryKey: [CHANNELS, 'detail', ch.id], queryFn: () => get<PaymentChannelDetail>(`/payment-channels/${encodeURIComponent(ch.id)}`), staleTime: 0 });
    } catch (e) {
      void message.error(errorText(e, t));
      await refresh();
      return;
    }
    const active = detail.sources.filter((s) => s.status === 'active').length;
    const ended = detail.sources.length - active;
    modal.confirm({
      className: 'channel-delete-dialog',
      title: t('channels.deleteTitle', { name: ch.name }),
      content: (
        <>
          <Typography.Paragraph>{t('channels.deleteContent')}</Typography.Paragraph>
          {detail.sources.length > 0 && <Typography.Paragraph className="channel-delete-impact">{t('channels.deleteImpact', { total: detail.sources.length, active, ended })}</Typography.Paragraph>}
          <Typography.Paragraph type="secondary">{t('channels.deleteKeeps')}</Typography.Paragraph>
        </>
      ),
      okText: t('channels.delete'),
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await deleteChannel(ch.id);
          onDeleted?.();
          void message.success(t('common.deleted'));
        } catch (e) {
          void message.error(errorText(e, t));
        } finally {
          await refresh();
        }
      },
    });
  };

  return { archive: (ch: Pick<PaymentChannelDto, 'id'>) => setStatus(ch, 'archived'), restore: (ch: Pick<PaymentChannelDto, 'id'>) => setStatus(ch, 'active'), remove };
}
