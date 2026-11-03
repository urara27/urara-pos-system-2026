import { useEffect, useState } from 'react';
import type { ReceiptDocument, ReceiptRow } from '@pos/shared';
import { api, ApiError } from '../lib/api';
import { openPdf } from '../lib/pdf';

interface ReceiptView {
  document: ReceiptDocument;
  rows: ReceiptRow[];
}

/** レシートの行を、ロール紙のような見た目で描く（PDF・印刷と同じ行データ） */
export function ReceiptPaper({ rows }: { rows: ReceiptRow[] }) {
  return (
    <div className="receipt-paper" role="document" aria-label="レシート">
      {rows.map((row, i) => {
        if (row.type === 'space') return <div key={i} className="receipt-space" />;
        if (row.type === 'rule') return <hr key={i} className={`receipt-rule receipt-rule--${row.style ?? 'solid'}`} />;
        const cls = `receipt-row receipt-row--${row.size ?? 'normal'}${row.bold ? ' is-bold' : ''}`;
        const style = row.indent ? { paddingLeft: `${row.indent}em` } : undefined;
        if (row.type === 'pair') {
          return (
            <div key={i} className={`${cls} receipt-row--pair`} style={style}>
              <span>{row.left}</span>
              <span>{row.right}</span>
            </div>
          );
        }
        return (
          <div key={i} className={cls} style={{ ...style, textAlign: row.align ?? 'left' }}>
            {row.text}
          </div>
        );
      })}
    </div>
  );
}

/**
 * レシートのプレビュー（ダミードライバー: プリンター導入までは画面と PDF で確認する）。
 * 「再発行」すると「再発行」と明記したレシートに切り替わり、操作ログに残る。
 */
export function ReceiptDialog({ transactionId, onClose }: { transactionId: number; onClose: () => void }) {
  const [view, setView] = useState<ReceiptView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<ReceiptView>(`/api/transactions/${transactionId}/receipt`, { auth: 'staff' })
      .then(setView)
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : 'レシートを読み込めませんでした'));
  }, [transactionId]);

  const reprint = async () => {
    if (!window.confirm('「再発行」と明記したレシートを発行します。よろしいですか？')) return;
    setBusy(true);
    try {
      setView(await api<ReceiptView>(`/api/transactions/${transactionId}/reprint`, { method: 'POST', auth: 'staff' }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '再発行できませんでした');
    } finally {
      setBusy(false);
    }
  };

  const pdf = () => {
    const reprinted = view?.document.reprint ? '1' : '0';
    openPdf(`/api/transactions/${transactionId}/receipt.pdf?reprint=${reprinted}`, 'staff').catch(() =>
      setError('PDF を開けませんでした'),
    );
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal receipt-dialog" role="dialog" aria-modal="true" aria-label="レシート">
        <div className="modal__header">
          <h2>{view?.document.reprint ? 'レシート（再発行）' : 'レシート'}</h2>
          <button type="button" className="btn btn--small" onClick={onClose} aria-label="閉じる">
            ✕
          </button>
        </div>
        <p className="muted small">プリンター導入までは、この画面か PDF でご確認ください。領収書が必要な場合は手書きで発行します。</p>
        {error && <p className="error">{error}</p>}
        <div className="receipt-dialog__body">{view ? <ReceiptPaper rows={view.rows} /> : !error && <p className="muted">読み込み中…</p>}</div>
        <div className="row row--end">
          <button className="btn" disabled={!view} onClick={pdf}>
            PDF を開く
          </button>
          <button className="btn" disabled={!view || busy || view.document.reprint} onClick={reprint}>
            再発行
          </button>
        </div>
      </div>
    </div>
  );
}
