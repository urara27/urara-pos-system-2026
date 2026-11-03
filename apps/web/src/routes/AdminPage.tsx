import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  DEVICE_ROLE_LABELS,
  DEVICE_ROLES,
  type AdminDeviceRow,
  type DeviceRole,
  type EmployeeInfo,
  type PairingCodeResponse,
  type StaffSessionResponse,
} from '@pos/shared';
import { ConnectionBadge, OfflineBanner } from '../components/ConnectionBadge';
import { Toast, useToast } from '../components/Toast';
import { api, ApiError } from '../lib/api';
import { keys, session } from '../lib/storage';
import { useRealtime } from '../realtime/connection';

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
  return <AdminDashboard employee={login.employee} onLogout={logout} />;
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
    <main className="panel-page">
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

function AdminDashboard({ employee, onLogout }: { employee: EmployeeInfo; onLogout: () => void }) {
  const [devices, setDevices] = useState<AdminDeviceRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const showToast = useToast((s) => s.show);

  const reload = useCallback(() => {
    api<{ devices: AdminDeviceRow[] }>('/api/admin/devices', { auth: 'admin' })
      .then((res) => setDevices(res.devices))
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : '読み込みに失敗しました'));
  }, []);

  useRealtime({
    auth: { adminSession: session.get(keys.adminSession) ?? '' },
    onSync: reload,
    handlers: {
      'devices.presence': (e) => {
        // 新しく登録された端末が現れたら一覧ごと取り直す
        if (e.payload.onlineDeviceIds.some((id) => !devices.some((d) => d.id === id))) {
          reload();
          return;
        }
        const online = new Set(e.payload.onlineDeviceIds);
        setDevices((prev) => prev.map((d) => ({ ...d, online: online.has(d.id) })));
      },
      'system.ping': (e) => showToast(`📣 ${e.payload.from}: ${e.payload.message}`),
    },
  });

  return (
    <div className="admin">
      <OfflineBanner />
      <header className="topbar">
        <strong>管理画面</strong>
        <span>{employee.name}</span>
        <button className="btn" onClick={onLogout}>
          ログアウト
        </button>
      </header>
      <main className="admin__main">
        {error && <p className="error">{error}</p>}
        <PairingCodeIssuer />
        <DeviceList devices={devices} onChanged={reload} />
        <PingSender />
        <p className="muted small">商品・従業員などのマスタ管理はフェーズ2で実装します。</p>
      </main>
      <ConnectionBadge />
      <Toast />
    </div>
  );
}

function PairingCodeIssuer() {
  const [role, setRole] = useState<DeviceRole>('register');
  const [issued, setIssued] = useState<PairingCodeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const issue = async () => {
    setError(null);
    try {
      setIssued(
        await api<PairingCodeResponse>('/api/admin/pairing-codes', { method: 'POST', body: { role }, auth: 'admin' }),
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '発行に失敗しました');
    }
  };

  return (
    <section className="card">
      <h2>端末の登録</h2>
      <p className="muted">
        役割を選んでペアリングコードを発行し、登録する端末で <code>/pairing</code> を開いて入力します（有効期限10分）。
      </p>
      <div className="row">
        <select value={role} onChange={(e) => setRole(e.target.value as DeviceRole)}>
          {DEVICE_ROLES.map((r) => (
            <option key={r} value={r}>
              {DEVICE_ROLE_LABELS[r]}
            </option>
          ))}
        </select>
        <button className="btn btn--primary" onClick={issue}>
          ペアリングコードを発行
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      {issued && (
        <p className="pairing-code">
          <span className="pairing-code__value">{issued.code}</span>
          <span className="muted">
            {DEVICE_ROLE_LABELS[issued.role]}用 / {new Date(issued.expiresAt).toLocaleTimeString('ja-JP')} まで有効
          </span>
        </p>
      )}
    </section>
  );
}

function DeviceList({ devices, onChanged }: { devices: AdminDeviceRow[]; onChanged: () => void }) {
  const toggle = async (device: AdminDeviceRow) => {
    const action = device.enabled ? '無効化' : '有効化';
    if (!window.confirm(`「${device.name}」を${action}しますか？`)) return;
    await api(`/api/admin/devices/${device.id}`, {
      method: 'PATCH',
      body: { enabled: !device.enabled },
      auth: 'admin',
    }).catch(() => undefined);
    onChanged();
  };

  return (
    <section className="card">
      <h2>登録済みの端末</h2>
      {devices.length === 0 ? (
        <p className="muted">まだ端末が登録されていません。</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>端末名</th>
              <th>役割</th>
              <th>接続</th>
              <th>最終接続</th>
              <th>状態</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {devices.map((d) => (
              <tr key={d.id} className={d.enabled ? '' : 'is-disabled'}>
                <td>{d.name}</td>
                <td>{DEVICE_ROLE_LABELS[d.role]}</td>
                <td>
                  <span className={`dot ${d.online ? 'dot--on' : 'dot--off'}`} />
                  {d.online ? 'オンライン' : 'オフライン'}
                </td>
                <td>{d.lastSeenAt ? new Date(d.lastSeenAt).toLocaleString('ja-JP') : '—'}</td>
                <td>{d.enabled ? '有効' : '無効'}</td>
                <td>
                  <button className="btn btn--small" onClick={() => toggle(d)}>
                    {d.enabled ? '無効化' : '有効化'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/** リアルタイム配信の疎通確認用。全端末にトーストを出す */
function PingSender() {
  const [message, setMessage] = useState('テスト通知です');
  const send = async () => {
    await api('/api/admin/broadcast-ping', { method: 'POST', body: { message }, auth: 'admin' }).catch(() => undefined);
  };
  return (
    <section className="card">
      <h2>通信テスト</h2>
      <div className="row">
        <input value={message} maxLength={100} onChange={(e) => setMessage(e.target.value)} />
        <button className="btn" onClick={send} disabled={!message.trim()}>
          全端末に送信
        </button>
      </div>
    </section>
  );
}
