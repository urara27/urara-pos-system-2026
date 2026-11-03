import { useEffect, useState, type FormEvent } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router';
import type { EmployeeInfo, StaffSessionResponse } from '@pos/shared';
import { ConnectionBadge, OfflineBanner } from '../components/ConnectionBadge';
import { Toast, useToast } from '../components/Toast';
import { api, ApiError } from '../lib/api';
import { keys, session } from '../lib/storage';
import { useRealtime } from '../realtime/connection';
import { CategoriesPage } from './admin/CategoriesPage';
import { DevicesPage, useDevicePresence } from './admin/DevicesPage';
import { DiscountsPage } from './admin/DiscountsPage';
import { EmployeesPage } from './admin/EmployeesPage';
import { OptionGroupsPage } from './admin/OptionGroupsPage';
import { ProductsPage } from './admin/ProductsPage';
import { RegistersPage } from './admin/RegistersPage';
import { SettingsPage } from './admin/SettingsPage';
import { AuditLogsPage } from './admin/AuditLogsPage';
import { SalesPage } from './admin/SalesPage';
import { SettlementsPage } from './admin/SettlementsPage';
import './admin/admin.css';

type LoginState = { state: 'checking' } | { state: 'out' } | { state: 'in'; employee: EmployeeInfo };

/** 管理画面。どのブラウザからでも開けるが、管理者ログインを必須とする */
export function AdminPage() {
  const [login, setLogin] = useState<LoginState>(() =>
    session.get(keys.adminSession) ? { state: 'checking' } : { state: 'out' },
  );

  useEffect(() => {
    if (login.state !== 'checking') return;
    api<{ employee: EmployeeInfo }>('/api/admin/me', { auth: 'admin' })
      .then(({ employee }) => setLogin({ state: 'in', employee }))
      .catch(() => {
        session.remove(keys.adminSession);
        setLogin({ state: 'out' });
      });
  }, [login.state]);

  const logout = async () => {
    await api('/api/admin/logout', { method: 'POST', auth: 'admin' }).catch(() => undefined);
    session.remove(keys.adminSession);
    setLogin({ state: 'out' });
  };

  if (login.state === 'checking') return <div className="center-message">確認しています…</div>;
  if (login.state === 'out') {
    return (
      <AdminLogin
        onLogin={(res) => {
          session.set(keys.adminSession, res.token);
          setLogin({ state: 'in', employee: res.employee });
        }}
      />
    );
  }
  return <AdminShell employee={login.employee} onLogout={logout} />;
}

function AdminLogin({ onLogin }: { onLogin: (res: StaffSessionResponse) => void }) {
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      onLogin(await api<StaffSessionResponse>('/api/admin/login', { method: 'POST', body: { code, password } }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'ログインに失敗しました');
    }
  };

  return (
    <main className="panel-page dads">
      <form className="panel" onSubmit={submit}>
        <h1>管理画面ログイン</h1>
        <label className="field">
          <span>従業員コード</span>
          <input inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} required />
        </label>
        <label className="field">
          <span>パスワード</span>
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        {error && <p className="error">{error}</p>}
        <button className="btn btn--primary btn--block">ログイン</button>
      </form>
    </main>
  );
}

const NAV = [
  { to: '/admin/sales', label: '売上' },
  { to: '/admin/settlements', label: 'レジ点検・精算' },
  { to: '/admin/products', label: '商品' },
  { to: '/admin/categories', label: 'カテゴリ' },
  { to: '/admin/option-groups', label: 'オプション' },
  { to: '/admin/discounts', label: '割引・クーポン' },
  { to: '/admin/employees', label: '従業員' },
  { to: '/admin/devices', label: '端末' },
  { to: '/admin/registers', label: 'レジ' },
  { to: '/admin/settings', label: '店舗・運用設定' },
  { to: '/admin/audit-logs', label: '操作ログ' },
] as const;

function AdminShell({ employee, onLogout }: { employee: EmployeeInfo; onLogout: () => void }) {
  const showToast = useToast((s) => s.show);
  const presence = useDevicePresence();

  useRealtime({
    auth: { adminSession: session.get(keys.adminSession) ?? '' },
    onSync: presence.reload,
    handlers: {
      'devices.presence': presence.onPresence,
      'system.ping': (e) => showToast(`📣 ${e.payload.from}: ${e.payload.message}`),
    },
  });

  return (
    <div className="admin dads">
      <OfflineBanner />
      <header className="topbar">
        <strong>管理画面</strong>
        <span>{employee.name}</span>
        <button className="btn" onClick={onLogout}>
          ログアウト
        </button>
      </header>
      <div className="admin__body">
        <nav className="admin__nav">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} className={({ isActive }) => (isActive ? 'is-active' : '')}>
              {n.label}
            </NavLink>
          ))}
        </nav>
        <main className="admin__main">
          <Routes>
            <Route index element={<Navigate to="/admin/sales" replace />} />
            <Route path="sales" element={<SalesPage />} />
            <Route path="settlements" element={<SettlementsPage />} />
            <Route path="audit-logs" element={<AuditLogsPage />} />
            <Route path="products" element={<ProductsPage />} />
            <Route path="categories" element={<CategoriesPage />} />
            <Route path="option-groups" element={<OptionGroupsPage />} />
            <Route path="discounts" element={<DiscountsPage />} />
            <Route path="employees" element={<EmployeesPage />} />
            <Route path="devices" element={<DevicesPage presence={presence} />} />
            <Route path="registers" element={<RegistersPage />} />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="*" element={<Navigate to="/admin/sales" replace />} />
          </Routes>
        </main>
      </div>
      <ConnectionBadge />
      <Toast />
    </div>
  );
}
