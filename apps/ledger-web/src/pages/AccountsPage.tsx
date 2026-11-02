import { Tabs } from 'antd';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import { EmptyCard, PageIntro } from '../components/Placeholder.tsx';
import { PageTop } from '../layouts/PanelLayout.tsx';
import { InstitutionsTab } from './accounts/InstitutionsTab.tsx';

const TABS = ['accounts', 'institutions', 'channels'] as const;
type TabKey = (typeof TABS)[number];

/** 账户: tabs 账户 · 机构 · 支付渠道 (PRODUCT_SPEC §4.5). Institutions are live; the others arrive in later M2 steps. */
export function AccountsPage() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const tab: TabKey = TABS.find((k) => k === params.get('tab')) ?? 'accounts';
  return (
    <>
      <PageTop title={t('nav.accounts')} />
      <Tabs
        activeKey={tab}
        onChange={(k) => setParams(k === 'accounts' ? {} : { tab: k }, { replace: true })}
        items={[
          {
            key: 'accounts',
            label: t('accounts.tabs.accounts'),
            children: (
              <>
                <PageIntro text={t('accounts.desc')} />
                <EmptyCard title={t('accounts.list')} />
              </>
            ),
          },
          { key: 'institutions', label: t('accounts.tabs.institutions'), children: <InstitutionsTab /> },
          { key: 'channels', label: t('accounts.tabs.channels'), children: <EmptyCard title={t('accounts.tabs.channels')} /> },
        ]}
      />
    </>
  );
}
