import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router';
import { DEVICE_ROLE_LABELS, type PairDeviceResponse } from '@pos/shared';
import { api, ApiError } from '../lib/api';
import { keys, local, readJson } from '../lib/storage';
import type { DeviceInfo } from '@pos/shared';

/** 未登録の端末で表示する。管理画面で発行したペアリングコードを入力して登録する */
export function PairingPage() {
  const navigate = useNavigate();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const paired = local.get(keys.deviceToken) ? readJson<DeviceInfo>(local, keys.device) : null;
  if (paired) return <Navigate to={`/${paired.role}`} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api<PairDeviceResponse>('/api/devices/pair', { method: 'POST', body: { code, name } });
      local.set(keys.deviceToken, res.token);
      local.set(keys.device, JSON.stringify(res.device));
      navigate(`/${res.device.role}`, { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '登録に失敗しました');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="panel-page">
      <form className="panel" onSubmit={submit}>
        <h1>端末の登録</h1>
        <p className="muted">
          管理画面の「端末」で発行した6桁のペアリングコードを入力してください。登録すると、この端末は
          {Object.values(DEVICE_ROLE_LABELS).join('・')}のいずれかとして固定されます。
        </p>
        <label className="field">
          <span>ペアリングコード</span>
          <input
            inputMode="numeric"
            pattern="\d{6}"
            maxLength={6}
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            required
          />
        </label>
        <label className="field">
          <span>端末名（例：レジ用iPad 1）</span>
          <input value={name} maxLength={40} onChange={(e) => setName(e.target.value)} required />
        </label>
        {error && <p className="error">{error}</p>}
        <button className="btn btn--primary btn--block" disabled={busy || code.length !== 6 || !name.trim()}>
          {busy ? '登録中…' : '登録する'}
        </button>
        <p className="muted small">
          管理画面は <a href="/admin">/admin</a> から開けます（登録不要）。
        </p>
      </form>
    </main>
  );
}
