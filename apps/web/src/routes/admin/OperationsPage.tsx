import { useCallback, useEffect, useState } from 'react';
import { adminApi, errorMessage, PageHeader } from './common';
import { SimpleTable } from './SalesPage';

interface BusinessDayRow {
  date: string;
  status: 'open' | 'closed';
  openedAt: number;
  closedAt: number | null;
  closedBy: 'manual' | 'auto' | null;
  closedByName: string | null;
}

interface OperationsStatus {
  currentDate: string;
  current: BusinessDayRow | null;
  openRegisters: { registerName: string; deviceName: string; openedAt: number; openedByName: string }[];
  recentDays: BusinessDayRow[];
  backups: { name: string; size: number; createdAt: number }[];
  backupDir: string;
}

const dateTime = (ms: number) => new Date(ms).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const size = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`);

/**
 * 営業日（閉店・再開）とバックアップ（確認事項 Q9・要件4.5）。
 * 閉店は全レジの閉設後に行い、閉店時にバックアップを取る。閉店を忘れても切替時刻に自動で閉じる。
 */
export function OperationsPage() {
  const [s, setS] = useState<OperationsStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    adminApi<OperationsStatus>('/api/admin/operations')
      .then((res) => {
        setS(res);
        setError(null);
      })
      .catch((err: unknown) => setError(errorMessage(err, '読み込めませんでした')));
  }, []);
  useEffect(load, [load]);

  const run = async (fn: () => Promise<string>) => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      setMessage(await fn());
    } catch (err) {
      setError(errorMessage(err, '実行できませんでした'));
    } finally {
      setBusy(false);
      load();
    }
  };

  const close = () => {
    if (!window.confirm(`${s?.currentDate} の営業を終了（閉店）します。閉店後、この営業日には会計できません。よろしいですか？`)) return;
    void run(async () => {
      const res = await adminApi<{ date: string; backup: { name: string } | null }>('/api/admin/business-day/close', { method: 'POST' });
      return res.backup ? `閉店しました。バックアップ ${res.backup.name} を作成しました` : '閉店しました（バックアップに失敗しました。サーバーのログを確認してください）';
    });
  };
  const reopen = () => {
    if (!window.confirm(`${s?.currentDate} の営業を再開します。よろしいですか？`)) return;
    void run(async () => {
      await adminApi('/api/admin/business-day/reopen', { method: 'POST' });
      return '営業を再開しました';
    });
  };
  const backup = () =>
    void run(async () => {
      const res = await adminApi<{ name: string }>('/api/admin/backups', { method: 'POST' });
      return `バックアップ ${res.name} を作成しました`;
    });

  if (!s) return error ? <p className="error">{error}</p> : <p className="muted">読み込み中…</p>;
  const closed = s.current?.status === 'closed';

  return (
    <>
      <PageHeader title="閉店・バックアップ" />
      {message && <p className="notice">{message}</p>}
      {error && <p className="error">{error}</p>}

      <section className="card">
        <h2>本日の営業（営業日 {s.currentDate}）</h2>
        <div className="row row--between">
          <p className="ops-state">
            {closed ? (
              <span className="diff diff--ok">
                ✓ 閉店済み（{dateTime(s.current!.closedAt!)}・{s.current!.closedBy === 'auto' ? '自動' : s.current!.closedByName}）
              </span>
            ) : (
              <span>
                営業中
                {s.openRegisters.length > 0 && <span className="muted">（開設中のレジ {s.openRegisters.length}台）</span>}
              </span>
            )}
          </p>
          <div className="row">
            {closed ? (
              <button className="btn" disabled={busy} onClick={reopen}>
                営業を再開
              </button>
            ) : (
              <button className="btn btn--primary" disabled={busy || s.openRegisters.length > 0} onClick={close}>
                閉店する
              </button>
            )}
          </div>
        </div>
        {!closed && s.openRegisters.length > 0 && (
          <>
            <p className="error">閉店する前に、次のレジを閉設してください（レジ端末の「レジ閉設」）。</p>
            <SimpleTable
              head={['レジ', '端末', '開設', '開設者']}
              rows={s.openRegisters.map((r) => [r.registerName, r.deviceName, dateTime(r.openedAt), r.openedByName])}
            />
          </>
        )}
        <p className="muted small">
          閉店すると営業日を閉じてバックアップを取ります。閉店を忘れた場合も、営業日の切替時刻を過ぎると自動で閉じてバックアップを取ります。自動採番は営業日が変わると開始番号から振り直されます。
        </p>
      </section>

      <section className="card">
        <div className="row row--between">
          <h2>バックアップ</h2>
          <button className="btn" disabled={busy} onClick={backup}>
            今すぐバックアップ
          </button>
        </div>
        <p className="muted small">
          保存先: <code>{s.backupDir}</code>（サーバーの <code>backups</code> フォルダ）。古いものから自動で削除し、決めた世代数だけ残します。復元の手順はセットアップ手順書の「バックアップと復元」を参照してください。
        </p>
        <SimpleTable head={['ファイル', '作成日時', 'サイズ']} rows={s.backups.map((b) => [b.name, dateTime(b.createdAt), size(b.size)])} />
      </section>

      <section className="card">
        <h2>最近の営業日</h2>
        <SimpleTable
          head={['営業日', '状態', '開始', '終了']}
          rows={s.recentDays.map((d) => [
            d.date,
            d.status === 'closed' ? (d.closedBy === 'auto' ? '閉店（自動）' : '閉店') : '営業中',
            dateTime(d.openedAt),
            d.closedAt ? `${dateTime(d.closedAt)}${d.closedByName ? ` ${d.closedByName}` : ''}` : '—',
          ])}
        />
      </section>
    </>
  );
}
