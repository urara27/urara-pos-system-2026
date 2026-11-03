import { useEffect, useState, type FormEvent } from 'react';
import { TAX_ROUNDING_LABELS, TAX_ROUNDING_MODES, type StoreSettings } from '@pos/shared';
import { adminApi, Checkbox, errorMessage, Field, IntInput, PageHeader, Select, TextInput } from './common';

const pad = (n: number) => String(n).padStart(2, '0');
const minutesToTime = (m: number) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
const timeToMinutes = (t: string) => {
  const [h, m] = t.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

export function SettingsPage() {
  const [form, setForm] = useState<StoreSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    adminApi<{ settings: StoreSettings }>('/api/admin/settings')
      .then((res) => setForm(res.settings))
      .catch((err: unknown) => setError(errorMessage(err, '読み込みに失敗しました')));
  }, []);

  if (!form) return error ? <p className="error">{error}</p> : <p className="muted">読み込み中…</p>;

  const set = <K extends keyof StoreSettings>(key: K, value: StoreSettings[K]) =>
    setForm((f) => (f ? { ...f, [key]: value } : f));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await adminApi<{ settings: StoreSettings }>('/api/admin/settings', { method: 'PUT', body: form });
      setForm(res.settings);
      setMessage('保存しました');
    } catch (err) {
      setError(errorMessage(err, '保存に失敗しました'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit}>
      <PageHeader title="店舗・運用設定">
        <button className="btn btn--primary" disabled={busy}>
          {busy ? '保存中…' : '保存'}
        </button>
      </PageHeader>
      {error && <p className="error">{error}</p>}
      {message && <p className="notice">{message}</p>}

      <section className="card form form--grid">
        <h2 className="form--full">店舗情報（レシートに印字）</h2>
        <TextInput label="店舗名" value={form.storeName} maxLength={60} onChange={(v) => set('storeName', v)} />
        <TextInput
          label="店舗コード"
          hint="CSV 出力などで店舗を見分けるため（英数字）"
          value={form.storeCode}
          maxLength={20}
          required
          onChange={(v) => set('storeCode', v)}
        />
        <TextInput label="住所" value={form.address} maxLength={120} onChange={(v) => set('address', v)} />
        <TextInput label="電話番号" value={form.phone} maxLength={20} onChange={(v) => set('phone', v)} />
        <TextInput
          label="適格請求書発行事業者の登録番号"
          hint="T + 13桁の数字"
          placeholder="T1234567890123"
          value={form.invoiceRegistrationNumber}
          onChange={(v) => set('invoiceRegistrationNumber', v.trim())}
        />
        <Select
          label="税額の端数処理"
          value={form.taxRounding}
          options={TAX_ROUNDING_MODES.map((m) => ({ value: m, label: TAX_ROUNDING_LABELS[m] }))}
          onChange={(v) => set('taxRounding', v)}
        />
        <Field label="レシートのヘッダー">
          <textarea rows={3} maxLength={200} value={form.receiptHeader} onChange={(e) => set('receiptHeader', e.target.value)} />
        </Field>
        <Field label="レシートのフッター">
          <textarea rows={3} maxLength={200} value={form.receiptFooter} onChange={(e) => set('receiptFooter', e.target.value)} />
        </Field>
      </section>

      <section className="card form form--grid">
        <h2 className="form--full">注文番号</h2>
        <IntInput label="番号札モード 開始" min={1} max={999} value={form.ticketNumberMin} onChange={(v) => set('ticketNumberMin', v ?? 1)} />
        <IntInput label="番号札モード 終了" min={1} max={999} value={form.ticketNumberMax} onChange={(v) => set('ticketNumberMax', v ?? 1)} />
        <IntInput label="自動採番モード 開始" min={1} max={999} value={form.autoNumberMin} onChange={(v) => set('autoNumberMin', v ?? 1)} />
        <IntInput label="自動採番モード 終了" min={1} max={999} value={form.autoNumberMax} onChange={(v) => set('autoNumberMax', v ?? 1)} />
        <div className="form--full">
          <Checkbox
            label="営業日の開始時に自動採番を開始番号から振り直す"
            checked={form.autoNumberResetDaily}
            onChange={(v) => set('autoNumberResetDaily', v)}
          />
          <small className="muted">2つのモードの範囲は重ならないようにしてください（重なる設定は保存できません）。</small>
        </div>
      </section>

      <section className="card form form--grid">
        <h2 className="form--full">営業・キッチン・受け渡し</h2>
        <Field label="営業日の切替時刻" hint="この時刻より前の取引は前日の営業日として扱う（例: 04:00）">
          <input
            type="time"
            value={minutesToTime(form.businessDayCutoverMinutes)}
            onChange={(e) => set('businessDayCutoverMinutes', timeToMinutes(e.target.value))}
          />
        </Field>
        <IntInput
          label="受け渡し済みを戻せる時間"
          suffix="秒"
          min={0}
          max={3600}
          value={form.handoverUndoSeconds}
          onChange={(v) => set('handoverUndoSeconds', v ?? 0)}
        />
        <IntInput
          label="キッチン: 注意色にする経過時間"
          suffix="秒"
          min={30}
          value={form.kitchenWarnSeconds}
          onChange={(v) => set('kitchenWarnSeconds', v ?? 30)}
        />
        <IntInput
          label="キッチン: 警告色にする経過時間"
          suffix="秒"
          min={30}
          value={form.kitchenAlertSeconds}
          onChange={(v) => set('kitchenAlertSeconds', v ?? 30)}
        />
        <Field label="カスタマーモニターのメッセージ">
          <textarea rows={2} maxLength={200} value={form.customerMessage} onChange={(e) => set('customerMessage', e.target.value)} />
        </Field>
      </section>
    </form>
  );
}
