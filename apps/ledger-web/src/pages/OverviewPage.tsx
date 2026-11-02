import { Col, Row, Tag } from 'antd';
import { useTranslation } from 'react-i18next';
import { EmptyCard, PageIntro } from '../components/Placeholder.tsx';
import { PageTop } from '../layouts/PanelLayout.tsx';

/** 总览. Amounts are grouped per original currency; there is deliberately no converted total. */
export function OverviewPage() {
  const { t } = useTranslation();
  return (
    <>
      <PageTop title={t('nav.overview')} />
      <PageIntro text={t('overview.desc')} />
      <Row gutter={[16, 16]}>
        <Col xs={24} xl={12}>
          <EmptyCard title={t('overview.byCurrency')} extra={<Tag>{t('overview.noFx')}</Tag>} />
        </Col>
        <Col xs={24} xl={12}>
          <EmptyCard title={t('overview.recent')} />
        </Col>
      </Row>
    </>
  );
}
