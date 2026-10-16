import { CopyOutlined, DownloadOutlined, KeyOutlined } from '@ant-design/icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App, Button, Card, Form, Input, QRCode, Result, Spin, Steps, Typography } from 'antd';
import { AnimatePresence, motion } from 'motion/react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router';
import type { MeDto } from '@z-ui/shared';
import { get, post } from '../api/client.ts';
import { errorText } from '../api/hooks.ts';
import { guessDeviceName, isPasskeyCancel, passkeyRegister, passkeysSupported } from '../auth/webauthn.ts';
import { AuthBackdrop } from './LoginPage.tsx';

export function RecoveryCodes({ codes }: { codes: string[] }) {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const text = codes.join('\n');
  return (
    <>
      <div className="recovery-grid">
        {codes.map((c) => (
          <span key={c}>{c}</span>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <Button
          icon={<CopyOutlined />}
          onClick={() => navigator.clipboard.writeText(text).then(() => message.success(t('common.copied')))}
        >
          {t('common.copy')}
        </Button>
        <Button
          icon={<DownloadOutlined />}
          onClick={() => {
            const a = document.createElement('a');
            a.href = URL.createObjectURL(new Blob([`Z-UI recovery codes\n\n${text}\n`], { type: 'text/plain' }));
            a.download = 'z-ui-recovery-codes.txt';
            a.click();
            URL.revokeObjectURL(a.href);
          }}
        >
          {t('invite.download')}
        </Button>
      </div>
    </>
  );
}

/** QR + manual key + 6-digit input, shared by invite and "re-bind authenticator". */
export function TotpSetup({ uri, secret, onCode, busy }: { uri: string; secret: string; onCode: (code: string) => void; busy?: boolean }) {
  const { t } = useTranslation();
  const [code, setCode] = useState('');
  return (
    <div>
      <Typography.Paragraph>{t('invite.scan')}</Typography.Paragraph>
      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 12 }}>
        <QRCode value={uri} size={188} bgColor="#ffffff" color="#000000" />
      </div>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, textAlign: 'center' }}>
        {t('invite.manualKey')}
        <br />
        <Typography.Text code copyable style={{ fontSize: 12 }}>
          {secret}
        </Typography.Text>
      </Typography.Paragraph>
      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 12 }}>
        <Input.OTP length={6} value={code} onChange={setCode} formatter={(s) => s.replace(/\D/g, '')} size="large" autoFocus />
      </div>
      <Button type="primary" block size="large" disabled={!/^\d{6}$/.test(code)} loading={busy} onClick={() => onCode(code)}>
        {t('common.confirm')}
      </Button>
    </div>
  );
}

/** One-time first-run setup (/setup/:token): creates the single account. */
export function SetupPage() {
  const { token = '' } = useParams();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { message } = App.useApp();
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [totp, setTotp] = useState<{ uri: string; secret: string } | null>(null);
  const [codes, setCodes] = useState<string[]>([]);
  const [me, setMe] = useState<MeDto | null>(null);

  const info = useQuery({
    queryKey: ['setup', token],
    queryFn: () => get<{ valid: boolean }>(`/setup/${token}`),
    retry: false,
  });

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      if (!isPasskeyCancel(e)) setError(errorText(e, t));
    } finally {
      setBusy(false);
    }
  };

  const finish = () => {
    if (me) qc.setQueryData(['me'], me);
    navigate('/', { replace: true });
  };

  if (info.isLoading) {
    return (
      <AuthBackdrop>
        <Spin size="large" />
      </AuthBackdrop>
    );
  }
  if (!info.data?.valid) {
    return (
      <AuthBackdrop>
        <Card className="login-card" variant="borderless">
          <Result
            status="warning"
            title={t('setup.invalid')}
            subTitle={t('setup.invalidDesc')}
            extra={
              <Button type="primary" onClick={() => navigate('/login')}>
                {t('auth.signIn')}
              </Button>
            }
          />
        </Card>
      </AuthBackdrop>
    );
  }

  const steps = [t('invite.stepAccount'), t('invite.stepTotp'), t('invite.stepRecovery'), t('invite.stepPasskey')];

  return (
    <AuthBackdrop>
      <Card className="login-card" variant="borderless" style={{ maxWidth: 460 }} styles={{ body: { padding: '28px 28px 24px' } }}>
        <Typography.Title level={4} style={{ marginTop: 0 }}>
          {t('setup.title')}
        </Typography.Title>
        <Typography.Paragraph type="secondary">{t('setup.desc')}</Typography.Paragraph>
        <Steps size="small" current={step} items={steps.map((title) => ({ title }))} style={{ margin: '8px 0 24px' }} />
        {error && <Alert type="error" title={error} showIcon style={{ marginBottom: 16 }} />}

        <AnimatePresence mode="wait">
          <motion.div key={step} initial={{ opacity: 0, x: 24 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -24 }} transition={{ duration: 0.22 }}>
            {step === 0 && (
              <Form
                layout="vertical"
                requiredMark={false}
                onFinish={(v: { username: string; displayName: string; password: string }) =>
                  run(async () => {
                    setTotp(await post(`/setup/${token}/begin`, { username: v.username, displayName: v.displayName, password: v.password }));
                    setStep(1);
                  })
                }
              >
                <Form.Item name="username" label={t('auth.username')} extra={t('invite.usernameRule')} rules={[{ required: true, pattern: /^[a-zA-Z0-9_.-]{3,32}$/ }]}>
                  <Input autoComplete="username" />
                </Form.Item>
                <Form.Item name="displayName" label={t('invite.displayName')} rules={[{ required: true, max: 32 }]}>
                  <Input />
                </Form.Item>
                <Form.Item name="password" label={t('auth.password')} extra={t('invite.passwordRule')} rules={[{ required: true, min: 10, max: 256 }]}>
                  <Input.Password autoComplete="new-password" />
                </Form.Item>
                <Form.Item
                  name="repeat"
                  label={t('invite.passwordRepeat')}
                  dependencies={['password']}
                  rules={[
                    { required: true },
                    ({ getFieldValue }) => ({
                      validator: (_, v) => (v === getFieldValue('password') ? Promise.resolve() : Promise.reject(new Error(t('invite.passwordMismatch')))),
                    }),
                  ]}
                >
                  <Input.Password autoComplete="new-password" />
                </Form.Item>
                <Button type="primary" htmlType="submit" block size="large" loading={busy}>
                  {t('common.next')}
                </Button>
              </Form>
            )}

            {step === 1 && totp && (
              <TotpSetup
                uri={totp.uri}
                secret={totp.secret}
                busy={busy}
                onCode={(code) =>
                  run(async () => {
                    const r = await post<{ recoveryCodes: string[]; me: MeDto }>(`/setup/${token}/confirm`, { code });
                    setCodes(r.recoveryCodes);
                    setMe(r.me);
                    setStep(2);
                  })
                }
              />
            )}

            {step === 2 && (
              <div>
                <Typography.Paragraph>{t('invite.recoveryDesc')}</Typography.Paragraph>
                <RecoveryCodes codes={codes} />
                <Button type="primary" block size="large" style={{ marginTop: 20 }} onClick={() => setStep(3)}>
                  {t('invite.recoverySaved')}
                </Button>
              </div>
            )}

            {step === 3 && (
              <div>
                <Typography.Paragraph>{t('invite.passkeyDesc')}</Typography.Paragraph>
                {passkeysSupported() && (
                  <Button
                    type="primary"
                    block
                    size="large"
                    icon={<KeyOutlined />}
                    loading={busy}
                    onClick={() =>
                      run(async () => {
                        await passkeyRegister(guessDeviceName());
                        void message.success(t('invite.passkeyAdded'));
                        finish();
                      })
                    }
                  >
                    {t('invite.addPasskey')}
                  </Button>
                )}
                <Button block size="large" style={{ marginTop: 10 }} onClick={finish}>
                  {passkeysSupported() ? t('common.skip') : t('invite.finish')}
                </Button>
              </div>
            )}
          </motion.div>
        </AnimatePresence>
      </Card>
    </AuthBackdrop>
  );
}
