import { Tabs } from 'antd';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import { PageTop } from '../layouts/PanelLayout.tsx';
import { AccountsTab } from './accounts/AccountsTab.tsx';
import { InstitutionsTab } from './accounts/InstitutionsTab.tsx';
import { ChannelsTab } from './channels/ChannelsTab.tsx';

const TABS = ['accounts', 'institutions', 'channels'] as const;
type TabKey = (typeof TABS)[number];

/** 账户: tabs 账户 · 机构 · 支付渠道 (PRODUCT_SPEC §4.5) — payment channels live here, not in a sixth top-level page. */
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
          { key: 'accounts', label: t('accounts.tabs.accounts'), children: <AccountsTab /> },
          { key: 'institutions', label: t('accounts.tabs.institutions'), children: <InstitutionsTab /> },
          { key: 'channels', label: t('accounts.tabs.channels'), children: <ChannelsTab /> },
        ]}
      />
    </>
  );
}
