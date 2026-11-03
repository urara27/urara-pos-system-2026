import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { Navigate } from 'react-router';
import type { DeviceInfo, DeviceRole, EventEnvelope, HelloPayload, ServerToClientEvents } from '@pos/shared';
import { api, ApiError } from '../lib/api';
import { keys, local, readJson } from '../lib/storage';
import { useRealtime } from '../realtime/connection';
import { ConnectionBadge, OfflineBanner } from './ConnectionBadge';
import { Toast, useToast } from './Toast';

const DeviceContext = createContext<DeviceInfo | null>(null);

export function useDevice() {
  const device = useContext(DeviceContext);
  if (!device) throw new Error('useDevice は DeviceGate の内側で使う');
  return device;
}

export function clearDevice() {
  local.remove(keys.deviceToken);
  local.remove(keys.device);
}

type Check = { state: 'checking' } | { state: 'ok'; device: DeviceInfo } | { state: 'unpaired' };

/**
 * ペアリング済みの端末だけを通す。役割が違う画面を開いたら、その端末の画面へ移す。
 * サーバーに届かないときは保存済みの端末情報で表示を続け、再接続を待つ。
 */
export function DeviceGate({ role, children }: { role: DeviceRole; children: ReactNode }) {
  const [check, setCheck] = useState<Check>(() => {
    if (!local.get(keys.deviceToken)) return { state: 'unpaired' };
    return { state: 'checking' };
  });

  useEffect(() => {
    if (check.state !== 'checking') return;
    api<{ device: DeviceInfo }>('/api/devices/me')
      .then(({ device }) => {
        local.set(keys.device, JSON.stringify(device));
        setCheck({ state: 'ok', device });
      })
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 401) {
          clearDevice();
          setCheck({ state: 'unpaired' });
          return;
        }
        const cached = readJson<DeviceInfo>(local, keys.device);
        setCheck(cached ? { state: 'ok', device: cached } : { state: 'unpaired' });
      });
  }, [check.state]);

  if (check.state === 'unpaired') return <Navigate to="/pairing" replace />;
  if (check.state === 'checking') return <div className="center-message">端末を確認しています…</div>;
  if (check.device.role !== role) return <Navigate to={`/${check.device.role}`} replace />;

  return (
    <DeviceContext.Provider value={check.device}>
      <div className={`screen screen--${role}`}>
        <OfflineBanner />
        {children}
        <ConnectionBadge />
        <Toast />
      </div>
    </DeviceContext.Provider>
  );
}

type Handlers = Partial<{ [E in keyof ServerToClientEvents]: ServerToClientEvents[E] }>;

/**
 * 端末画面のリアルタイム接続。テスト通知（system.ping）は全画面でトースト表示する。
 * onSync は接続・再接続のたびに呼ばれるので、そこで全状態を取り直すこと。
 */
export function useDeviceRealtime(options: { onSync?: (hello: EventEnvelope<HelloPayload>) => void; handlers?: Handlers } = {}) {
  const showToast = useToast((s) => s.show);
  const token = local.get(keys.deviceToken);
  useRealtime({
    auth: token ? { deviceToken: token } : null,
    onSync: options.onSync,
    handlers: {
      'system.ping': (e) => showToast(`📣 ${e.payload.from}: ${e.payload.message}`),
      ...options.handlers,
    },
  });
}
