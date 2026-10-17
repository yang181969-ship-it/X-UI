import { BankOutlined, PlusOutlined, RightOutlined, WarningOutlined } from '@ant-design/icons';
import { Button, Card, Col, Collapse, Empty, Progress, Result, Row, Select, Skeleton, Tag } from 'antd';
import { motion } from 'motion/react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router';
import type { TransactionDto } from '@z-ui/shared';
import { useConfig, useDashboard, useMe, useReminders } from '../api/hooks.ts';
import { CreditUsage } from '../components/AccountExtras.tsx';
import { AnimatedNumber, MoneyText } from '../components/Money.tsx';
import { ReminderList } from '../components/ReminderBell.tsx';
import { TransactionModal } from '../components/TransactionModal.tsx';
import { TxRow } from '../components/TxRow.tsx';
import { PageTop } from '../layouts/PanelLayout.tsx';
import { colorFor, initials, readSummaryCurrency, useCountry, useMoney, visibleBalances, writeSummaryCurrency } from '../lib/format.ts';

const stagger = {
  hidden: {},
  show: { transition: { staggerChildren: 0.06 } },
};
const rise = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.35, ease: [0.22, 1, 0.36, 1] as const } },
};

export function DashboardPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data: me } = useMe();
  // Currency the net worth is converted to; remembered per browser.
  const [convCurrency, setConvCurrency] = useState<string | undefined>(readSummaryCurrency);
  const pickCurrency = (code: string) => {
    setConvCurrency(code);
    writeSummaryCurrency(code);
  };
  const { data, isLoading } = useDashboard(convCurrency);
  const { data: reminders = [] } = useReminders();
  const { data: cfg } = useConfig();
  const money = useMoney();
  const country = useCountry();
  const [txOpen, setTxOpen] = useState(false);
  const [editing, setEditing] = useState<TransactionDto | null>(null);

  const symbol = (code: string) => cfg?.currencies.find((c) => c.code === code)?.symbol ?? code;

  const top = (
    <PageTop
      title={t('dashboard.welcome', { name: me?.user.displayName ?? '' })}
      extra={
        <Button type="primary" icon={<PlusOutlined />} onClick={() => (setEditing(null), setTxOpen(true))}>
          {t('tx.add')}
        </Button>
      }
    />
  );

  if (isLoading || !data) {
    return (
      <>
        {top}
        <Skeleton active paragraph={{ rows: 8 }} />
      </>
    );
  }

  if (data.counts.institutions === 0) {
    return (
      <>
        {top}
        <Card>
          <Result
            icon={<BankOutlined style={{ color: 'var(--ant-color-primary)' }} />}
            title={t('dashboard.getStarted')}
            subTitle={t('dashboard.getStartedDesc')}
            extra={
              <Button type="primary" size="large" onClick={() => navigate('/accounts')}>
                {t('institution.add')}
              </Button>
            }
          />
        </Card>
      </>
    );
  }

  return (
    <>
      {top}
      <motion.div variants={stagger} initial="hidden" animate="show">
        <Row gutter={[16, 16]}>
          {data.converted && (
            <Col xs={24} sm={12} lg={8} xxl={6}>
              <motion.div variants={rise}>
                <Card hoverable className="stat-tile stat-converted" onClick={() => navigate('/fx')}>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span className="stat-currency" onClick={(e) => e.stopPropagation()}>
                      <Tag color="purple" style={{ marginInlineEnd: 0 }}>
                        {t('fx.convertedTo')}
                      </Tag>
                      <Select
                        size="small"
                        variant="borderless"
                        value={data.converted.currency}
                        onChange={pickCurrency}
                        popupMatchSelectWidth={false}
                        aria-label={t('fx.convertedTo')}
                        className="convert-currency"
                        options={(cfg?.currencies ?? []).map((c) => ({ value: c.code, label: c.code }))}
                      />
                    </span>
                    <span className="muted" style={{ fontSize: 12 }}>
                      {data.converted.asOf ? t('fx.asOf', { date: data.converted.asOf }) : ''}
                    </span>
                  </div>
                  <div className="stat-net" title={t('dashboard.net')}>
                    <AnimatedNumber value={data.converted.net} format={(n) => money(n, data.converted!.currency)} />
                  </div>
                  <div className="stat-split">
                    <span>
                      {t('dashboard.assets')} <span className="num">{money(data.converted.assets, data.converted.currency)}</span>
                    </span>
                    <span>
                      {t('dashboard.liabilities')}{' '}
                      <span className={`num ${data.converted.liabilities ? 'expense' : ''}`}>{money(data.converted.liabilities, data.converted.currency)}</span>
                    </span>
                  </div>
                  {(data.investments || data.converted.missing.length > 0) && (
                    <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                      {data.investments && t('dashboard.includesStocks')}
                      {data.investments && data.converted.missing.length > 0 && ' · '}
                      {data.converted.missing.length > 0 && (
                        <span>
                          <WarningOutlined /> {t('fx.missing', { list: data.converted.missing.join(', ') })}
                        </span>
                      )}
                    </div>
                  )}
                </Card>
              </motion.div>
            </Col>
          )}
          {data.investments && (
            <Col xs={24} sm={12} lg={8} xxl={6}>
              <motion.div variants={rise}>
                <Card hoverable className="stat-tile" onClick={() => navigate('/invest')}>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span className="stat-currency">
                      <Tag color="geekblue" style={{ marginInlineEnd: 0 }}>
                        {t('nav.invest')}
                      </Tag>
                      <span className="muted">USD</span>
                    </span>
                    <span className="muted" style={{ fontSize: 12 }}>
                      {t('dashboard.positionsN', { n: data.investments.positions })}
                    </span>
                  </div>
                  <div className="stat-net" title={t('invest.marketValue')}>
                    <AnimatedNumber value={data.investments.marketValue} format={(n) => money(n, 'USD')} />
                  </div>
                  <div className="stat-split">
                    <span>
                      {t('invest.unrealized')}{' '}
                      <MoneyText minor={data.investments.unrealized} currency="USD" signed colored />
                    </span>
                  </div>
                </Card>
              </motion.div>
            </Col>
          )}
          {data.totals.map((tot) => (
            <Col key={tot.currency} xs={24} sm={12} lg={8} xxl={6}>
              <motion.div variants={rise}>
                <Card hoverable className="stat-tile">
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span className="stat-currency">
                      <Tag color="blue" style={{ marginInlineEnd: 0 }}>
                        {tot.currency}
                      </Tag>
                      <span className="muted">{symbol(tot.currency)}</span>
                    </span>
                    <span className="muted" style={{ fontSize: 12 }}>
                      {t('dashboard.accountsN', { n: tot.accountCount })}
                    </span>
                  </div>
                  <div className="stat-net" title={t('dashboard.net')}>
                    <AnimatedNumber value={tot.net} format={(n) => money(n, tot.currency)} />
                  </div>
                  <div className="stat-split">
                    <span>
                      {t('dashboard.assets')} <span className="num">{money(tot.assets, tot.currency)}</span>
                    </span>
                    <span>
                      {t('dashboard.liabilities')}{' '}
                      <span className={`num ${tot.liabilities ? 'expense' : ''}`}>{money(tot.liabilities, tot.currency)}</span>
                    </span>
                  </div>
                </Card>
              </motion.div>
            </Col>
          ))}
        </Row>

        <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
          <Col xs={24} xl={15}>
            <motion.div variants={rise}>
              <Card title={t('dashboard.holdings')} extra={<Link to="/accounts">{t('dashboard.viewAll')} <RightOutlined /></Link>}>
                <Collapse
                  ghost
                  defaultActiveKey={data.tree.map((n) => n.country)}
                  items={data.tree.map((node) => {
                    const c = country(node.country);
                    return {
                      key: node.country,
                      label: (
                        <span style={{ fontWeight: 500 }}>
                          {c.flag} {c.name}
                        </span>
                      ),
                      children: node.institutions.map((inst) => (
                        <div key={inst.id} style={{ marginBottom: 8 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '4px 0 2px' }}>
                            <span className="avatar-icon" style={{ background: inst.color ?? colorFor(inst.name), width: 24, height: 24, flexBasis: 24, fontSize: 12, borderRadius: 7 }}>
                              {initials(inst.name)}
                            </span>
                            <span style={{ fontWeight: 500 }}>{inst.name}</span>
                          </div>
                          {inst.accounts.map((a) => (
                            <div key={a.id} className="row-item clickable" style={{ paddingLeft: 32 }} onClick={() => navigate(`/accounts?account=${a.id}`)}>
                              <div className="row-main">
                                <div className="row-title" style={{ fontWeight: 400 }}>
                                  {a.name}
                                </div>
                                <div className="row-sub">{t(`account.types.${a.type}`)}</div>
                                {a.creditUsage && (
                                  <div className="row-extra">
                                    <CreditUsage usage={a.creditUsage} currency={a.balances[0]?.currency ?? 'USD'} compact />
                                  </div>
                                )}
                                {a.holdings !== null && <div className="row-extra muted">{t('account.holdingsValue', { amount: money(a.holdings, 'USD') })}</div>}
                              </div>
                              <div className="balances">
                                {visibleBalances({ currency: a.balances[0]?.currency ?? '', currencies: a.balances, stockCash: a.stockCash }).map((b) => (
                                  <div key={b.currency}>
                                    <MoneyText minor={b.balance} currency={b.currency} colored={b.balance < 0} animated style={{ fontWeight: 500 }} />
                                  </div>
                                ))}
                              </div>
                            </div>
                          ))}
                        </div>
                      )),
                    };
                  })}
                />
              </Card>
            </motion.div>
          </Col>
          <Col xs={24} xl={9}>
            <motion.div variants={rise}>
              <Card title={t('dashboard.upcoming')} style={{ marginBottom: 16 }} styles={{ body: { paddingTop: 8, paddingBottom: 8 } }}>
                {reminders.length ? <ReminderList items={reminders.slice(0, 6)} compact /> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('dashboard.noUpcoming')} />}
              </Card>
            </motion.div>
            <motion.div variants={rise}>
              <Card title={t('dashboard.thisMonth')}>
                {data.month.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} />}
                {data.month.map((m) => {
                  const max = Math.max(m.income, m.expense, 1);
                  return (
                    <div key={m.currency} style={{ marginBottom: 14 }}>
                      <Tag style={{ marginBottom: 6 }}>{m.currency}</Tag>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                        <span className="muted">{t('dashboard.income')}</span>
                        <MoneyText minor={m.income} currency={m.currency} style={{ color: 'var(--income)' }} />
                      </div>
                      <Progress percent={(m.income / max) * 100} showInfo={false} strokeColor="var(--income)" size="small" />
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                        <span className="muted">{t('dashboard.expense')}</span>
                        <MoneyText minor={m.expense} currency={m.currency} style={{ color: 'var(--expense)' }} />
                      </div>
                      <Progress percent={(m.expense / max) * 100} showInfo={false} strokeColor="var(--expense)" size="small" />
                    </div>
                  );
                })}
              </Card>
            </motion.div>
          </Col>
        </Row>

        <motion.div variants={rise} style={{ marginTop: 16 }}>
          <Card title={t('dashboard.recent')} extra={<Link to="/transactions">{t('dashboard.viewAll')} <RightOutlined /></Link>} styles={{ body: { paddingTop: 4, paddingBottom: 4 } }}>
            {data.recent.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} />}
            {data.recent.map((tx) => (
              <TxRow key={tx.id} tx={tx} onClick={() => (setEditing(tx), setTxOpen(true))} />
            ))}
          </Card>
        </motion.div>
      </motion.div>
      <TransactionModal open={txOpen} editing={editing} onClose={() => setTxOpen(false)} />
    </>
  );
}
