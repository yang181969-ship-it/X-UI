import { Card, Empty, Table } from 'antd';
import { useTranslation } from 'react-i18next';
import { PageIntro } from '../components/Placeholder.tsx';
import { PageTop } from '../layouts/PanelLayout.tsx';

const COLUMNS = ['date', 'account', 'type', 'amount', 'currency', 'note'] as const;

/** 流水. The table layout is in place; rows arrive with the M2 ledger tables. */
export function TransactionsPage() {
  const { t } = useTranslation();
  return (
    <>
      <PageTop title={t('nav.transactions')} />
      <PageIntro text={t('transactions.desc')} />
      <Card title={t('transactions.list')} styles={{ body: { padding: 0 } }}>
        <Table
          size="small"
          rowKey="id"
          dataSource={[]}
          columns={COLUMNS.map((k) => ({ key: k, title: t(`transactions.columns.${k}`), align: k === 'amount' ? ('right' as const) : undefined }))}
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('placeholder.comingSoon')} /> }}
          pagination={false}
          scroll={{ x: 640 }}
        />
      </Card>
    </>
  );
}
