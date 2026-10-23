import { CheckCircleFilled, ClockCircleOutlined, RetweetOutlined, SlidersOutlined, WarningOutlined } from '@ant-design/icons';
import { Tag, Tooltip } from 'antd';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { TransactionDto, VerificationStatus } from '@z-ui/shared';
import { colorFor, useLookups } from '../lib/format.ts';
import { MoneyText } from './Money.tsx';

const VERIFICATION_ICONS: Record<VerificationStatus, ReactNode> = {
  verified: <CheckCircleFilled style={{ color: 'var(--ant-color-success)' }} />,
  partial: <WarningOutlined style={{ color: 'var(--ant-color-warning)' }} />,
  pending: <ClockCircleOutlined className="muted" />,
};

/** Small icon for a transaction's verification status (nothing when not marked). */
export function VerificationMark({ status }: { status: VerificationStatus | null }) {
  const { t } = useTranslation();
  if (!status) return null;
  return (
    <Tooltip title={t(`tx.verification.${status}`)}>
      <span style={{ marginInlineStart: 6, fontSize: 12 }}>{VERIFICATION_ICONS[status]}</span>
    </Tooltip>
  );
}

/** "2026-10-20 14:30" — the time only when one was recorded. */
export const txWhen = (tx: TransactionDto) => (tx.occurredTime ? `${tx.occurredAt} ${tx.occurredTime}` : tx.occurredAt);

/** Compact transaction line used on the dashboard and in account details. */
export function TxRow({ tx, onClick }: { tx: TransactionDto; onClick?: () => void }) {
  const { t } = useTranslation();
  const L = useLookups();
  const cat = tx.categoryId ? L.cat.get(tx.categoryId) : undefined;
  const title =
    tx.type === 'transfer'
      ? tx.amount < 0
        ? t('tx.transferTo', { name: L.accountLabel(tx.counterpartAccountId) })
        : t('tx.transferFrom', { name: L.accountLabel(tx.counterpartAccountId) })
      : tx.counterparty || cat?.name || t(`tx.types.${tx.type}`);
  const color = tx.type === 'transfer' ? '#8c8c8c' : tx.type === 'adjustment' ? '#d48806' : (cat?.color ?? colorFor(title));
  return (
    <div className={`row-item ${onClick ? 'clickable' : ''}`} onClick={onClick}>
      <span className="avatar-icon" style={{ background: color }}>
        {tx.type === 'transfer' ? <RetweetOutlined /> : tx.type === 'adjustment' ? <SlidersOutlined /> : (cat?.name ?? title).slice(0, 1)}
      </span>
      <div className="row-main">
        <div className="row-title">
          {title}
          <VerificationMark status={tx.verificationStatus} />
        </div>
        <div className="row-sub">
          {txWhen(tx)} · {L.accountLabel(tx.accountId)}
          {tx.purpose ? ` · ${tx.purpose}` : ''}
          {tx.note ? ` · ${tx.note}` : ''}
        </div>
      </div>
      <div style={{ textAlign: 'right' }}>
        <MoneyText minor={tx.amount} currency={tx.currency} signed colored style={{ fontWeight: 600 }} />
        <div>
          {tx.tagIds.slice(0, 2).map((id) => (
            <Tag key={id} style={{ marginInlineEnd: 0, marginInlineStart: 4, fontSize: 11 }} color={L.tag.get(id)?.color ?? undefined}>
              {L.tag.get(id)?.name}
            </Tag>
          ))}
        </div>
      </div>
    </div>
  );
}
