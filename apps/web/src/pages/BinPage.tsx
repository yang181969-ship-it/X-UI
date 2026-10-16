import { SafetyOutlined } from '@ant-design/icons';
import { useQueries, useQuery } from '@tanstack/react-query';
import { Alert, Card, Descriptions, Empty, Input, Space, Table, Tag, Typography } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import type { BinInfo } from '@z-ui/shared';
import { useCards } from '../api/hooks.ts';
import { PageTop } from '../layouts/PanelLayout.tsx';
import { effectiveBinInfo, flagOf, lookupBin, searchBins, useBinLookup, useBinMeta } from '../lib/bin.ts';
import { cardLabel, useLocale } from '../lib/format.ts';

export function BinDetails({ info }: { info: BinInfo }) {
  const { t } = useTranslation();
  return (
    <Descriptions size="small" column={{ xs: 1, sm: 2 }} bordered>
      <Descriptions.Item label="BIN">
        <span className="num">{info.bin}</span>
      </Descriptions.Item>
      <Descriptions.Item label={t('bins.scheme')}>{info.scheme ?? '—'}</Descriptions.Item>
      <Descriptions.Item label={t('bins.type')}>{info.type ?? '—'}</Descriptions.Item>
      <Descriptions.Item label={t('bins.level')}>{info.level ?? '—'}</Descriptions.Item>
      <Descriptions.Item label={t('bins.issuer')} span={2}>
        {info.issuer ?? '—'}
      </Descriptions.Item>
      <Descriptions.Item label={t('bins.country')}>{info.country ? `${flagOf(info.country)} ${info.countryName ?? info.country}` : '—'}</Descriptions.Item>
      <Descriptions.Item label={t('bins.phone')}>{info.phone ?? '—'}</Descriptions.Item>
      <Descriptions.Item label={t('bins.source')} span={2}>
        {info.source === 'manual' ? <Tag color="green">{t('bins.manual')}</Tag> : <Tag>{t('bins.library')}</Tag>}
        {info.seen && info.source !== 'manual' && <span className="muted">{t('bins.seen', { date: info.seen })}</span>}
      </Descriptions.Item>
      {info.url && (
        <Descriptions.Item label={t('bins.url')} span={2}>
          <Typography.Link href={/^https?:/.test(info.url) ? info.url : `https://${info.url}`} target="_blank" rel="noreferrer noopener">
            {info.url}
          </Typography.Link>
        </Descriptions.Item>
      )}
    </Descriptions>
  );
}

export function BinPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const locale = useLocale();
  const [q, setQ] = useState('');
  const digits = q.replace(/\D/g, '');
  const bin6 = digits.length >= 6 ? digits.slice(0, 6) : null;
  const prefix = digits.length >= 3 && digits.length < 6 ? digits : null;

  const { data: meta, isLoading: metaLoading } = useBinMeta();
  const exact = useBinLookup(bin6);
  const search = useQuery({ queryKey: ['bin', 'search', prefix ?? ''], queryFn: () => searchBins(prefix!), enabled: !!prefix, staleTime: Infinity });

  const { data: cards = [] } = useCards();
  const withBin = cards.filter((c) => c.bin);
  // Your own corrections for a BIN (saved on cards) are shown before the public record.
  const corrected = bin6 ? cards.find((c) => c.binInfo?.source === 'manual' && c.binInfo.bin === bin6)?.binInfo : undefined;
  const looked = useQueries({
    queries: withBin.map((c) => ({ queryKey: ['bin', c.bin], queryFn: () => lookupBin(c.bin!), staleTime: Infinity, enabled: !!meta })),
  });

  const columns = [
    { title: 'BIN', dataIndex: 'bin', render: (v: string) => <span className="num">{v}</span> },
    { title: t('bins.scheme'), dataIndex: 'scheme' },
    { title: t('bins.type'), dataIndex: 'type', responsive: ['sm' as const] },
    { title: t('bins.level'), dataIndex: 'level', responsive: ['md' as const] },
    { title: t('bins.issuer'), dataIndex: 'issuer' },
    { title: t('bins.country'), dataIndex: 'country', render: (v: string | undefined, r: BinInfo) => (v ? `${flagOf(v)} ${r.countryName ?? v}` : '') },
  ];

  return (
    <>
      <PageTop title={t('bins.title')} />
      {!metaLoading && !meta && <Alert type="warning" showIcon message={t('bins.noData')} style={{ marginBottom: 16 }} />}
      {meta?.newest && <Alert type="info" showIcon closable message={t('bins.staleHint', { date: meta.newest })} style={{ marginBottom: 16 }} />}

      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Card>
          <Input.Search
            size="large"
            allowClear
            inputMode="numeric"
            autoComplete="off"
            maxLength={8}
            placeholder={t('bins.placeholder')}
            value={q}
            onChange={(e) => setQ(e.target.value.replace(/[^\d\s]/g, ''))}
            style={{ maxWidth: 420 }}
            disabled={!meta}
          />
          <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
            <SafetyOutlined /> {t('bins.privacy')}
          </div>

          {bin6 && (
            <Space direction="vertical" size={12} style={{ marginTop: 16, width: '100%' }}>
              {corrected && <BinDetails info={corrected} />}
              {exact.data ? <BinDetails info={exact.data} /> : exact.isFetched && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('bins.notFound', { bin: bin6 })} />}
            </Space>
          )}
          {prefix && search.data && (
            <div style={{ marginTop: 16 }}>
              <div className="muted" style={{ marginBottom: 8 }}>
                {t('bins.matches', { n: search.data.total, shown: search.data.items.length })}
              </div>
              <Table<BinInfo>
                rowKey="bin"
                size="small"
                dataSource={search.data.items}
                columns={columns}
                pagination={{ pageSize: 20, hideOnSinglePage: true }}
                onRow={(r) => ({ onClick: () => setQ(r.bin), style: { cursor: 'pointer' } })}
              />
            </div>
          )}
        </Card>

        <Card title={t('bins.myCards')}>
          {withBin.length ? (
            <Table
              rowKey="id"
              size="small"
              pagination={false}
              dataSource={withBin.map((c, i) => ({ card: c, info: effectiveBinInfo(c.binInfo, looked[i]?.data, c.bin) }))}
              onRow={(r) => ({ onClick: () => navigate(`/cards?card=${r.card.id}`, { state: { from: '/bins' } }), style: { cursor: 'pointer' } })}
              columns={[
                { title: t('nav.cards'), key: 'card', render: (_, r) => cardLabel(r.card) },
                { title: 'BIN', key: 'bin', render: (_, r) => <span className="num">{r.card.bin}</span> },
                { title: t('bins.issuer'), key: 'issuer', render: (_, r) => r.info?.issuer ?? <span className="muted">—</span> },
                { title: t('bins.level'), key: 'level', responsive: ['md'], render: (_, r) => r.info?.level ?? '' },
                {
                  title: t('bins.country'),
                  key: 'country',
                  responsive: ['sm'],
                  render: (_, r) => (r.info?.country ? `${flagOf(r.info.country)} ${r.info.countryName ?? r.info.country}` : ''),
                },
                {
                  title: t('bins.source'),
                  key: 'source',
                  responsive: ['md'],
                  render: (_, r) =>
                    r.info?.source === 'manual' ? <Tag color="green">{t('bins.manual')}</Tag> : r.info?.seen ? <span className="muted num">{r.info.seen}</span> : null,
                },
              ]}
            />
          ) : (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} />
          )}
        </Card>

        {meta && (
          <div className="muted" style={{ fontSize: 12 }}>
            {t('bins.count', { n: meta.count.toLocaleString(locale) })} · {new Date(meta.generatedAt).toLocaleDateString(locale)} · {t('bins.attribution')}: {meta.attribution}
          </div>
        )}
      </Space>
    </>
  );
}
