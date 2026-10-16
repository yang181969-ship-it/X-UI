import { SafetyCertificateOutlined, UsbOutlined } from '@ant-design/icons';
import { useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Divider, Input, Modal, Typography } from 'antd';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { post, setStepUpHandler } from '../api/client.ts';
import { errorText, useMe } from '../api/hooks.ts';
import { isPasskeyCancel, passkeyStepUp } from './webauthn.ts';

/**
 * Global "verify again" dialog. When the API answers STEP_UP_REQUIRED the client calls the
 * registered handler; the request is retried once the user verifies with a passkey or TOTP.
 */
export function StepUpProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data: me } = useMe();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  useEffect(() => {
    setStepUpHandler(
      () =>
        new Promise<boolean>((resolve) => {
          resolver.current?.(false);
          resolver.current = resolve;
          setError(null);
          setCode('');
          setOpen(true);
        }),
    );
    return () => setStepUpHandler(null);
  }, []);

  const finish = (ok: boolean) => {
    setOpen(false);
    resolver.current?.(ok);
    resolver.current = null;
    if (ok) void qc.invalidateQueries({ queryKey: ['me'] });
  };

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      finish(true);
    } catch (e) {
      if (!isPasskeyCancel(e)) setError(errorText(e, t));
    } finally {
      setBusy(false);
    }
  };

  const hasPasskey = (me?.user.passkeyCount ?? 0) > 0;

  return (
    <>
      {children}
      <Modal open={open} title={t('stepUp.title')} footer={null} onCancel={() => finish(false)} width={380} destroyOnHidden centered>
        <Typography.Paragraph type="secondary">{t('stepUp.desc')}</Typography.Paragraph>
        {error && <Alert type="error" title={error} showIcon style={{ marginBottom: 12 }} />}
        {hasPasskey && (
          <>
            <Button type="primary" block size="large" icon={<UsbOutlined />} loading={busy} onClick={() => run(passkeyStepUp)}>
              {t('stepUp.passkey')}
            </Button>
            <Divider plain style={{ margin: '16px 0' }}>
              {t('stepUp.totp')}
            </Divider>
          </>
        )}
        <div style={{ display: 'flex', justifyContent: 'center' }}>
          <Input.OTP
            length={6}
            value={code}
            onChange={(v) => {
              setCode(v);
              if (/^\d{6}$/.test(v)) void run(() => post('/auth/step-up/totp', { code: v }));
            }}
            formatter={(s) => s.replace(/\D/g, '')}
            autoFocus={!hasPasskey}
          />
        </div>
        <Button
          block
          style={{ marginTop: 12 }}
          icon={<SafetyCertificateOutlined />}
          disabled={!/^\d{6}$/.test(code)}
          loading={busy}
          onClick={() => run(() => post('/auth/step-up/totp', { code }))}
        >
          {t('stepUp.verify')}
        </Button>
      </Modal>
    </>
  );
}
