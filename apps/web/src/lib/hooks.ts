import { useEffect, useState } from 'react';
import { useConnection } from '../realtime/connection';

/**
 * 画面のスリープを防ぐ（キッチン・カスタマーモニター用）。
 * Wake Lock は HTTPS が必要で、タブが非表示になると解除されるので、表示に戻ったら取り直す。
 */
export function useWakeLock(enabled = true) {
  useEffect(() => {
    if (!enabled || !('wakeLock' in navigator)) return;
    let sentinel: WakeLockSentinel | null = null;
    let cancelled = false;
    const acquire = async () => {
      try {
        sentinel = await navigator.wakeLock.request('screen');
        if (cancelled) void sentinel.release();
      } catch {
        // 非対応・権限なし。手順書の代替手段（OS のスリープ設定）に任せる
      }
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') void acquire();
    };
    void acquire();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      void sentinel?.release();
    };
  }, [enabled]);
}

/** サーバー時刻を基準にした現在時刻（ms）を一定間隔で返す */
export function useServerNow(intervalMs = 1000) {
  const offset = useConnection((s) => s.clockOffsetMs);
  const [now, setNow] = useState(() => Date.now() + offset);
  useEffect(() => {
    setNow(Date.now() + offset);
    const timer = setInterval(() => setNow(Date.now() + offset), intervalMs);
    return () => clearInterval(timer);
  }, [offset, intervalMs]);
  return now;
}
