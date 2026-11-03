import { App } from 'antd';
import type { AccountDto, AccountInUseDetails, AccountStatus } from '@xui/ledger-shared';
import { useTranslation } from 'react-i18next';
import { deleteAccount, updateAccount, useRefreshAccounts } from '../../api/accounts.ts';
import { ApiError } from '../../api/client.ts';
import { errorText } from '../../api/hooks.ts';

type Target = Pick<AccountDto, 'id' | 'name' | 'status'>;

/**
 * Freeze / unfreeze, close / reopen and delete, shared by the list and the detail page. A status
 * change never touches currencies or card links. Closing asks first; deleting a balance account
 * (409 IN_USE) offers closing instead.
 */
export function useAccountActions() {
  const { t } = useTranslation();
  const { message, modal } = App.useApp();
  const refresh = useRefreshAccounts();

  const setStatus = async (acc: Target, status: AccountStatus) => {
    try {
      await updateAccount(acc.id, { status });
      await refresh();
      void message.success(t(status === 'frozen' ? 'accounts.frozenDone' : status === 'closed' ? 'accounts.closedDone' : 'accounts.activeDone'));
    } catch (e) {
      void message.error(errorText(e, t));
    }
  };

  const close = (acc: Target) =>
    modal.confirm({
      title: t('accounts.closeTitle', { name: acc.name }),
      content: t('accounts.closeContent'),
      okText: t('accounts.close'),
      onOk: () => setStatus(acc, 'closed'),
    });

  const remove = (acc: Target, onDeleted?: () => void) =>
    modal.confirm({
      title: t('accounts.deleteTitle', { name: acc.name }),
      content: t('accounts.deleteContent'),
      okText: t('accounts.delete'),
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await deleteAccount(acc.id);
          onDeleted?.();
          await refresh();
          void message.success(t('common.deleted'));
        } catch (e) {
          if (!(e instanceof ApiError && e.code === 'IN_USE')) {
            void message.error(errorText(e, t));
            return;
          }
          const channels = ((e.details as AccountInUseDetails | undefined)?.channels ?? []).map((c) => c.name).join(', ');
          const info = { title: t('accounts.inUseTitle', { name: acc.name }), content: t('accounts.inUseContent', { channels }) };
          if (acc.status === 'closed') modal.info(info);
          else modal.confirm({ ...info, okText: t('accounts.close'), onOk: () => setStatus(acc, 'closed') });
        }
      },
    });

  return {
    freeze: (acc: Target) => setStatus(acc, 'frozen'),
    activate: (acc: Target) => setStatus(acc, 'active'),
    close,
    remove,
  };
}
