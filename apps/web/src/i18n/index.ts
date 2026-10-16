import dayjs from 'dayjs';
import 'dayjs/locale/zh-cn';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './en.ts';
import zh from './zh-CN.ts';

const KEY = 'zui-lang';

function initialLang(): string {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'en' || v === 'zh-CN') return v;
  } catch {
    /* ignore */
  }
  return navigator.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
}

export function setLanguage(lang: 'zh-CN' | 'en') {
  void i18n.changeLanguage(lang);
  try {
    localStorage.setItem(KEY, lang);
  } catch {
    /* ignore */
  }
}

i18n.on('languageChanged', (lng) => {
  dayjs.locale(lng === 'en' ? 'en' : 'zh-cn');
  document.documentElement.lang = lng;
});

void i18n.use(initReactI18next).init({
  resources: { 'zh-CN': { translation: zh }, en: { translation: en } },
  lng: initialLang(),
  fallbackLng: 'zh-CN',
  interpolation: { escapeValue: false },
});

export default i18n;
