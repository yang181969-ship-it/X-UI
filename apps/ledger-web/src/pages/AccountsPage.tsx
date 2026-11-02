import { useTranslation } from 'react-i18next';
import { EmptyCard, PageIntro } from '../components/Placeholder.tsx';
import { PageTop } from '../layouts/PanelLayout.tsx';

/** 账户 (placeholder until M2). */
export function AccountsPage() {
  const { t } = useTranslation();
  return (
    <>
      <PageTop title={t('nav.accounts')} />
      <PageIntro text={t('accounts.desc')} />
      <EmptyCard title={t('accounts.list')} />
    </>
  );
}
