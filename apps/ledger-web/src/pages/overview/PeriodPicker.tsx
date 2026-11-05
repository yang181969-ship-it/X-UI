import { DatePicker, Segmented, Select, Typography } from 'antd';
import dayjs from 'dayjs';
import { useTranslation } from 'react-i18next';
import { PERIOD_PRESETS, presetPeriod, type Period, type PeriodKind } from '../../lib/period.ts';

const DAY = 'YYYY-MM-DD';
const KINDS: PeriodKind[] = [...PERIOD_PRESETS, 'custom'];

/** The period's dates as text: "2026-01-01 至 2026-12-31", "全部期间", open-ended custom ranges. */
export function PeriodText({ period }: { period: Period }) {
  const { t } = useTranslation();
  const { from, to } = period;
  const text = from && to ? t('overview.period.range', { from, to }) : from ? t('overview.period.since', { from }) : to ? t('overview.period.until', { to }) : t('overview.period.allTime');
  return <span className="num overview-period-text">{text}</span>;
}

/**
 * Presets (this month … all) and a custom range. Choosing "custom" keeps the current dates until a
 * range is picked; the range picker only accepts complete ranges. Desktop: a segmented control;
 * phones: a select.
 */
export function PeriodPicker({ period, today, narrow, onChange }: { period: Period; today: string; narrow: boolean; onChange: (p: Period) => void }) {
  const { t } = useTranslation();
  const choose = (kind: PeriodKind) => onChange(kind === 'custom' ? { ...period, kind: 'custom' } : presetPeriod(kind, today));
  const options = KINDS.map((k) => ({ value: k, label: t(`overview.period.${k}`) }));
  return (
    <div className="overview-period">
      {narrow ? (
        <Select<PeriodKind> className="overview-period-select" aria-label={t('overview.period.label')} value={period.kind} onChange={choose} options={options} />
      ) : (
        <Segmented<PeriodKind> className="overview-period-presets" aria-label={t('overview.period.label')} value={period.kind} onChange={choose} options={options} />
      )}
      {period.kind === 'custom' && (
        <DatePicker.RangePicker
          className="overview-period-range"
          format={DAY}
          allowClear={false}
          value={period.from && period.to ? [dayjs(period.from), dayjs(period.to)] : null}
          onChange={(v) => {
            const [a, b] = v ?? [];
            if (a && b) onChange({ kind: 'custom', from: a.format(DAY), to: b.format(DAY) });
          }}
        />
      )}
      <Typography.Text type="secondary" className="overview-period-note">
        <PeriodText period={period} /> · {t('overview.period.basis')}
      </Typography.Text>
    </div>
  );
}
