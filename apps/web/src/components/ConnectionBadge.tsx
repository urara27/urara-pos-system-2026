import { useConnection, type ConnectionStatus } from '../realtime/connection';

const LABELS: Record<ConnectionStatus, string> = {
  connecting: '接続中…',
  connected: 'オンライン',
  disconnected: '切断・再接続中',
  unauthorized: '未登録の端末',
};

/** 全画面に常に出す通信状態の表示（要件4.6） */
export function ConnectionBadge() {
  const status = useConnection((s) => s.status);
  return (
    <div className={`connection-badge connection-badge--${status}`} role="status" aria-live="polite">
      <span className="connection-badge__dot" />
      {LABELS[status]}
    </div>
  );
}

/** 切断中に画面上部へ出す警告帯。操作結果が他端末へ届かないことを明示する */
export function OfflineBanner() {
  const status = useConnection((s) => s.status);
  if (status === 'connected' || status === 'connecting') return null;
  return (
    <div className="offline-banner" role="alert">
      {status === 'unauthorized'
        ? 'この端末は登録が無効です。管理者に確認してください'
        : 'サーバーとの接続が切れています。自動で再接続しています'}
    </div>
  );
}
