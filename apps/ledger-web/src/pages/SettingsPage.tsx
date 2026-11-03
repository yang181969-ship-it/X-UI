import { DEFAULT_HOME_REGION, type CountryCode } from '@xui/ledger-shared';
import { Alert, Button, Card, Descriptions, Segmented, Select, Skeleton, Space, Tabs, Tag } from 'antd';
import dayjs from 'dayjs';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { errorText, useAction, useSystemInfo } from '../api/hooks.ts';
import { SETTINGS, updateProfileSettings, useProfileSettings } from '../api/settings.ts';
import { setLanguage } from '../i18n/index.ts';
import { PageTop } from '../layouts/PanelLayout.tsx';
import { regionName, regionOptions } from '../lib/regions.ts';
import { useTheme, type ThemeMode } from '../theme/ThemeProvider.tsx';
import { SecuritySection } from './SecuritySection.tsx';

/**
 * The user's own home region (GET / PATCH /settings/profile). CN until the user saves another one
 * (the 默认 tag shows while nothing is saved — a saved CN is the user's own choice, not the default);
 * M3 copies it into each new transaction, so a change never reclassifies saved ones.
 */
function HomeRegionCard() {
  const { t, i18n } = useTranslation();
  const { data, error, isPending, refetch, isRefetching } = useProfileSettings();
  const options = useMemo(() => regionOptions(i18n.language), [i18n.language]);
  const [draft, setDraft] = useState<CountryCode | null>(null);
  const save = useAction(updateProfileSettings, { invalidate: [SETTINGS], success: t('settings.region.saved') });
  const current = data?.homeRegion;
  const selected = draft ?? current;
  const label = (code: string) => `${regionName(code, i18n.language)} (${code})`;

  let body;
  if (isPending) body = <Skeleton active title={false} paragraph={{ rows: 2 }} />;
  else if (error || !current)
    body = (
      <Alert
        type="error"
        showIcon
        title={t('settings.region.loadFailed')}
        description={error ? errorText(error, t) : undefined}
        action={
          <Button size="small" loading={isRefetching} onClick={() => void refetch()}>
            {t('settings.region.retry')}
          </Button>
        }
      />
    );
  else
    body = (
      <Space orientation="vertical" size={16} style={{ width: '100%' }}>
        <div className="row-item">
          <div className="row-main">
            <div className="row-title">{t('settings.region.current')}</div>
            <div className="row-sub">{t('settings.region.defaultHint', { region: label(DEFAULT_HOME_REGION) })}</div>
          </div>
          <span className="home-region-current">
            {label(current)}
            {data?.isDefault && <Tag style={{ marginInlineStart: 8, marginInlineEnd: 0 }}>{t('settings.region.isDefault')}</Tag>}
          </span>
        </div>
        <div className="home-region-edit">
          <Select<CountryCode>
            aria-label={t('settings.region.label')}
            showSearch={{ optionFilterProp: 'label' }}
            placeholder={t('settings.region.placeholder')}
            options={options}
            value={selected as CountryCode}
            onChange={setDraft}
            style={{ flex: '1 1 260px', minWidth: 0 }}
          />
          <Button
            type="primary"
            disabled={!draft || draft === current}
            loading={save.isPending}
            onClick={() => draft && save.mutate({ homeRegion: draft }, { onSuccess: () => setDraft(null) })}
          >
            {t('common.save')}
          </Button>
        </div>
        <Alert type="info" showIcon title={t('settings.region.purpose')} description={t('settings.region.history')} />
      </Space>
    );

  return (
    <Card title={t('settings.region.title')} className="home-region-card">
      {body}
    </Card>
  );
}

function GeneralSection() {
  return (
    <Space orientation="vertical" size={16} style={{ width: '100%' }}>
      <HomeRegionCard />
      <DisplayCard />
    </Space>
  );
}

function DisplayCard() {
  const { t, i18n } = useTranslation();
  const { mode, setMode } = useTheme();
  return (
    <Card title={t('settings.general')}>
      <Space orientation="vertical" size={16}>
        <div className="row-item">
          <div className="row-main">
            <div className="row-title">{t('settings.theme')}</div>
          </div>
          <Segmented<ThemeMode>
            value={mode}
            onChange={setMode}
            options={(['dark', 'ultra', 'light'] as const).map((m) => ({ value: m, label: t(`theme.${m}`) }))}
          />
        </div>
        <div className="row-item">
          <div className="row-main">
            <div className="row-title">{t('settings.language')}</div>
          </div>
          <Segmented
            value={i18n.language === 'en' ? 'en' : 'zh-CN'}
            onChange={(v) => setLanguage(v as 'zh-CN' | 'en')}
            options={[
              { value: 'zh-CN', label: '中文' },
              { value: 'en', label: 'English' },
            ]}
          />
        </div>
      </Space>
    </Card>
  );
}

function AboutSection() {
  const { t } = useTranslation();
  const { data } = useSystemInfo();
  return (
    <Card title={t('settings.about')}>
      <Descriptions column={1} size="small">
        <Descriptions.Item label={t('settings.product')}>X-UI</Descriptions.Item>
        <Descriptions.Item label={t('settings.edition')}>{data?.edition ?? '—'}</Descriptions.Item>
        <Descriptions.Item label={t('settings.dbIdentity')}>{data?.database.identity ?? '—'}</Descriptions.Item>
        <Descriptions.Item label={t('settings.dbCreated')}>{data?.database.createdAt ? dayjs(data.database.createdAt).format('YYYY-MM-DD HH:mm') : '—'}</Descriptions.Item>
      </Descriptions>
    </Card>
  );
}

/** 设置: account security (ported from the legacy Security page), display, system info. */
export function SettingsPage() {
  const { t } = useTranslation();
  return (
    <>
      <PageTop title={t('nav.settings')} />
      <Tabs
        items={[
          { key: 'security', label: t('settings.tabs.security'), children: <SecuritySection /> },
          { key: 'general', label: t('settings.tabs.general'), children: <GeneralSection /> },
          { key: 'about', label: t('settings.tabs.about'), children: <AboutSection /> },
        ]}
      />
    </>
  );
}
