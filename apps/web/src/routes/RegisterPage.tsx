import { useCallback, useEffect, useState } from 'react';
import {
  EMPLOYEE_ROLE_LABELS,
  type CheckoutResult,
  type EmployeeInfo,
  type RegisterStatus,
  type StaffSessionResponse,
} from '@pos/shared';
import { useDevice, useDeviceRealtime } from '../components/DeviceGate';
import { Keypad } from '../components/Keypad';
import { api, ApiError } from '../lib/api';
import { useDeviceSettings } from '../lib/deviceSettings';
import { keys, session } from '../lib/storage';
import { toCheckoutLines, useCart, type Quote } from './register/cart';
import { CatalogView, useCatalog } from './register/CatalogView';
import { CheckoutComplete, PaymentPanel } from './register/PaymentPanel';
import { CloseRegister, OpenRegister, RegisterSelect } from './register/RegisterSession';

type Screen =
  | { name: 'select' }
  | { name: 'login'; register: RegisterStatus }
  | { name: 'open'; register: RegisterStatus; employee: EmployeeInfo }
  | { name: 'pos'; register: RegisterStatus; employee: EmployeeInfo; sessionId: number }
  | { name: 'pay'; register: RegisterStatus; employee: EmployeeInfo; sessionId: number; quote: Quote }
  | { name: 'done'; register: RegisterStatus; employee: EmployeeInfo; sessionId: number; result: CheckoutResult }
  | { name: 'close'; register: RegisterStatus; employee: EmployeeInfo; sessionId: number };

/**
 * レジ。起動時にレジ番号を選び → 従業員ログイン → （未開設なら）釣銭準備金を入れて開設 →
 * 商品選択 → 支払 → 注文番号の表示、の順に進む。
 */
export function RegisterPage() {
  const device = useDevice();
  const [screen, setScreen] = useState<Screen>({ name: 'select' });
  const catalog = useCatalog();
  const deviceSettings = useDeviceSettings();
  const cart = useCart();
  // 管理画面で商品・設定が変わったら、その場で反映する
  useDeviceRealtime({
    onSync: () => {
      catalog.reload();
      deviceSettings.reload();
    },
    handlers: { 'catalog.updated': catalog.reload, 'settings.updated': deviceSettings.reload },
  });

  /** ログイン済みなら、そのレジが開設済みかを見て次の画面へ */
  const proceed = useCallback(async (register: RegisterStatus, employee: EmployeeInfo) => {
    const { registers } = await api<{ registers: RegisterStatus[] }>('/api/register/registers');
    const latest = registers.find((r) => r.id === register.id) ?? register;
    if (latest.openSession?.mine) setScreen({ name: 'pos', register: latest, employee, sessionId: latest.openSession.id });
    else setScreen({ name: 'open', register: latest, employee });
  }, []);

  const onSelect = useCallback(
    (register: RegisterStatus) => {
      // タブを閉じていなければログインは残っている
      if (session.get(keys.staffSession)) {
        api<{ employee: EmployeeInfo }>('/api/auth/session', { auth: 'staff' })
          .then(({ employee }) => proceed(register, employee))
          .catch(() => {
            session.remove(keys.staffSession);
            setScreen({ name: 'login', register });
          });
      } else {
        setScreen({ name: 'login', register });
      }
    },
    [proceed],
  );

  const logout = async () => {
    await api('/api/auth/logout', { method: 'POST', auth: 'staff' }).catch(() => undefined);
    session.remove(keys.staffSession);
    if ('register' in screen) setScreen({ name: 'login', register: screen.register });
  };

  // 別の画面からレジ選択に戻ったら明細を消す
  useEffect(() => {
    if (screen.name === 'select') cart.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen.name]);

  switch (screen.name) {
    case 'select':
      return <RegisterSelect deviceName={device.name} onSelect={onSelect} />;
    case 'login':
      return (
        <StaffLogin
          title={`${screen.register.name} ログイン`}
          onBack={() => setScreen({ name: 'select' })}
          onLogin={(res) => {
            session.set(keys.staffSession, res.token);
            void proceed(screen.register, res.employee);
          }}
        />
      );
    case 'open':
      return (
        <OpenRegister
          register={screen.register}
          onBack={() => setScreen({ name: 'select' })}
          onOpened={(s) => setScreen({ ...screen, name: 'pos', sessionId: s.sessionId })}
        />
      );
    case 'close':
      return (
        <CloseRegister
          sessionId={screen.sessionId}
          onCancel={() => setScreen({ ...screen, name: 'pos' })}
          onClosed={() => {
            void logout().then(() => setScreen({ name: 'select' }));
          }}
        />
      );
    default:
  }

  const { register, employee, sessionId } = screen;
  const settings = deviceSettings.settings;

  return (
    <div className="register">
      <header className="topbar">
        <strong>{register.name}</strong>
        <span>
          担当: {employee.name}（{EMPLOYEE_ROLE_LABELS[employee.role]}）
        </span>
        {screen.name === 'pos' && (
          <div className="topbar__actions">
            <button className="btn" onClick={logout}>
              担当交代
            </button>
            <button
              className="btn"
              disabled={cart.lines.length > 0}
              title={cart.lines.length > 0 ? '明細があるときは閉設できません' : undefined}
              onClick={() => setScreen({ ...screen, name: 'close' })}
            >
              レジ閉設
            </button>
          </div>
        )}
      </header>

      {screen.name === 'pos' && (
        <CatalogView
          catalog={catalog.catalog}
          error={catalog.error}
          taxRounding={settings?.taxRounding ?? 'floor'}
          canManualDiscount={employee.canManualDiscount}
          onCheckout={(quote) => setScreen({ ...screen, name: 'pay', quote })}
        />
      )}
      {screen.name === 'pay' && (
        <PaymentPanel
          total={screen.quote.pricing.total}
          numberingMode={register.numberingMode}
          ticketRange={{ min: settings?.ticketNumberMin ?? 1, max: settings?.ticketNumberMax ?? 99 }}
          buildRequest={() => ({
            registerSessionId: sessionId,
            diningOption: cart.diningOption ?? 'eat_in',
            lines: toCheckoutLines(cart.lines),
            orderDiscounts: cart.orderDiscounts.map((d) => d.request),
          })}
          onCancel={() => setScreen({ ...screen, name: 'pos' })}
          onComplete={(result) => {
            cart.clear();
            setScreen({ name: 'done', register, employee, sessionId, result });
          }}
        />
      )}
      {screen.name === 'done' && (
        <CheckoutComplete result={screen.result} onNext={() => setScreen({ name: 'pos', register, employee, sessionId })} />
      )}
    </div>
  );
}

function StaffLogin({
  title,
  onLogin,
  onBack,
}: {
  title: string;
  onLogin: (res: StaffSessionResponse) => void;
  onBack: () => void;
}) {
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
        <h1>{title}</h1>
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
              <>
                <button className="btn btn--primary btn--block" disabled={!code} onClick={() => setStep('pin')}>
                  次へ
                </button>
                <button className="btn btn--block" onClick={onBack}>
                  レジの選択に戻る
                </button>
              </>
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
