import { ExclamationCircleOutlined } from '@ant-design/icons';
import { Alert, App, Button, Space, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import type { PendingWriteApi } from '../lib/usePendingWrite.ts';
import { OVERLAY_Z } from '../lib/useMedia.ts';

/**
 * The state of a financial write whose outcome is not confirmed (M3-B4-C / B4-D), the same for
 * create, corrections and void: in flight; automatic retries running (no manual action: it would
 * race them); unknown after the retries or restored after a reload — retry the original request, or
 * abandon it after a warning to check the list first.
 */
export function PendingWriteBanner({ writer, onRetry, onAbandoned, checkHref }: { writer: PendingWriteApi<unknown>; onRetry: () => void; onAbandoned?: () => void; checkHref: string }) {
  const { t } = useTranslation();
  const { modal } = App.useApp();
  const { pending, running, restored } = writer;
  const sending = pending?.state === 'sending';
  const unknown = pending?.state === 'unknown';
  if (!sending && !unknown) return null;

  const abandon = () =>
    modal.confirm({
      title: t('transactions.form.abandonTitle'),
      icon: <ExclamationCircleOutlined />,
      className: 'txn-abandon-confirm',
      // Opened from inside a drawer / dialog (OVERLAY_Z): it must come above it.
      zIndex: OVERLAY_Z + 100,
      content: (
        <>
          <Typography.Paragraph>{t('transactions.form.abandonContent')}</Typography.Paragraph>
          {/* A plain link: antd's modal.confirm renders outside the router (a <Link> would throw). */}
          <a href={checkHref} target="_blank" rel="noopener" className="txn-check-list">
            {t('transactions.form.checkList')}
          </a>
        </>
      ),
      okText: t('transactions.form.abandonOk'),
      okButtonProps: { danger: true },
      onOk: () => {
        writer.abandon();
        onAbandoned?.();
      },
    });

  return (
    <Alert
      type="warning"
      showIcon
      className="form-alert txn-unknown"
      data-state={running && unknown ? 'retrying' : pending?.state}
      title={
        sending
          ? t('transactions.form.sending', { n: pending?.attempts ?? 1 })
          : running
            ? t('transactions.form.autoRetrying', { n: pending?.attempts ?? 1 })
            : restored
              ? t('transactions.form.unknownRestoredTitle')
              : t('transactions.form.unknownTitle')
      }
      description={
        !sending &&
        !running && (
          <>
            <Typography.Paragraph>{t('transactions.form.unknownContent', { n: pending?.attempts ?? 0 })}</Typography.Paragraph>
            <Space wrap>
              <Button type="primary" onClick={onRetry} className="txn-retry">
                {t('transactions.form.retry')}
              </Button>
              <Button danger onClick={abandon} className="txn-abandon">
                {t('transactions.form.abandon')}
              </Button>
            </Space>
          </>
        )
      }
    />
  );
}
