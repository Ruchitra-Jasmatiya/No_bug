import { lazy, Suspense, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Layout } from './components/Layout';
import { useAuth } from './lib/auth';
import { PageLoader } from './lib/ui';
import Home from './pages/Home';

const Signup = lazy(() => import('./pages/Auth').then((m) => ({ default: m.Signup })));
const VerifyEmail = lazy(() => import('./pages/Auth').then((m) => ({ default: m.VerifyEmail })));
const Login = lazy(() => import('./pages/Auth').then((m) => ({ default: m.Login })));
const ForgotPassword = lazy(() => import('./pages/Auth').then((m) => ({ default: m.ForgotPassword })));
const ResetPassword = lazy(() => import('./pages/Auth').then((m) => ({ default: m.ResetPassword })));
const Dashboard = lazy(() => import('./pages/Dashboard'));
const TestRun = lazy(() => import('./pages/TestRun'));
const Report = lazy(() => import('./pages/Report'));
const Admin = lazy(() => import('./pages/Admin'));
const Static = lazy(() => import('./pages/Static'));
const NotFound = lazy(() => import('./pages/NotFound'));

function RequireAuth({ children, admin = false }: { children: ReactNode; admin?: boolean }) {
  const { user, loading } = useAuth();
  const loc = useLocation();
  if (loading) return <PageLoader label="Checking your session" />;
  if (!user) return <Navigate to="/login" replace state={{ next: loc.pathname + loc.search }} />;
  if (admin && user.role !== 'admin') return <Navigate to="/dashboard" replace />;
  return <>{children}</>;
}

function GuestOnly({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <PageLoader label="Checking your session" />;
  if (user) return <Navigate to="/dashboard" replace />;
  return <>{children}</>;
}

export function App() {
  return (
    <Suspense fallback={<PageLoader />}>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Home />} />
          <Route path="signup" element={<GuestOnly><Signup /></GuestOnly>} />
          <Route path="verify-email" element={<GuestOnly><VerifyEmail /></GuestOnly>} />
          <Route path="login" element={<GuestOnly><Login /></GuestOnly>} />
          <Route path="forgot-password" element={<GuestOnly><ForgotPassword /></GuestOnly>} />
          <Route path="reset-password" element={<GuestOnly><ResetPassword /></GuestOnly>} />
          <Route path="dashboard" element={<RequireAuth><Dashboard /></RequireAuth>} />
          <Route path="tests/:id" element={<RequireAuth><TestRun /></RequireAuth>} />
          <Route path="reports/:id" element={<RequireAuth><Report /></RequireAuth>} />
          <Route path="admin" element={<RequireAuth admin><Admin /></RequireAuth>} />
          <Route path="about" element={<Static page="about" />} />
          <Route path="terms" element={<Static page="terms" />} />
          <Route path="privacy" element={<Static page="privacy" />} />
          <Route path="contact" element={<Static page="contact" />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </Suspense>
  );
}
