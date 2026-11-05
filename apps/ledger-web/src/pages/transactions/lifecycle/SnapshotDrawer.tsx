import { Alert, Button, ConfigProvider, Descriptions, Drawer, Form, Input, Select, Space, Tag, Typography } from 'antd';
import { REASON_MAX, type SnapshotCorrection, type TransactionDto } from '@xui/ledger-shared';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PendingWriteBanner } from '../../../components/PendingWriteBanner.tsx';
import { buildSnapshotRequest, previewSnapshotClassification, snapshotChanges, type SnapshotDraft } from '../../../lib/lifecycle.ts';
import { regionOptions } from '../../../lib/regions.ts';
import { OVERLAY_Z, useNarrow } from '../../../lib/useMedia.ts';
import type { DraftIssue } from '../../../lib/txnDraft.ts';
import { issueMap, useFieldStatus, useIssueText } from '../form/issues.ts';
import { DirectionMark } from '../txnDisplay.tsx';
import { useRegion } from '../TxnFacts.tsx';
import { ConflictPanel, LifecycleErrorAlert, useLifecycleWrite } from './useLifecycleWrite.tsx';

/**
 * Snapshot correction (P5, API_SPEC §5.7, kind snapshot_correction): the home-region snapshot
 * and / or an entry's jurisdiction snapshot of THIS transaction, with a reason. Amounts, currencies
 * and directions cannot change here. Step 2 shows old → new and the classification the shared
 * classify() predicts — labelled as a preview: the server recomputes it, and a confirmed-domestic
 * result is refused there (the preview never bypasses that; the user is pointed to voiding).
 */
export function SnapshotDrawer({ txn, open, onClose, onVoid }: { txn: TransactionDto; open: boolean; onClose: () => void; onVoid: () => void }) {
  const { t } = useTranslation();
  const narrow = useNarrow();
  return (
    <Drawer open={open} onClose={onClose} size={narrow ? '100%' : 680} title={t('transactions.lifecycle.snapshotTitle')} className="txn-snapshot-drawer" destroyOnHidden zIndex={OVERLAY_Z}>
      {open && <SnapshotForm txn={txn} onClose={onClose} onVoid={onVoid} />}
    </Drawer>
  );
}

function SnapshotForm({ txn, onClose, onVoid }: { txn: TransactionDto; onClose: () => void; onVoid: () => void }) {
  const { t, i18n } = useTranslation();
  const region = useRegion();
  const lw = useLifecycleWrite({ txn, operation: 'transaction.correct', onSaved: onClose, onTerminal: onClose });
  const { writer } = lw;
  const [base, setBase] = useState(txn.currentRevision);
  const [draft, setDraft] = useState<SnapshotDraft>({ homeRegion: null, countries: {} });
  const [reason, setReason] = useState('');
  const [step, setStep] = useState<'edit' | 'confirm'>('edit');
  const [issues, setIssues] = useState<DraftIssue[]>([]);
  const countries = useMemo(() => regionOptions(i18n.language), [i18n.language]);

  useEffect(() => {
    const body = writer.pending?.body as SnapshotCorrection | undefined;
    if (!writer.restored || body?.kind !== 'snapshot_correction') return;
    setBase(body.baseRevision);
    setReason(body.reason);
    setDraft({ homeRegion: body.homeRegion, countries: Object.fromEntries(body.entries.map((e) => [e.direction, e.fundingAccountCountry])) });
    setStep('confirm');
  }, [writer.restored, writer.pending]);

  const map = issueMap([...issues, ...lw.serverIssues]);
  const status = useFieldStatus(map);
  const issueText = useIssueText();
  const locked = writer.locked;
  const changes = snapshotChanges(txn.event, txn.entries, draft);
  const before = txn.event;
  const after = previewSnapshotClassification(txn.txnType, txn.event, txn.entries, draft);
  const scope = (c: { merchantScope: string | null; transferScope: string | null }) =>
    c.merchantScope !== null ? t(`transactions.merchantScopes.${c.merchantScope}`) : c.transferScope !== null ? t(`transactions.transferScopes.${c.transferScope}`) : '—';

  const next = () => {
    const built = buildSnapshotRequest(txn.event, txn.entries, draft, { baseRevision: base, reason });
    if (!built.ok) {
      setIssues(built.issues);
      return;
    }
    setIssues([]);
    setStep('confirm');
  };
  const submit = async () => {
    const built = buildSnapshotRequest(txn.event, txn.entries, draft, { baseRevision: base, reason });
    if (!built.ok) {
      setIssues(built.issues);
      setStep('edit');
      return;
    }
    await lw.submit(built.body);
  };

  return (
    <div className="txn-lifecycle-form" data-kind="snapshot" data-step={step} data-base={base}>
      <Typography.Paragraph type="secondary">{t('transactions.lifecycle.snapshotIntro')}</Typography.Paragraph>
      <PendingWriteBanner writer={writer} onRetry={() => void lw.retry()} checkHref={`/transactions/${txn.id}`} />
      {lw.error?.code === 'REVISION_CONFLICT' && (
        <ConflictPanel
          txn={txn}
          baseRevision={base}
          currentRevision={lw.error.currentRevision}
          onRebase={() => {
            setBase(txn.currentRevision);
            setStep('edit');
            lw.clear();
          }}
        />
      )}
      <LifecycleErrorAlert error={lw.error} issues={(map.get('form') ?? []).map(issueText)} onVoid={onVoid} />
      <ConfigProvider componentDisabled={locked}>
        {step === 'edit' ? (
          <Form layout="vertical" onFinish={next} disabled={locked}>
            <Form.Item label={t('transactions.lifecycle.newHomeRegion')} extra={t('transactions.lifecycle.currentValue', { value: region(txn.event.homeRegion) })}>
              <Select<string>
                allowClear
                showSearch={{ optionFilterProp: 'label' }}
                aria-label={t('transactions.lifecycle.newHomeRegion')}
                placeholder={t('transactions.lifecycle.keep')}
                value={draft.homeRegion ?? undefined}
                onChange={(v) => setDraft((d) => ({ ...d, homeRegion: v ?? null }))}
                options={countries}
                disabled={locked}
              />
            </Form.Item>
            {txn.entries.map((e) => (
              <Form.Item
                key={e.entryId}
                label={
                  <span>
                    <DirectionMark direction={e.direction} /> {e.account.name} · {t('transactions.lifecycle.newEntryCountry')}
                  </span>
                }
                extra={t('transactions.lifecycle.currentValue', { value: region(e.fundingAccountCountry) })}
              >
                <Select<string>
                  allowClear
                  showSearch={{ optionFilterProp: 'label' }}
                  aria-label={`${t('transactions.lifecycle.newEntryCountry')} · ${e.direction}`}
                  placeholder={t('transactions.lifecycle.keep')}
                  value={draft.countries[e.direction] ?? undefined}
                  onChange={(v) => setDraft((d) => ({ ...d, countries: { ...d.countries, [e.direction]: v ?? null } }))}
                  options={countries}
                  disabled={locked}
                />
              </Form.Item>
            ))}
            <Form.Item label={t('transactions.lifecycle.reason')} required {...status('reason')}>
              <Input.TextArea aria-label={t('transactions.lifecycle.reason')} value={reason} onChange={(ev) => setReason(ev.target.value)} maxLength={REASON_MAX} showCount autoSize={{ minRows: 2 }} disabled={locked} />
            </Form.Item>
            {map.get('form')?.some((i) => i.code === 'noSnapshotChange') && <Alert type="error" showIcon className="form-alert" title={t('transactions.form.issues.noSnapshotChange')} />}
            <Space className="txn-lifecycle-actions">
              <Button onClick={onClose} className="txn-cancel">
                {t('transactions.detail.cancel')}
              </Button>
              <Button type="primary" htmlType="submit" disabled={locked} className="txn-next">
                {t('transactions.lifecycle.reviewChanges')}
              </Button>
            </Space>
          </Form>
        ) : (
          <div className="txn-snapshot-confirm">
            <Typography.Title level={5}>{t('transactions.lifecycle.oldToNew')}</Typography.Title>
            <Descriptions column={1} size="small" bordered className="txn-snapshot-changes">
              {changes.homeRegion !== null && (
                <Descriptions.Item label={t('transactions.detail.homeRegion')}>
                  <span data-change="homeRegion">
                    {region(txn.event.homeRegion)} → <strong>{region(changes.homeRegion)}</strong>
                  </span>
                </Descriptions.Item>
              )}
              {changes.entries.map((c) => {
                const e = txn.entries.find((x) => x.direction === c.direction)!;
                return (
                  <Descriptions.Item key={c.direction} label={`${e.account.name} · ${t('transactions.detail.entryCountry')}`}>
                    <span data-change={`entry.${c.direction}`}>
                      {region(e.fundingAccountCountry)} → <strong>{region(c.fundingAccountCountry)}</strong>
                    </span>
                  </Descriptions.Item>
                );
              })}
              <Descriptions.Item label={t('transactions.lifecycle.reason')}>{reason.trim()}</Descriptions.Item>
            </Descriptions>
            <Typography.Title level={5}>
              {t('transactions.lifecycle.classificationPreview')} <Tag color="gold">{t('transactions.lifecycle.previewTag')}</Tag>
            </Typography.Title>
            <Descriptions column={1} size="small" bordered className="txn-classification-preview">
              <Descriptions.Item label={t('transactions.detail.foreignStatus')}>
                <span data-preview="foreignStatus">
                  {t(`transactions.foreignStatus.${before.foreignStatus}`)} → <strong>{t(`transactions.foreignStatus.${after.foreignStatus}`)}</strong>
                </span>
              </Descriptions.Item>
              <Descriptions.Item label={t(before.merchantScope !== null ? 'transactions.detail.merchantScope' : 'transactions.detail.transferScope')}>
                <span data-preview="scope">
                  {scope(before)} → <strong>{scope(after)}</strong>
                </span>
              </Descriptions.Item>
            </Descriptions>
            <Typography.Paragraph type="secondary" className="field-note">
              {t('transactions.lifecycle.previewNote')}
            </Typography.Paragraph>
            {after.foreignStatus === 'domestic' && <Alert type="warning" showIcon className="form-alert txn-preview-domestic" title={t('transactions.lifecycle.previewDomestic')} />}
            <Space className="txn-lifecycle-actions" wrap>
              <Button onClick={() => setStep('edit')} disabled={locked} className="txn-back">
                {t('transactions.lifecycle.back')}
              </Button>
              <Button type="primary" onClick={() => void submit()} disabled={locked} loading={writer.pending?.state === 'sending'} className="txn-submit">
                {t('transactions.lifecycle.snapshotSubmit')}
              </Button>
            </Space>
          </div>
        )}
      </ConfigProvider>
    </div>
  );
}
