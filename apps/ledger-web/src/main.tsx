import 'antd/dist/reset.css';
import './styles/global.css';
import './i18n/index.ts';
import { QueryClientProvider } from '@tanstack/react-query';
import { lazy, StrictMode, Suspense, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router';
import { queryClient } from './api/hooks.ts';
import { FullPageSpin, RequireAuth } from './auth/RequireAuth.tsx';
import { StepUpProvider } from './auth/StepUp.tsx';
import { PanelLayout } from './layouts/PanelLayout.tsx';
import { applyDom, readStoredMode, ThemeProvider } from './theme/ThemeProvider.tsx';

// Each page is its own chunk, loaded on first visit.
const LoginPage = lazy(() => import('./pages/LoginPage.tsx').then((m) => ({ default: m.LoginPage })));
const SetupPage = lazy(() => import('./pages/SetupPage.tsx').then((m) => ({ default: m.SetupPage })));
const OverviewPage = lazy(() => import('./pages/OverviewPage.tsx').then((m) => ({ default: m.OverviewPage })));
const TransactionsPage = lazy(() => import('./pages/TransactionsPage.tsx').then((m) => ({ default: m.TransactionsPage })));
const AccountsPage = lazy(() => import('./pages/AccountsPage.tsx').then((m) => ({ default: m.AccountsPage })));
const AccountDetailPage = lazy(() => import('./pages/AccountDetailPage.tsx').then((m) => ({ default: m.AccountDetailPage })));
const ChannelDetailPage = lazy(() => import('./pages/ChannelDetailPage.tsx').then((m) => ({ default: m.ChannelDetailPage })));
const CardsPage = lazy(() => import('./pages/CardsPage.tsx').then((m) => ({ default: m.CardsPage })));
const CardDetailPage = lazy(() => import('./pages/CardDetailPage.tsx').then((m) => ({ default: m.CardDetailPage })));
const SettingsPage = lazy(() => import('./pages/SettingsPage.tsx').then((m) => ({ default: m.SettingsPage })));

const standalone = (node: ReactNode) => <Suspense fallback={<FullPageSpin />}>{node}</Suspense>;

// Apply the theme before the first paint to avoid a flash.
applyDom(readStoredMode());

const router = createBrowserRouter([
  { path: '/login', element: standalone(<LoginPage />) },
  { path: '/setup/:token', element: standalone(<SetupPage />) },
  {
    path: '/',
    element: (
      <RequireAuth>
        <StepUpProvider>
          <PanelLayout />
        </StepUpProvider>
      </RequireAuth>
    ),
    children: [
      { index: true, element: <OverviewPage /> },
      { path: 'transactions', element: <TransactionsPage /> },
      { path: 'accounts', element: <AccountsPage /> },
      { path: 'accounts/channels/:id', element: <ChannelDetailPage /> },
      { path: 'accounts/:id', element: <AccountDetailPage /> },
      { path: 'cards', element: <CardsPage /> },
      { path: 'cards/:id', element: <CardDetailPage /> },
      { path: 'settings', element: <SettingsPage /> },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <RouterProvider router={router} />
      </ThemeProvider>
    </QueryClientProvider>
  </StrictMode>,
);
