import { BarChartOutlined, TableOutlined } from '@ant-design/icons';
import { Alert, Card, Col, DatePicker, Empty, Row, Segmented, Select, Space, Statistic, Switch, Table, Tag } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { fromMinor, INVEST_CATEGORY } from '@z-ui/shared';
import { useStats } from '../api/hooks.ts';
import { GroupedColumns, Legend, RankBars, type RankRow, type Series } from '../components/Charts.tsx';
import { PageTop } from '../layouts/PanelLayout.tsx';
import { readSummaryCurrency, useDecimals, useLocale, useLookups, useMoney } from '../lib/format.ts';

const INVEST_KEY = 'zui-stats-invest';
const ALL = '__all';



type Preset = 'thisMonth' | 'last3' | 'last12' | 'thisYear' | 'lastYear';
const PRESETS: Preset[] = ['thisMonth', 'last3', 'last12', 'thisYear', 'lastYear'];

function presetRange(p: Preset): [Dayjs, Dayjs] {
  const now = dayjs();
  switch (p) {
    case 'thisMonth':
      return [now.startOf('month'), now.endOf('month')];
    case 'last3':
      return [now.subtract(2, 'month').startOf('month'), now.endOf('month')];
    case 'last12':
      return [now.subtract(11, 'month').startOf('month'), now.endOf('month')];
    case 'thisYear':
      return [now.startOf('year'), now.endOf('year')];
    case 'lastYear':
      return [now.subtract(1, 'year').startOf('year'), now.subtract(1, 'year').endOf('year')];
  }
}

export function StatsPage() {
  const { t } = useTranslation();
  const L = useLookups();
  const money = useMoney();
  const decimals = useDecimals();
  const locale = useLocale();

  const [preset, setPreset] = useState<Preset | null>('last12');
  const [range, setRange] = useState<[Dayjs, Dayjs]>(() => presetRange('last12'));
  const [institutionId, setInstitutionId] = useState<string | undefined>();
  const [currency, setCurrency] = useState<string | undefined>();
  const [monthView, setMonthView] = useState<'chart' | 'table'>('chart');
  // Realized stock gains/losses count as income/expense unless switched off (remembered).
  const [withInvest, setWithInvest] = useState(() => {
    try {
      return localStorage.getItem(INVEST_KEY) !== '0';
    } catch {
      return true;
    }
  });
  const toggleInvest = (on: boolean) => {
    setWithInvest(on);
    try {
      localStorage.setItem(INVEST_KEY, on ? '1' : '0');
    } catch {
      /* private mode */
    }
  };

  const { data, isFetching, isPlaceholderData } = useStats({
    from: range[0].format('YYYY-MM-DD'),
    to: range[1].format('YYYY-MM-DD'),
    currency,
    convertTo: readSummaryCurrency(),
    institutionId,
    invest: withInvest ? undefined : '0',
  });
  // One currency, or (default) everything converted to one.
  const cur = data?.currency ?? data?.convertedTo ?? currency ?? null;
  const stale = isFetching && isPlaceholderData ? 'is-stale' : '';

  const fmt = (n: number) => (cur ? money(n, cur) : String(n));
  const compact = useMemo(() => {
    const nf = new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 });
    return (n: number) => (cur ? nf.format(Number(fromMinor(n, decimals(cur)))) : String(n));
  }, [locale, cur, decimals]);

  // Fixed slots: income = 1 (blue), expense = 2 (orange) on every chart here.
  const income: Series = { key: 'income', label: t('stats.income'), color: 'var(--viz-1)' };
  const expense: Series = { key: 'expense', label: t('stats.expense'), color: 'var(--viz-2)' };

  const months = useMemo(
    () => (data?.months ?? []).map((m) => ({ ...m, label: dayjs(`${m.month}-01`).format(data!.months.length > 12 ? 'YY/MM' : locale === 'en-US' ? 'MMM' : 'M月') })),
    [data, locale],
  );

  const catRows: RankRow[] = (data?.byCategory ?? []).map((r) => {
    const c = r.categoryId ? L.cat.get(r.categoryId) : undefined;
    const name = r.categoryId === INVEST_CATEGORY ? t('stats.investLoss') : (c?.name ?? t('stats.uncategorized'));
    return {
      key: r.categoryId ?? '__none',
      text: name,
      label: (
        <span className="viz-cat">
          <i className="viz-cat-dot" style={{ background: c?.color ?? 'var(--ant-color-text-quaternary)' }} />
          {name}
        </span>
      ),
      values: { expense: r.amount },
      hint: `${t('stats.count')} ${r.count}`,
    };
  });
  const tagRows: RankRow[] = (data?.byTag ?? []).map((r) => {
    const tag = L.tag.get(r.tagId);
    return {
      key: r.tagId,
      text: tag?.name ?? r.tagId,
      label: <Tag color={tag?.color ?? undefined}>{tag?.name ?? '?'}</Tag>,
      values: { expense: r.amount },
      hint: `${t('stats.count')} ${r.count}`,
    };
  });
  const instRows: RankRow[] = (data?.byInstitution ?? []).map((r) => {
    const name = L.inst.get(r.institutionId)?.name ?? '?';
    return { key: r.institutionId, text: name, label: name, values: { income: r.income, expense: r.expense } };
  });

  const totals = data?.totals ?? { income: 0, expense: 0, count: 0 };
  const net = totals.income - totals.expense;
  const empty = data && totals.count === 0 && !data.stockFlows;
  // Stock money in/out, in the paying accounts: sells in (slot 1), buys out (slot 2).
  const flows = data?.stockFlows ?? null;
  const flowIn: Series = { key: 'sell', label: t('stats.flowIn'), color: 'var(--viz-1)' };
  const flowOut: Series = { key: 'buy', label: t('stats.flowOut'), color: 'var(--viz-2)' };
  const flowMonths = (flows?.months ?? []).map((m) => ({ ...m, label: months.find((x) => x.month === m.month)?.label ?? m.month }));
  const flowRows: RankRow[] = (flows?.byAccount ?? []).map((r) => {
    const name = L.accountLabel(r.accountId) || '?';
    return { key: r.accountId, text: name, label: name, values: { sell: r.sell, buy: r.buy } };
  });

  const filters = (
    <div className="filter-row">
      <Segmented
        value={preset ?? ''}
        onChange={(v) => {
          setPreset(v as Preset);
          setRange(presetRange(v as Preset));
        }}
        options={PRESETS.map((p) => ({ value: p, label: t(`stats.${p}`) }))}
      />
      <DatePicker.RangePicker
        picker="month"
        allowClear={false}
        value={range}
        onChange={(v) => {
          if (!v?.[0] || !v[1]) return;
          setPreset(null);
          setRange([v[0].startOf('month'), v[1].endOf('month')]);
        }}
      />
      <Select
        allowClear
        style={{ minWidth: 160 }}
        placeholder={t('stats.allInstitutions')}
        value={institutionId}
        onChange={setInstitutionId}
        options={L.institutions.map((i) => ({ value: i.id, label: i.name }))}
      />
      {(data?.currencies.length ?? 0) > 1 && (
        <Segmented
          value={currency ?? ALL}
          onChange={(v) => setCurrency(v === ALL ? undefined : (v as string))}
          options={[
            { value: ALL, label: t('stats.allCurrencies', { currency: data!.convertedTo ?? '' }) },
            ...data!.currencies.map((c) => ({ value: c, label: c })),
          ]}
        />
      )}
      <label className="muted switch-label">
        <Switch size="small" checked={withInvest} onChange={toggleInvest} />
        {t('stats.withInvest')}
      </label>
    </div>
  );

  return (
    <>
      <PageTop title={t('stats.title')} />
      {filters}
      {(data?.missing.length ?? 0) > 0 && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message={t('stats.missingRates', { list: data!.missing.join(', ') })}
          action={<Link to="/fx">{t('nav.fx')}</Link>}
        />
      )}

      {empty ? (
        <Card>
          <Empty description={t('stats.noData')} />
        </Card>
      ) : (
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <Row gutter={[16, 16]}>
            {[
              { k: 'income', v: totals.income, cls: '' },
              { k: 'expense', v: totals.expense, cls: '' },
              { k: 'net', v: net, cls: net >= 0 ? 'income' : 'expense' },
            ].map((x) => (
              <Col xs={12} md={6} key={x.k}>
                <Card className="stat-tile">
                  <Statistic title={t(`stats.${x.k}`)} value={fmt(x.v)} valueStyle={{ fontVariantNumeric: 'tabular-nums', color: x.cls ? `var(--${x.cls})` : undefined }} />
                </Card>
              </Col>
            ))}
            <Col xs={12} md={6}>
              <Card className="stat-tile">
                <Statistic title={t('stats.count')} value={totals.count} />
              </Card>
            </Col>
          </Row>
          {data?.invest && (
            <div className="muted" style={{ fontSize: 12, marginTop: -8 }}>
              {t('stats.investLine', { gain: fmt(data.invest.gain), loss: fmt(data.invest.loss), n: data.invest.sells })}
            </div>
          )}

          <Card
            title={t('stats.monthly')}
            extra={
              <Segmented
                size="small"
                value={monthView}
                onChange={(v) => setMonthView(v as 'chart' | 'table')}
                options={[
                  { value: 'chart', icon: <BarChartOutlined />, title: t('stats.chart') },
                  { value: 'table', icon: <TableOutlined />, title: t('stats.table') },
                ]}
              />
            }
          >
            {monthView === 'chart' ? (
              <div className={stale}>
                <Legend series={[income, expense]} values={{ income: fmt(totals.income), expense: fmt(totals.expense) }} />
                <GroupedColumns
                  data={months}
                  series={[income, expense]}
                  value={(d, k) => d[k as 'income' | 'expense']}
                  format={fmt}
                  formatAxis={compact}
                  title={(d) => dayjs(`${d.month}-01`).format('YYYY-MM')}
                />
              </div>
            ) : (
              <Table
                size="small"
                rowKey="month"
                pagination={false}
                scroll={{ y: 320 }}
                dataSource={[...months].reverse()}
                columns={[
                  { title: t('stats.month'), dataIndex: 'month' },
                  { title: t('stats.income'), dataIndex: 'income', align: 'right', render: (v: number) => <span className="num">{fmt(v)}</span> },
                  { title: t('stats.expense'), dataIndex: 'expense', align: 'right', render: (v: number) => <span className="num">{fmt(v)}</span> },
                  {
                    title: t('stats.net'),
                    key: 'net',
                    align: 'right',
                    render: (_: unknown, r) => <span className={`num ${r.income - r.expense >= 0 ? 'income' : 'expense'}`}>{fmt(r.income - r.expense)}</span>,
                  },
                ]}
              />
            )}
          </Card>

          <Row gutter={[16, 16]}>
            <Col xs={24} lg={12}>
              <Card title={t('stats.byCategory')} className="fill-card">
                {catRows.length ? (
                  <div className={stale}>
                    <RankBars rows={catRows} series={[expense]} format={fmt} total={totals.expense} otherLabel={t('stats.other')} />
                  </div>
                ) : (
                  <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} />
                )}
              </Card>
            </Col>
            <Col xs={24} lg={12}>
              <Card title={t('stats.byTag')} className="fill-card">
                {tagRows.length ? (
                  <div className={stale}>
                    <RankBars rows={tagRows} series={[expense]} format={fmt} total={totals.expense} otherLabel={t('stats.other')} />
                  </div>
                ) : (
                  <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('stats.noTags')} />
                )}
              </Card>
            </Col>
            <Col xs={24}>
              <Card title={t('stats.byInstitution')}>
                {instRows.length ? (
                  <div className={stale}>
                    <Legend series={[income, expense]} />
                    <RankBars rows={instRows} series={[income, expense]} format={fmt} otherLabel={t('stats.other')} />
                  </div>
                ) : (
                  <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} />
                )}
              </Card>
            </Col>
            {flows && (
              <Col xs={24}>
                <Card title={t('stats.stockFlows')} extra={<span className="muted" style={{ fontSize: 12 }}>{t('stats.stockFlowsHint')}</span>}>
                  <div className={stale}>
                    <Legend
                      series={[flowIn, flowOut]}
                      values={{ sell: fmt(flows.sell), buy: fmt(flows.buy) }}
                    />
                    <div className="muted" style={{ fontSize: 12, margin: '-2px 0 8px' }}>
                      {t('stats.flowNet')}{' '}
                      <span className={`num ${flows.sell - flows.buy >= 0 ? 'income' : 'expense'}`}>{money(flows.sell - flows.buy, 'USD', { signDisplay: 'exceptZero' })}</span>
                      {' · '}
                      {t('stats.flowCount', { n: flows.count })}
                    </div>
                    <GroupedColumns
                      data={flowMonths}
                      series={[flowIn, flowOut]}
                      value={(d, k) => d[k as 'sell' | 'buy']}
                      format={fmt}
                      formatAxis={compact}
                      title={(d) => dayjs(`${d.month}-01`).format('YYYY-MM')}
                      height={200}
                    />
                    {flowRows.length > 1 && (
                      <div style={{ marginTop: 12 }}>
                        <RankBars rows={flowRows} series={[flowIn, flowOut]} format={fmt} otherLabel={t('stats.other')} />
                      </div>
                    )}
                  </div>
                </Card>
              </Col>
            )}
          </Row>
        </Space>
      )}
    </>
  );
}
