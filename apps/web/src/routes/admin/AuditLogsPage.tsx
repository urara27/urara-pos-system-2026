import { Fragment, useCallback, useEffect, useState } from 'react';
import { AUDIT_CATEGORIES, yenText, type AuditCategory, type AuditLogEntry } from '@pos/shared';
import { adminApi, errorMessage, PageHeader } from './common';

const dateTime = (ms: number) => new Date(ms).toLocaleString('ja-JP');
const yenOf = (v: unknown) => (typeof v === 'number' ? yenText(v) : '—');

/** before / after を「項目: 前 → 後」の短い文にする（細かい内容は「詳細」で見る） */
function summarize(log: AuditLogEntry): string {
  const after = (log.after ?? {}) as Record<string, unknown>;
  const before = (log.before ?? {}) as Record<string, unknown>;
  if (log.action === 'product.price_changed') {
    return `店内 ${yenOf(before.priceEatIn)} → ${yenOf(after.priceEatIn)}`;
  }
  if (log.action === 'refund.created' || log.action === 'exchange.created') {
    return `${String(after.originalReceiptNumber ?? '')} 差額 ${yenOf(after.difference)}・理由「${String(after.reason ?? '')}」`;
  }
  if (log.action === 'discount.applied') {
    const list = (after.discounts as { name: string; manual: boolean }[] | undefined) ?? [];
    return `${String(after.receiptNumber ?? '')} ${list.map((d) => d.name).join('・')}（計 ${yenOf(after.discountTotal)}）`;
  }
  if (log.action === 'settings.updated') return `変更: ${Object.keys(after).join('・')}`;
  if (log.action === 'register.closed') return `実査 ${yenOf(after.countedCash)}・過不足 ${yenOf(after.cashDifference)}`;
  if (log.action === 'receipt.reprinted') return String(after.receiptNumber ?? '');
  const name = (after.name ?? before.name) as string | undefined;
  return name ? `「${name}」` : '';
}

/** 操作ログ（要件3.8・4.5）。返金・割引・価格変更・設定変更などを新しい順に出す */
export function AuditLogsPage() {
  const [category, setCategory] = useState<AuditCategory | ''>('');
  const [logs, setLogs] = useState<AuditLogEntry[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(null);

  const load = useCallback(
    (beforeId?: number) => {
      const q = new URLSearchParams({ limit: '50' });
      if (category) q.set('category', category);
      if (beforeId) q.set('beforeId', String(beforeId));
      adminApi<{ logs: AuditLogEntry[]; nextBeforeId: number | null }>(`/api/admin/audit-logs?${q}`)
        .then((res) => {
          setLogs((prev) => (beforeId ? [...prev, ...res.logs] : res.logs));
          setNext(res.nextBeforeId);
          setError(null);
        })
        .catch((err: unknown) => setError(errorMessage(err, '読み込めませんでした')));
    },
    [category],
  );
  useEffect(() => load(), [load]);

  return (
    <>
      <PageHeader title="操作ログ" />
      <section className="card">
        <div className="chips">
          <button className={category === '' ? 'chip is-active' : 'chip'} onClick={() => setCategory('')}>
            すべて
          </button>
          {(Object.keys(AUDIT_CATEGORIES) as AuditCategory[]).map((c) => (
            <button key={c} className={category === c ? 'chip is-active' : 'chip'} onClick={() => setCategory(c)}>
              {AUDIT_CATEGORIES[c]}
            </button>
          ))}
        </div>
        {error && <p className="error">{error}</p>}
        {logs.length === 0 ? (
          <p className="muted">記録がありません。</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>日時</th>
                  <th>分類</th>
                  <th>操作</th>
                  <th>内容</th>
                  <th>操作者</th>
                  <th>端末</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {logs.map((l) => (
                  <Fragment key={l.id}>
                    <tr>
                      <td>{dateTime(l.createdAt)}</td>
                      <td>{AUDIT_CATEGORIES[l.category]}</td>
                      <td>{l.actionLabel}</td>
                      <td>{summarize(l)}</td>
                      <td>{l.employeeName ?? '—'}</td>
                      <td>{l.deviceName ?? '管理画面'}</td>
                      <td>
                        <button className="btn btn--small" onClick={() => setOpen(open === l.id ? null : l.id)}>
                          {open === l.id ? '閉じる' : '詳細'}
                        </button>
                      </td>
                    </tr>
                    {open === l.id && (
                      <tr className="audit-detail">
                        <td colSpan={7}>
                          <div className="audit-detail__grid">
                            <div>
                              <strong>変更前</strong>
                              <pre>{l.before ? JSON.stringify(l.before, null, 2) : '—'}</pre>
                            </div>
                            <div>
                              <strong>変更後</strong>
                              <pre>{l.after ? JSON.stringify(l.after, null, 2) : '—'}</pre>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {next !== null && (
          <div className="row row--end">
            <button className="btn" onClick={() => load(next)}>
              さらに読み込む
            </button>
          </div>
        )}
      </section>
    </>
  );
}
