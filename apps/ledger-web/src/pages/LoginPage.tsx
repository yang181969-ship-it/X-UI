import { BulbOutlined, KeyOutlined, LockOutlined, TranslationOutlined, UserOutlined } from '@ant-design/icons';
import { useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Card, Divider, Form, Input, Typography } from 'antd';
import { motion } from 'motion/react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, useLocation, useNavigate } from 'react-router';
import type { MeDto } from '@z-ui/shared';
import { ApiError, post } from '../api/client.ts';
import { errorText, useMe } from '../api/hooks.ts';
import { isPasskeyCancel, passkeyLogin, passkeysSupported } from '../auth/webauthn.ts';
import { setLanguage } from '../i18n/index.ts';
import { Logo } from '../layouts/AppSidebar.tsx';
import { useTheme } from '../theme/ThemeProvider.tsx';

export function AuthBackdrop({ children }: { children: React.ReactNode }) {
  const { cycle } = useTheme();
  const { i18n, t } = useTranslation();
  return (
    <div className="login-page">
      <div className="login-blob b1" />
      <div className="login-blob b2" />
      <div className="login-blob b3" />
      <div className="login-corner">
        <button className="icon-btn" onClick={cycle} aria-label={t('nav.theme')}>
          <BulbOutlined />
        </button>
        <button className="icon-btn" onClick={() => setLanguage(i18n.language === 'en' ? 'zh-CN' : 'en')} aria-label={t('nav.language')}>
          <TranslationOutlined />
        </button>
      </div>
      <motion.div
        style={{ width: '100%', display: 'flex', justifyContent: 'center' }}
        initial={{ opacity: 0, y: 16, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
      >
        {children}
      </motion.div>
    </div>
  );
}

export function LoginPage() {
  const { t } = useTranslation();
  const { data: me } = useMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'passkey' | 'password' | null>(null);
  const [useRecovery, setUseRecovery] = useState(false);
  const from = (location.state as { from?: string } | null)?.from ?? '/';

  if (me) return <Navigate to={from} replace />;

  const done = (m: MeDto) => {
    qc.setQueryData(['me'], m);
    navigate(from, { replace: true });
  };

  const describe = (e: unknown) => {
    if (e instanceof ApiError && e.code === 'LOCKED') {
      const until = (e.details as { until?: number })?.until ?? Date.now();
      return t('auth.locked', { min: Math.max(1, Math.ceil((until - Date.now()) / 60_000)) });
    }
    if (e instanceof ApiError && e.code === 'BAD_CREDENTIALS') return t('auth.invalid');
    return errorText(e, t);
  };

  const onPasskey = async () => {
    setBusy('passkey');
    setError(null);
    try {
      done(await passkeyLogin());
    } catch (e) {
      setError(isPasskeyCancel(e) ? t('auth.passkeyFailed') : describe(e));
    } finally {
      setBusy(null);
    }
  };

  const onPassword = async (v: { username: string; password: string; totp?: string; recoveryCode?: string }) => {
    setBusy('password');
    setError(null);
    try {
      done(await post<MeDto>('/auth/login', useRecovery ? { ...v, totp: undefined } : { ...v, recoveryCode: undefined }));
    } catch (e) {
      setError(describe(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <AuthBackdrop>
      <Card className="login-card" variant="borderless" styles={{ body: { padding: '32px 28px 24px' } }}>
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 10, fontSize: 24, fontWeight: 600 }}>
            <Logo />
            {t('app.name')}
          </div>
          <Typography.Paragraph type="secondary" style={{ margin: '6px 0 0' }}>
            {t('app.tagline')}
          </Typography.Paragraph>
        </div>

        {error && <Alert type="error" title={error} showIcon style={{ marginBottom: 16 }} />}

        {passkeysSupported() && (
          <>
            <Button type="primary" size="large" block icon={<KeyOutlined />} loading={busy === 'passkey'} onClick={onPasskey} style={{ height: 48 }}>
              {t('auth.passkey')}
            </Button>
            <Typography.Text type="secondary" style={{ display: 'block', textAlign: 'center', fontSize: 12, marginTop: 6 }}>
              {t('auth.passkeyHint')}
            </Typography.Text>
            <Divider plain style={{ margin: '20px 0 16px', fontSize: 12 }}>
              {t('auth.or')}
            </Divider>
          </>
        )}

        <Form layout="vertical" requiredMark={false} onFinish={onPassword} autoComplete="on">
          <Form.Item name="username" rules={[{ required: true, message: t('auth.username') }]}>
            <Input prefix={<UserOutlined />} placeholder={t('auth.username')} autoComplete="username" size="large" />
          </Form.Item>
          <Form.Item name="password" rules={[{ required: true, message: t('auth.password') }]}>
            <Input.Password prefix={<LockOutlined />} placeholder={t('auth.password')} autoComplete="current-password" size="large" />
          </Form.Item>
          {useRecovery ? (
            <Form.Item name="recoveryCode" label={t('auth.recovery')} rules={[{ required: true }]}>
              <Input placeholder="xxxxx-xxxxx" autoComplete="off" size="large" />
            </Form.Item>
          ) : (
            <Form.Item name="totp" label={t('auth.totp')} rules={[{ required: true, pattern: /^\d{6}$/, message: '6 digits' }]}>
              <Input.OTP length={6} formatter={(s) => s.replace(/\D/g, '')} size="large" />
            </Form.Item>
          )}
          <Button htmlType="submit" size="large" block loading={busy === 'password'}>
            {t('auth.signIn')}
          </Button>
        </Form>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 14, fontSize: 12 }}>
          <Typography.Link onClick={() => setUseRecovery((v) => !v)}>{useRecovery ? t('auth.useTotp') : t('auth.useRecovery')}</Typography.Link>
        </div>
        <Typography.Paragraph type="secondary" style={{ fontSize: 12, textAlign: 'center', margin: '18px 0 0' }}>
          {t('auth.noAccount')}
          <br />
          {t('auth.secureNote')}
        </Typography.Paragraph>
      </Card>
    </AuthBackdrop>
  );
}
