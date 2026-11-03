import { useEffect, useState } from 'react';
import { EMPLOYEE_ROLE_LABELS, type EmployeeInfo, type StaffSessionResponse } from '@pos/shared';
import { useDevice, useDeviceRealtime } from '../components/DeviceGate';
import { Keypad } from '../components/Keypad';
import { api, ApiError } from '../lib/api';
import { keys, session } from '../lib/storage';

type LoginState = { state: 'checking' } | { state: 'out' } | { state: 'in'; employee: EmployeeInfo };

/** レジ。フェーズ1では従業員ログインまで。会計はフェーズ3で実装する */
export function RegisterPage() {
  const device = useDevice();
  const [login, setLogin] = useState<LoginState>(() =>
    session.get(keys.staffSession) ? { state: 'checking' } : { state: 'out' },
  );
  useDeviceRealtime();

  useEffect(() => {
    if (login.state !== 'checking') return;
    api<{ employee: EmployeeInfo }>('/api/auth/session', { auth: 'staff' })
      .then(({ employee }) => setLogin({ state: 'in', employee }))
      .catch(() => {
        session.remove(keys.staffSession);
        setLogin({ state: 'out' });
      });
  }, [login.state]);

  const logout = async () => {
    await api('/api/auth/logout', { method: 'POST', auth: 'staff' }).catch(() => undefined);
    session.remove(keys.staffSession);
    setLogin({ state: 'out' });
  };

  if (login.state === 'checking') return <div className="center-message">確認しています…</div>;
  if (login.state === 'out') {
    return (
      <StaffLogin
        deviceName={device.name}
        onLogin={(res) => {
          session.set(keys.staffSession, res.token);
          setLogin({ state: 'in', employee: res.employee });
        }}
      />
    );
  }

  return (
    <div className="register">
      <header className="topbar">
        <strong>{device.name}</strong>
        <span>
          担当: {login.employee.name}（{EMPLOYEE_ROLE_LABELS[login.employee.role]}）
        </span>
        <button className="btn" onClick={logout}>
          ログアウト
        </button>
      </header>
      <section className="placeholder">
        <h2>レジ</h2>
        <p>レジの開設・商品選択・会計はフェーズ3で実装します。</p>
      </section>
    </div>
  );
}

function StaffLogin({ deviceName, onLogin }: { deviceName: string; onLogin: (res: StaffSessionResponse) => void }) {
  const [step, setStep] = useState<'code' | 'pin'>('code');
  const [code, setCode] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      onLogin(await api<StaffSessionResponse>('/api/auth/login', { method: 'POST', body: { code, pin } }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'ログインに失敗しました');
      setPin('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="panel-page">
      <div className="panel panel--wide">
        <h1>{deviceName} ログイン</h1>
        <div className="login-steps">
          <div>
            {step === 'code' ? (
              <Keypad label="従業員コード" value={code} onChange={setCode} />
            ) : (
              <Keypad label={`PIN（従業員コード ${code}）`} value={pin} onChange={setPin} masked />
            )}
          </div>
          <div className="login-steps__actions">
            {error && <p className="error">{error}</p>}
            {step === 'code' ? (
              <button className="btn btn--primary btn--block" disabled={!code} onClick={() => setStep('pin')}>
                次へ
              </button>
            ) : (
              <>
                <button className="btn btn--primary btn--block" disabled={pin.length < 4 || busy} onClick={submit}>
                  {busy ? 'ログイン中…' : 'ログイン'}
                </button>
                <button
                  className="btn btn--block"
                  onClick={() => {
                    setStep('code');
                    setPin('');
                    setError(null);
                  }}
                >
                  従業員コードを入力し直す
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
