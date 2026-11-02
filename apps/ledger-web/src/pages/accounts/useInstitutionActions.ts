import { useQueryClient } from '@tanstack/react-query';
import { App } from 'antd';
import type { InstitutionDto, InstitutionStatus } from '@xui/ledger-shared';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../api/client.ts';
import { errorText } from '../../api/hooks.ts';
import { deleteInstitution, INSTITUTIONS, updateInstitution, type InUseDetails } from '../../api/institutions.ts';

/** Archive / restore / delete, shared by the list and the detail drawer. */
export function useInstitutionActions() {
  const { t } = useTranslation();
  const { message, modal } = App.useApp();
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: [INSTITUTIONS] });

  const setStatus = async (inst: Pick<InstitutionDto, 'id'>, status: InstitutionStatus) => {
    try {
      await updateInstitution(inst.id, { status });
      await refresh();
      void message.success(status === 'archived' ? t('institutions.archived') : t('institutions.restored'));
    } catch (e) {
      void message.error(errorText(e, t));
    }
  };

  /** Ask, then delete. A referenced institution (409 IN_USE) gets an offer to archive it instead. */
  const remove = (inst: Pick<InstitutionDto, 'id' | 'name' | 'status'>, onDeleted?: () => void) =>
    modal.confirm({
      title: t('institutions.deleteTitle', { name: inst.name }),
      content: t('institutions.deleteContent'),
      okText: t('institutions.delete'),
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await deleteInstitution(inst.id);
          onDeleted?.();
          await refresh();
          void message.success(t('common.deleted'));
        } catch (e) {
          if (!(e instanceof ApiError && e.code === 'IN_USE')) {
            void message.error(errorText(e, t));
            return;
          }
          const refs = (e.details as InUseDetails | undefined)?.references ?? { accounts: 0, cards: 0, channels: 0 };
          const info = { title: t('institutions.inUseTitle', { name: inst.name }), content: t('institutions.inUseContent', refs) };
          if (inst.status === 'archived') modal.info(info);
          else modal.confirm({ ...info, okText: t('institutions.archive'), onOk: () => setStatus(inst, 'archived') });
        }
      },
    });

  return { archive: (inst: Pick<InstitutionDto, 'id'>) => setStatus(inst, 'archived'), restore: (inst: Pick<InstitutionDto, 'id'>) => setStatus(inst, 'active'), remove };
}
