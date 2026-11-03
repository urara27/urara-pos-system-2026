import { useCallback, useRef, useState } from 'react';
import {
  DEVICE_ROLE_LABELS,
  DEVICE_ROLES,
  type AdminDeviceRow,
  type DeviceRole,
  type EventEnvelope,
  type PairingCodeResponse,
  type PresencePayload,
} from '@pos/shared';
import { adminApi, errorMessage, PageHeader } from './common';

/**
 * 端末一覧と接続状態。接続状態はリアルタイムに変わるので、
 * ソケットを持つ管理画面の外枠で保持し、このページに渡す。
 */
export function useDevicePresence() {
  const [devices, setDevices] = useState<AdminDeviceRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const devicesRef = useRef(devices);
  devicesRef.current = devices;

  const reload = useCallback(() => {
    adminApi<{ devices: AdminDeviceRow[] }>('/api/admin/devices')
      .then((res) => {
        setDevices(res.devices);
        setError(null);
      })
      .catch((err: unknown) => setError(errorMessage(err, '読み込みに失敗しました')));
  }, []);

  const onPresence = useCallback(
    (e: EventEnvelope<PresencePayload>) => {
      // 新しく登録された端末が現れたら一覧ごと取り直す
      if (e.payload.onlineDeviceIds.some((id) => !devicesRef.current.some((d) => d.id === id))) {
        reload();
        return;
      }
      const online = new Set(e.payload.onlineDeviceIds);
      setDevices((prev) => prev.map((d) => ({ ...d, online: online.has(d.id) })));
    },
    [reload],
  );

  return { devices, error, reload, onPresence };
}

export type DevicePresence = ReturnType<typeof useDevicePresence>;

export function DevicesPage({ presence }: { presence: DevicePresence }) {
  return (
    <>
      <PageHeader title="端末" />
      {presence.error && <p className="error">{presence.error}</p>}
      <PairingCodeIssuer />
      <DeviceList devices={presence.devices} onChanged={presence.reload} />
      <PingSender />
    </>
  );
}

function PairingCodeIssuer() {
  const [role, setRole] = useState<DeviceRole>('register');
  const [issued, setIssued] = useState<PairingCodeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const issue = async () => {
    setError(null);
    try {
      setIssued(await adminApi<PairingCodeResponse>('/api/admin/pairing-codes', { method: 'POST', body: { role } }));
    } catch (err) {
      setError(errorMessage(err, '発行に失敗しました'));
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
    await adminApi(`/api/admin/devices/${device.id}`, { method: 'PATCH', body: { enabled: !device.enabled } }).catch(
      () => undefined,
    );
    onChanged();
  };

  return (
    <section className="card">
      <h2>登録済みの端末</h2>
      {devices.length === 0 ? (
        <p className="muted">まだ端末が登録されていません。</p>
      ) : (
        <div className="table-wrap">
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
        </div>
      )}
    </section>
  );
}

/** リアルタイム配信の疎通確認用。全端末にトーストを出す */
function PingSender() {
  const [message, setMessage] = useState('テスト通知です');
  const send = async () => {
    await adminApi('/api/admin/broadcast-ping', { method: 'POST', body: { message } }).catch(() => undefined);
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
