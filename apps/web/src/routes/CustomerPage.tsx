import { useEffect, useRef, useState } from 'react';
import { formatOrderNumber, type OrderView } from '@pos/shared';
import { useDeviceRealtime } from '../components/DeviceGate';
import { useDeviceSettings } from '../lib/deviceSettings';
import { useWakeLock } from '../lib/hooks';
import { playChime, unlockAudio } from '../lib/sound';
import { useOrderBoard } from '../realtime/orderBoard';

/** 新しく呼び出した番号を強調する時間 */
const HIGHLIGHT_MS = 10_000;
/** 1ページに出す数（超えたら自動でページ送り） */
const PAGE_SIZE = { preparing: 30, calling: 12 };
const PAGE_INTERVAL_MS = 8_000;

/** 件数に応じて文字を小さくする */
const sizeClass = (count: number, steps: [number, number]) =>
  count <= steps[0] ? 'is-large' : count <= steps[1] ? 'is-medium' : 'is-small';

function usePaged<T>(items: T[], size: number) {
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(items.length / size));
  useEffect(() => {
    if (pages <= 1) {
      setPage(0);
      return;
    }
    const timer = setInterval(() => setPage((p) => (p + 1) % pages), PAGE_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [pages]);
  const current = Math.min(page, pages - 1);
  return { visible: items.slice(current * size, (current + 1) * size), page: current, pages };
}

/**
 * カスタマーモニター。操作不要の全画面表示。
 * 音声の自動再生制限に対応するため、起動時に一度タップしてもらう（要件3.4）。
 */
export function CustomerPage() {
  const [started, setStarted] = useState(false);
  const { board, reload, apply } = useOrderBoard();
  const { settings, reload: reloadSettings } = useDeviceSettings();
  /** 番号 → 強調を終える時刻 */
  const [highlight, setHighlight] = useState<Record<number, number>>({});
  const startedRef = useRef(started);
  startedRef.current = started;
  useWakeLock(started);

  useDeviceRealtime({
    onSync: () => {
      reload();
      reloadSettings();
    },
    handlers: {
      'order.updated': (e) => {
        apply(e.payload.order);
        if (e.payload.change === 'called' || e.payload.change === 'recalled') {
          setHighlight((h) => ({ ...h, [e.payload.order.id]: Date.now() + HIGHLIGHT_MS }));
          if (startedRef.current) playChime();
        }
      },
      'settings.updated': reloadSettings,
    },
  });

  // 強調の期限切れを掃除する
  useEffect(() => {
    const timer = setInterval(() => {
      const now = Date.now();
      setHighlight((h) => {
        const next = Object.fromEntries(Object.entries(h).filter(([, until]) => until > now));
        return Object.keys(next).length === Object.keys(h).length ? h : next;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const preparing = board.active.filter((o) => o.status === 'accepted');
  // 呼び出しは新しいものを先頭に
  const calling = board.active
    .filter((o) => o.status === 'calling')
    .sort((a, b) => (b.calledAt ?? 0) - (a.calledAt ?? 0));
  const prepPaged = usePaged(preparing, PAGE_SIZE.preparing);
  const callPaged = usePaged(calling, PAGE_SIZE.calling);

  const start = async () => {
    await unlockAudio();
    playChime();
    // キオスク表示を前提に、可能なら全画面にする
    await document.documentElement.requestFullscreen?.().catch(() => undefined);
    setStarted(true);
  };

  if (!started) {
    return (
      <button className="tap-to-start" onClick={start}>
        <span className="tap-to-start__title">画面をタップして開始</span>
        <span className="tap-to-start__sub">呼び出しチャイムを鳴らすために必要です</span>
      </button>
    );
  }

  const numberList = (orders: OrderView[], cls: string) =>
    orders.map((o) => (
      <span key={o.id} className={`cnum ${cls}${highlight[o.id] ? ' is-new' : ''}`}>
        {formatOrderNumber(o.orderNumber)}
      </span>
    ));

  return (
    <div className="customer">
      {(settings?.storeName || settings?.customerMessage) && (
        <header className="customer__header">
          <span className="customer__store">{settings?.storeName}</span>
          <span className="customer__message">{settings?.customerMessage}</span>
        </header>
      )}
      <div className="customer__areas">
        <section className="customer__area customer__area--preparing">
          <h2>おつくり中</h2>
          <div className={`customer__numbers ${sizeClass(prepPaged.visible.length, [12, 20])}`}>
            {numberList(prepPaged.visible, 'cnum--preparing')}
          </div>
          {prepPaged.pages > 1 && <p className="customer__page">{prepPaged.page + 1} / {prepPaged.pages}</p>}
        </section>
        <section className="customer__area customer__area--calling">
          <h2>お呼び出し中</h2>
          <div className={`customer__numbers ${sizeClass(callPaged.visible.length, [4, 8])}`}>
            {numberList(callPaged.visible, 'cnum--calling')}
          </div>
          {callPaged.pages > 1 && <p className="customer__page">{callPaged.page + 1} / {callPaged.pages}</p>}
        </section>
      </div>
    </div>
  );
}
