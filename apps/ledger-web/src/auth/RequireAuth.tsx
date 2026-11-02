import { useQueryClient } from '@tanstack/react-query';
import { Spin } from 'antd';
import { useEffect, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import { setUnauthenticatedHandler } from '../api/client.ts';
import { useMe } from '../api/hooks.ts';

export function FullPageSpin() {
  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <Spin size="large" />
    </div>
  );
}

/** Redirects to /login when there is no session; also reacts to sessions expiring mid-use. */
export function RequireAuth({ children, admin = false }: { children: ReactNode; admin?: boolean }) {
  const { data: me, isLoading } = useMe();
  const qc = useQueryClient();
  const location = useLocation();

  useEffect(() => {
    setUnauthenticatedHandler(() => {
      qc.setQueryData(['me'], null);
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'me' });
    });
    return () => setUnauthenticatedHandler(null);
  }, [qc]);

  if (isLoading) return <FullPageSpin />;
  if (!me) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (admin && me.user.role !== 'admin') return <Navigate to="/" replace />;
  return <>{children}</>;
}
