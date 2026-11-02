import { useTranslation } from 'react-i18next';
import { EmptyCard, PageIntro } from '../components/Placeholder.tsx';
import { PageTop } from '../layouts/PanelLayout.tsx';

/** 银行卡 (placeholder until M2; credit cards, statements and repayments are out of scope). */
export function CardsPage() {
  const { t } = useTranslation();
  return (
    <>
      <PageTop title={t('nav.cards')} />
      <PageIntro text={t('cards.desc')} />
      <EmptyCard title={t('cards.list')} />
    </>
  );
}
