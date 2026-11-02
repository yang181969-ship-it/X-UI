import { Card, Descriptions, Segmented, Space, Tabs } from 'antd';
import dayjs from 'dayjs';
import { useTranslation } from 'react-i18next';
import { useSystemInfo } from '../api/hooks.ts';
import { setLanguage } from '../i18n/index.ts';
import { PageTop } from '../layouts/PanelLayout.tsx';
import { useTheme, type ThemeMode } from '../theme/ThemeProvider.tsx';
import { SecuritySection } from './SecuritySection.tsx';

function GeneralSection() {
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
