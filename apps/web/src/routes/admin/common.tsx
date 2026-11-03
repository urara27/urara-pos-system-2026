import { useCallback, useEffect, useState, type InputHTMLAttributes, type ReactNode } from 'react';
import { yenText } from '@pos/shared';
import { api, ApiError } from '../../lib/api';

/** 管理 API 呼び出し（管理者セッション付き） */
export function adminApi<T>(path: string, options: { method?: 'GET' | 'POST' | 'PUT' | 'PATCH'; body?: unknown } = {}) {
  return api<T>(path, { ...options, auth: 'admin' });
}

export function errorMessage(err: unknown, fallback = 'エラーが発生しました') {
  return err instanceof ApiError ? err.message : fallback;
}

/** 金額の表示（マイナスは -¥900。レシートと同じ書き方） */
export const yen = yenText;

/** 一覧の取得と再読み込み */
export function useAdminList<T>(path: string, key: string) {
  const [items, setItems] = useState<T[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(() => {
    setLoading(true);
    adminApi<Record<string, T[]>>(path)
      .then((res) => {
        setItems(res[key] ?? []);
        setError(null);
      })
      .catch((err: unknown) => setError(errorMessage(err, '読み込みに失敗しました')))
      .finally(() => setLoading(false));
  }, [path, key]);
  useEffect(reload, [reload]);
  return { items, error, loading, reload };
}

// ───────── 画面部品 ─────────

export function PageHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="page-header">
      <h1>{title}</h1>
      <div className="row">{children}</div>
    </div>
  );
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal__header">
          <h2>{title}</h2>
          <button type="button" className="btn btn--small" onClick={onClose} aria-label="閉じる">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

interface FieldProps {
  label: string;
  hint?: string;
  required?: boolean;
  children: ReactNode;
}

/** DADS のフォームコントロールラベル: 項目名（太字）→ サポートテキスト → 入力欄 の順に並べる */
export function Field({ label, hint, required = false, children }: FieldProps) {
  return (
    <label className="field">
      <span>
        {label}
        {required && <span className="required">※必須</span>}
      </span>
      {hint && <span className="field__support">{hint}</span>}
      {children}
    </label>
  );
}

export function TextInput({
  label,
  value,
  onChange,
  hint,
  ...rest
}: { label: string; value: string; onChange: (v: string) => void; hint?: string } & Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'value' | 'onChange'
>) {
  return (
    <Field label={label} hint={hint} required={rest.required}>
      <input {...rest} value={value} onChange={(e) => onChange(e.target.value)} />
    </Field>
  );
}

/** 整数入力。空欄は null（nullable が許されない項目は呼び出し側で 0 等に寄せる） */
export function IntInput({
  label,
  value,
  onChange,
  hint,
  min,
  max,
  suffix,
}: {
  label: string;
  value: number | null;
  onChange: (v: number | null) => void;
  hint?: string;
  min?: number;
  max?: number;
  suffix?: string;
}) {
  return (
    <Field label={label} hint={hint}>
      <span className="input-suffix">
        <input
          type="number"
          inputMode="numeric"
          step={1}
          min={min}
          max={max}
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value === '' ? null : Math.trunc(Number(e.target.value)))}
        />
        {suffix && <span>{suffix}</span>}
      </span>
    </Field>
  );
}

export function Checkbox({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="checkbox">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

export function Select<T extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: T;
  onChange: (v: T) => void;
  options: readonly { value: T; label: string }[];
}) {
  return (
    <Field label={label}>
      <select value={value} onChange={(e) => onChange(e.target.value as T)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

export function StatusPill({ enabled }: { enabled: boolean }) {
  return <span className={`pill ${enabled ? 'pill--on' : 'pill--off'}`}>{enabled ? '有効' : '無効'}</span>;
}

/**
 * 編集ダイアログの共通の流れ: 保存中表示・エラー表示・成功したら閉じて一覧を再読み込み。
 */
export function useSave(onDone: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onDone();
    } catch (err) {
      setError(errorMessage(err, '保存に失敗しました'));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, save };
}

export function FormActions({ busy, error, onCancel }: { busy: boolean; error: string | null; onCancel: () => void }) {
  return (
    <div className="form-actions">
      {error && <p className="error">{error}</p>}
      <div className="row row--end">
        <button type="button" className="btn" onClick={onCancel}>
          キャンセル
        </button>
        <button className="btn btn--primary" disabled={busy}>
          {busy ? '保存中…' : '保存'}
        </button>
      </div>
    </div>
  );
}

/** epoch ms ⇄ <input type="datetime-local"> の値 */
export function toLocalInput(ms: number | null) {
  if (ms === null) return '';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromLocalInput(value: string) {
  return value === '' ? null : new Date(value).getTime();
}
