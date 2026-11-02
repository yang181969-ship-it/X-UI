import { Card, Empty, Tag, Typography } from 'antd';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

/** Intro line for a page whose features arrive in a later milestone. */
export function PageIntro({ text }: { text: string }) {
  const { t } = useTranslation();
  return (
    <Typography.Paragraph type="secondary" style={{ marginTop: -4 }}>
      <Tag color="blue">{t('placeholder.tag')}</Tag>
      {text}
    </Typography.Paragraph>
  );
}

/** A card with an empty state, used until the page's data exists. */
export function EmptyCard({ title, extra, children }: { title: ReactNode; extra?: ReactNode; children?: ReactNode }) {
  const { t } = useTranslation();
  return (
    <Card title={title} extra={extra}>
      {children ?? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('placeholder.comingSoon')} />}
    </Card>
  );
}
