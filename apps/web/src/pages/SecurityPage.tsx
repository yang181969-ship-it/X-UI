import { CameraOutlined, DeleteOutlined, KeyOutlined, LaptopOutlined, LockOutlined, PlusOutlined, ReloadOutlined, SafetyOutlined } from '@ant-design/icons';
import { useQueryClient } from '@tanstack/react-query';
import { App, Button, Card, Col, Empty, Form, Input, Modal, Row, Space, Table, Tag, Typography } from 'antd';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AuditDto, PasskeyDto, SessionDto } from '@z-ui/shared';
import { del, patch, post } from '../api/client.ts';
import { errorText, useAction, useAudit, useMe, usePasskeys, useRecoveryCount, useSessions } from '../api/hooks.ts';
import { guessDeviceName, isPasskeyCancel, passkeyRegister, passkeysSupported } from '../auth/webauthn.ts';
import { avatarFromFile, UserAvatar } from '../components/UserAvatar.tsx';
import { PageTop } from '../layouts/PanelLayout.tsx';
import { RecoveryCodes, TotpSetup } from './SetupPage.tsx';

dayjs.extend(relativeTime);

const ago = (ms: number | null) => (ms ? dayjs(ms).fromNow() : null);

function PasskeysCard() {
  const { t } = useTranslation();
  const { message, modal } = App.useApp();
  const qc = useQueryClient();
  const { data = [] } = usePasskeys();
  const [busy, setBusy] = useState(false);
  const rename = useAction((v: { id: string; name: string }) => patch(`/auth/passkeys/${encodeURIComponent(v.id)}`, { name: v.name }), { invalidate: ['passkeys'] });
  const remove = useAction((p: PasskeyDto) => del(`/auth/passkeys/${encodeURIComponent(p.id)}`), { invalidate: ['passkeys', 'me'], success: t('common.deleted') });
  const add = async () => {
    setBusy(true);
    try {
      await passkeyRegister(guessDeviceName());
      await qc.invalidateQueries({ queryKey: ['passkeys'] });
      await qc.invalidateQueries({ queryKey: ['me'] });
      void message.success(t('invite.passkeyAdded'));
    } catch (e) {
      if (!isPasskeyCancel(e)) void message.error(errorText(e, t));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card
      title={
        <span>
          <KeyOutlined /> {t('security.passkeys')}
        </span>
      }
      extra={
        passkeysSupported() && (
          <Button type="primary" size="small" icon={<PlusOutlined />} loading={busy} onClick={add}>
            {t('security.addPasskey')}
          </Button>
        )
      }
    >
      <Typography.Paragraph type="secondary">{t('security.passkeysDesc')}</Typography.Paragraph>
      {data.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} />}
      {data.map((p) => (
        <div key={p.id} className="row-item">
          <LaptopOutlined style={{ fontSize: 18 }} />
          <div className="row-main">
            <Typography.Text editable={{ onChange: (name) => name.trim() && name !== p.name && rename.mutate({ id: p.id, name: name.trim() }) }}>{p.name}</Typography.Text>
            <div className="row-sub">
              {t('security.lastUsed')}: {ago(p.lastUsedAt) ?? t('security.never')} {p.backedUp && <Tag color="green">{t('security.synced')}</Tag>}
            </div>
          </div>
          <Button
            size="small"
            type="text"
            danger
            icon={<DeleteOutlined />}
            onClick={() => modal.confirm({ title: t('common.deleteConfirm'), okButtonProps: { danger: true }, onOk: () => remove.mutateAsync(p) })}
          />
        </div>
      ))}
    </Card>
  );
}

function TotpCard() {
  const { t } = useTranslation();
  const { message, modal } = App.useApp();
  const qc = useQueryClient();
  const { data: rec } = useRecoveryCount();
  const [rebind, setRebind] = useState<{ uri: string; secret: string } | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);

  const start = async () => {
    try {
      setRebind(await post('/auth/totp/rebind'));
    } catch (e) {
      void message.error(errorText(e, t));
    }
  };
  const confirm = async (code: string) => {
    setBusy(true);
    try {
      await post('/auth/totp/rebind/confirm', { code });
      setRebind(null);
      void message.success(t('security.rebindDone'));
    } catch (e) {
      void message.error(errorText(e, t));
    } finally {
      setBusy(false);
    }
  };
  const regenerate = () =>
    modal.confirm({
      title: t('security.regenerate'),
      content: t('security.regenerateConfirm'),
      onOk: async () => {
        try {
          const r = await post<{ codes: string[] }>('/auth/recovery-codes');
          setCodes(r.codes);
          await qc.invalidateQueries({ queryKey: ['recovery'] });
        } catch (e) {
          void message.error(errorText(e, t));
        }
      },
    });

  return (
    <Card
      title={
        <span>
          <SafetyOutlined /> {t('security.totp')}
        </span>
      }
    >
      <div className="row-item">
        <div className="row-main">
          <div className="row-title">{t('security.totp')}</div>
          <div className="row-sub">{t('security.totpDesc')}</div>
        </div>
        <Button size="small" onClick={start}>
          {t('security.rebind')}
        </Button>
      </div>
      <div className="row-item">
        <div className="row-main">
          <div className="row-title">{t('security.recovery')}</div>
          <div className="row-sub">{t('security.recoveryRemaining', { n: rec?.remaining ?? 0 })}</div>
        </div>
        <Button size="small" icon={<ReloadOutlined />} onClick={regenerate}>
          {t('security.regenerate')}
        </Button>
      </div>
      <Modal open={!!rebind} title={t('security.rebind')} footer={null} onCancel={() => setRebind(null)} destroyOnHidden width={400}>
        {rebind && <TotpSetup uri={rebind.uri} secret={rebind.secret} busy={busy} onCode={confirm} />}
      </Modal>
      <Modal open={!!codes} title={t('security.recovery')} onCancel={() => setCodes(null)} onOk={() => setCodes(null)} cancelButtonProps={{ style: { display: 'none' } }} destroyOnHidden>
        <Typography.Paragraph>{t('invite.recoveryDesc')}</Typography.Paragraph>
        {codes && <RecoveryCodes codes={codes} />}
      </Modal>
    </Card>
  );
}

function PasswordCard() {
  const { t } = useTranslation();
  const [form] = Form.useForm();
  const change = useAction(
    async (v: { currentPassword: string; newPassword: string }) => {
      await post('/auth/password', v);
      form.resetFields();
    },
    { success: t('security.passwordChanged'), invalidate: ['sessions'] },
  );
  return (
    <Card
      title={
        <span>
          <LockOutlined /> {t('security.password')}
        </span>
      }
    >
      <Form form={form} layout="vertical" requiredMark={false} onFinish={(v) => change.mutate(v)} style={{ maxWidth: 360 }}>
        <Form.Item name="currentPassword" label={t('security.currentPassword')} rules={[{ required: true }]}>
          <Input.Password autoComplete="current-password" />
        </Form.Item>
        <Form.Item name="newPassword" label={t('security.newPassword')} extra={t('invite.passwordRule')} rules={[{ required: true, min: 10, max: 256 }]}>
          <Input.Password autoComplete="new-password" />
        </Form.Item>
        <Button htmlType="submit" loading={change.isPending}>
          {t('security.changePassword')}
        </Button>
      </Form>
    </Card>
  );
}

function SessionsCard() {
  const { t } = useTranslation();
  const { data = [] } = useSessions();
  const revoke = useAction((s: SessionDto) => del(`/auth/sessions/${s.id}`), { invalidate: ['sessions'], success: false });
  return (
    <Card title={t('security.sessions')} styles={{ body: { paddingTop: 4, paddingBottom: 4 } }}>
      {data.map((s) => (
        <div key={s.id} className="row-item">
          <div className="row-main">
            <div className="row-title">
              {t(`security.methods.${s.method}`)} {s.current && <Tag color="green">{t('security.current')}</Tag>}
            </div>
            <div className="row-sub" title={s.userAgent ?? ''}>
              {s.ip ?? '—'} · {ago(s.lastSeenAt)} · {s.userAgent?.slice(0, 60)}
            </div>
          </div>
          {!s.current && (
            <Button size="small" onClick={() => revoke.mutate(s)}>
              {t('security.revoke')}
            </Button>
          )}
        </div>
      ))}
    </Card>
  );
}

function AuditCard() {
  const { t } = useTranslation();
  const { data = [] } = useAudit();
  const color = (a: string) => (a.includes('failure') || a.includes('locked') ? 'red' : a.startsWith('login') ? 'green' : a.includes('reveal') ? 'orange' : 'blue');
  return (
    <Card title={t('security.audit')} styles={{ body: { padding: 0 } }}>
      <Table<AuditDto>
        size="small"
        rowKey="id"
        dataSource={data}
        pagination={{ pageSize: 10, hideOnSinglePage: true }}
        columns={[
          { key: 'at', title: t('common.date'), render: (_, r) => dayjs(r.createdAt).format('YYYY-MM-DD HH:mm:ss'), width: 170 },
          { key: 'action', title: t('common.type'), render: (_, r) => <Tag color={color(r.action)}>{r.action}</Tag> },
          { key: 'ip', title: 'IP', dataIndex: 'ip', responsive: ['md'] },
          { key: 'detail', title: t('common.details'), responsive: ['lg'], render: (_, r) => <span className="muted" style={{ fontSize: 12 }}>{r.detail ? JSON.stringify(r.detail) : ''}</span> },
        ]}
        scroll={{ x: 480 }}
      />
    </Card>
  );
}

/** Profile picture and display name. */
function ProfileCard() {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const qc = useQueryClient();
  const { data: me } = useMe();
  const [name, setName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  if (!me) return null;

  const save = async (body: { displayName?: string; avatar?: string | null }) => {
    setBusy(true);
    try {
      qc.setQueryData(['me'], await patch('/auth/profile', body));
      setName(null);
      void message.success(t('common.saved'));
    } catch (e) {
      void message.error(errorText(e, t));
    } finally {
      setBusy(false);
    }
  };
  const pick = async (file: File | undefined) => {
    if (!file) return;
    try {
      await save({ avatar: await avatarFromFile(file) });
    } catch {
      void message.error(t('security.avatarBad'));
    }
  };

  return (
    <Card>
      <div className="profile-card">
        <UserAvatar user={me.user} size={72} />
        <div className="profile-main">
          <Space.Compact style={{ maxWidth: 320, width: '100%' }}>
            <Input
              aria-label={t('security.displayName')}
              value={name ?? me.user.displayName}
              maxLength={64}
              onChange={(e) => setName(e.target.value)}
              onPressEnter={() => name?.trim() && void save({ displayName: name.trim() })}
            />
            <Button type="primary" disabled={!name?.trim() || name.trim() === me.user.displayName} loading={busy} onClick={() => void save({ displayName: name!.trim() })}>
              {t('common.save')}
            </Button>
          </Space.Compact>
          <div className="muted" style={{ fontSize: 12 }}>
            @{me.user.username}
          </div>
          <Space size={8} wrap>
            <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/heic,image/*" hidden onChange={(e) => void pick(e.target.files?.[0]).then(() => (e.target.value = ''))} />
            <Button size="small" icon={<CameraOutlined />} loading={busy} onClick={() => fileRef.current?.click()}>
              {t('security.changeAvatar')}
            </Button>
            {me.user.avatar && (
              <Button size="small" onClick={() => void save({ avatar: null })}>
                {t('security.removeAvatar')}
              </Button>
            )}
          </Space>
        </div>
      </div>
    </Card>
  );
}

export function SecurityPage() {
  const { t } = useTranslation();
  return (
    <>
      <PageTop title={t('security.title')} />
      <Row gutter={[16, 16]}>
        <Col xs={24}>
          <ProfileCard />
        </Col>
        <Col xs={24} xl={12}>
          <Space orientation="vertical" size={16} style={{ width: '100%' }}>
            <PasskeysCard />
            <TotpCard />
            <PasswordCard />
          </Space>
        </Col>
        <Col xs={24} xl={12}>
          <Space orientation="vertical" size={16} style={{ width: '100%' }}>
            <SessionsCard />
            <AuditCard />
          </Space>
        </Col>
      </Row>
    </>
  );
}
