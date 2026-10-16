import { App as AntApp, ConfigProvider, theme as antdTheme, type ThemeConfig } from 'antd';
import enUS from 'antd/locale/en_US';
import zhCN from 'antd/locale/zh_CN';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Three modes, mirroring 3x-ui: light, dark and ultra-dark (pure black for OLED).
 * Token values are taken from 3x-ui's frontend/src/hooks/useTheme.tsx.
 */
export type ThemeMode = 'light' | 'dark' | 'ultra';
const STORAGE_KEY = 'zui-theme';

const LIGHT_TOKENS: ThemeConfig['token'] = {
  colorTextDescription: 'rgba(0, 0, 0, 0.58)',
  colorTextTertiary: 'rgba(0, 0, 0, 0.58)',
  colorTextPlaceholder: '#767676',
  colorError: '#cf1322',
  colorErrorText: '#cf1322',
  colorSuccessText: '#237804',
  colorBgLayout: '#e6e8ec',
};

const DARK_TOKENS: ThemeConfig['token'] = {
  colorBgBase: '#1a1b1f',
  colorBgLayout: '#1a1b1f',
  colorBgContainer: '#23252b',
  colorBgElevated: '#2d2f37',
};

const ULTRA_TOKENS: ThemeConfig['token'] = {
  colorBgBase: '#000',
  colorBgLayout: '#000',
  colorBgContainer: '#101013',
  colorBgElevated: '#1a1a1e',
};

function components(mode: ThemeMode): ThemeConfig['components'] {
  const common = { Statistic: { contentFontSize: 17, titleFontSize: 11 } };
  if (mode === 'light') {
    return {
      ...common,
      Button: { colorPrimary: '#0958d9', colorPrimaryHover: '#2468e5', colorPrimaryActive: '#073ea8' },
      Layout: { siderBg: '#ffffff', bodyBg: '#e6e8ec' },
    };
  }
  const ultra = mode === 'ultra';
  return {
    ...common,
    Layout: {
      bodyBg: ultra ? '#000' : '#1a1b1f',
      headerBg: ultra ? '#050507' : '#15161a',
      headerColor: '#ffffff',
      footerBg: ultra ? '#000' : '#1a1b1f',
      siderBg: ultra ? '#050507' : '#15161a',
      triggerBg: ultra ? '#1a1a1e' : '#23252b',
      triggerColor: '#ffffff',
    },
    Menu: {
      darkItemBg: ultra ? '#050507' : '#15161a',
      darkSubMenuItemBg: ultra ? '#000' : '#1a1b1f',
      darkPopupBg: ultra ? '#101013' : '#23252b',
    },
    Card: { colorBorderSecondary: ultra ? 'rgba(255, 255, 255, 0.04)' : 'rgba(255, 255, 255, 0.06)' },
  };
}

export function readStoredMode(): ThemeMode {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'light' || v === 'dark' || v === 'ultra') return v;
  } catch {
    /* storage unavailable */
  }
  return 'dark';
}

/** Apply the mode to <html>/<body> — also called before React mounts to avoid a flash. */
export function applyDom(mode: ThemeMode) {
  const html = document.documentElement;
  html.dataset.theme = mode === 'ultra' ? 'ultra-dark' : mode;
  html.style.colorScheme = mode === 'light' ? 'light' : 'dark';
  document.body.classList.toggle('dark', mode !== 'light');
  document.body.classList.toggle('light', mode === 'light');
}

interface ThemeCtx {
  mode: ThemeMode;
  isDark: boolean;
  setMode: (m: ThemeMode) => void;
  /** dark → ultra → light → dark, like 3x-ui's theme button. */
  cycle: () => void;
}

const Ctx = createContext<ThemeCtx | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(readStoredMode);
  const { i18n } = useTranslation();

  const setMode = useCallback((m: ThemeMode) => {
    // Briefly disable transitions so the whole page switches at once.
    document.documentElement.dataset.themeSwitching = '1';
    applyDom(m);
    setModeState(m);
    try {
      localStorage.setItem(STORAGE_KEY, m);
    } catch {
      /* ignore */
    }
    requestAnimationFrame(() => requestAnimationFrame(() => delete document.documentElement.dataset.themeSwitching));
  }, []);

  const cycle = useCallback(() => setMode(mode === 'dark' ? 'ultra' : mode === 'ultra' ? 'light' : 'dark'), [mode, setMode]);

  const config = useMemo<ThemeConfig>(
    () => ({
      algorithm: mode === 'light' ? antdTheme.defaultAlgorithm : antdTheme.darkAlgorithm,
      token: {
        ...(mode === 'light' ? LIGHT_TOKENS : mode === 'ultra' ? ULTRA_TOKENS : DARK_TOKENS),
        fontFamily:
          "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', Roboto, 'Helvetica Neue', Arial, sans-serif",
        motionDurationMid: '0.2s',
        motionDurationSlow: '0.28s',
      },
      components: components(mode),
      cssVar: { key: 'zui' },
      hashed: false,
    }),
    [mode],
  );

  const value = useMemo(() => ({ mode, isDark: mode !== 'light', setMode, cycle }), [mode, setMode, cycle]);

  return (
    <Ctx.Provider value={value}>
      <ConfigProvider theme={config} locale={i18n.language === 'en' ? enUS : zhCN}>
        <AntApp message={{ duration: 1.6, maxCount: 3 }}>{children}</AntApp>
      </ConfigProvider>
    </Ctx.Provider>
  );
}

export function useTheme(): ThemeCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useTheme outside ThemeProvider');
  return v;
}
