import { Layout, Skeleton, Tooltip } from 'antd';
import { motion, useReducedMotion } from 'motion/react';
import { Suspense, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation, useOutlet } from 'react-router';
import { useMe } from '../api/hooks.ts';
import { ReminderBell } from '../components/ReminderBell.tsx';
import { UserAvatar } from '../components/UserAvatar.tsx';
import { useTheme } from '../theme/ThemeProvider.tsx';
import { AppSidebar } from './AppSidebar.tsx';

export function PanelLayout() {
  const outlet = useOutlet();
  const location = useLocation();
  const { isDark, mode } = useTheme();
  const reduce = useReducedMotion();
  return (
    <Layout className={`app-shell ${isDark ? 'is-dark' : ''} ${mode === 'ultra' ? 'is-ultra' : ''}`} hasSider>
      <AppSidebar />
      <Layout>
        <Layout.Content>
          <motion.div
            key={location.pathname}
            className="content-area"
            initial={reduce ? false : { opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
          >
            <Suspense fallback={<Skeleton active paragraph={{ rows: 8 }} style={{ marginTop: 60 }} />}>{outlet}</Suspense>
          </motion.div>
        </Layout.Content>
      </Layout>
    </Layout>
  );
}

/** Page title row with the reminder bell and the user avatar. */
export function PageTop({ title, extra }: { title: ReactNode; extra?: ReactNode }) {
  const { data: me } = useMe();
  const { t } = useTranslation();
  const name = me?.user.displayName ?? '';
  return (
    <div className="topbar">
      <h1>{title}</h1>
      <div className="topbar-actions">
        {extra}
        <ReminderBell />
        <Tooltip title={`${name} · ${me ? t(`roles.${me.user.role}`) : ''}`}>
          <Link to="/security">
            <span style={{ cursor: 'pointer' }}>
              <UserAvatar user={me?.user} />
            </span>
          </Link>
        </Tooltip>
      </div>
    </div>
  );
}
