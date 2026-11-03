import { useState } from 'react';
import {
  DINING_OPTION_LABELS,
  formatOrderNumber,
  isStationDone,
  KITCHEN_VIEWS,
  kitchenItems,
  STATIONS,
  type KitchenView,
  type OrderView,
} from '@pos/shared';
import { useDevice, useDeviceRealtime } from '../components/DeviceGate';
import { useToast } from '../components/Toast';
import { api, ApiError } from '../lib/api';
import { useDeviceSettings } from '../lib/deviceSettings';
import { useServerNow, useWakeLock } from '../lib/hooks';
import { playNotify, unlockAudio } from '../lib/sound';
import { keys, local } from '../lib/storage';
import { useOrderBoard } from '../realtime/orderBoard';

const VIEW_LABELS: Record<KitchenView, string> = { all: 'すべて', food: 'フード', drink: 'ドリンク' };
const HISTORY_LIMIT = 8;

function loadView(): KitchenView {
  const saved = local.get(keys.kitchenView);
  return KITCHEN_VIEWS.includes(saved as KitchenView) ? (saved as KitchenView) : 'all';
}

/** この表示範囲で、まだ調理が残っているか */
function pendingFor(order: OrderView, view: KitchenView) {
  const stations = view === 'all' ? STATIONS : [view];
  return stations.some((s) => !isStationDone(order, s));
}

/** この表示範囲の明細があるか（完了済みを含む） */
function relevantFor(order: OrderView, view: KitchenView) {
  const stations = view === 'all' ? STATIONS : [view];
  return stations.some((s) => order.stations[s].hasItems);
}

/** この表示範囲で完了にした時刻（すべて完了していれば最も遅い時刻） */
function doneAtFor(order: OrderView, view: KitchenView) {
  const stations = (view === 'all' ? STATIONS : [view]).filter((s) => order.stations[s].hasItems);
  if (stations.some((s) => order.stations[s].completedAt === null)) return null;
  return Math.max(...stations.map((s) => order.stations[s].completedAt!));
}

const elapsedLabel = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/**
 * キッチンモニター。受付順にカードを並べ、タップでそのステーションの調理を完了にする。
 * 表示範囲（すべて／フード／ドリンク）は端末ごとに保存し、再起動後も維持する。
 */
export function KitchenPage() {
  const device = useDevice();
  const [view, setView] = useState<KitchenView>(loadView);
  const [soundOn, setSoundOn] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const { board, reload, apply } = useOrderBoard();
  const { settings, reload: reloadSettings } = useDeviceSettings();
  const showToast = useToast((s) => s.show);
  const now = useServerNow(1000);
  useWakeLock();

  useDeviceRealtime({
    onSync: () => {
      reload();
      reloadSettings();
    },
    handlers: {
      'order.updated': (e) => {
        const { order, change } = e.payload;
        apply(order);
        if (change === 'created' && relevantFor(order, view)) playNotify();
        // 変更・取消は目立つように知らせる（カードには「変更あり」が付き、取消はカードが消える）
        if ((change === 'cancelled' || change === 'modified') && relevantFor(order, view)) {
          playNotify();
          showToast(
            change === 'cancelled'
              ? `⚠ 注文 ${formatOrderNumber(order.orderNumber)} は取消になりました`
              : `⚠ 注文 ${formatOrderNumber(order.orderNumber)} の内容が変更されました`,
          );
        }
      },
      'settings.updated': reloadSettings,
    },
  });

  const changeView = (next: KitchenView) => {
    local.set(keys.kitchenView, next);
    setView(next);
  };

  const act = async (order: OrderView, done: boolean) => {
    setBusyId(order.id);
    try {
      apply(await api<OrderView>(`/api/orders/${order.id}/stations/${view}/${done ? 'complete' : 'reopen'}`, { method: 'POST' }));
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : '操作できませんでした');
      reload();
    } finally {
      setBusyId(null);
    }
  };

  const cards = board.active.filter((o) => relevantFor(o, view) && pendingFor(o, view));
  // 直近に完了したもの（受け渡し前でこの範囲が完了したもの + 受け渡し済み・取消）
  const history = [...board.active, ...board.recent]
    .filter((o) => relevantFor(o, view) && !pendingFor(o, view))
    .map((o) => ({ order: o, doneAt: doneAtFor(o, view) ?? o.completedAt ?? o.cancelledAt ?? o.acceptedAt }))
    .sort((a, b) => b.doneAt - a.doneAt)
    .slice(0, HISTORY_LIMIT);

  const warn = (settings?.kitchenWarnSeconds ?? 300) * 1000;
  const alert = (settings?.kitchenAlertSeconds ?? 600) * 1000;

  return (
    <div className="kitchen">
      <header className="topbar">
        <strong>{device.name}</strong>
        <div className="segmented" role="radiogroup" aria-label="表示範囲">
          {KITCHEN_VIEWS.map((v) => (
            <button key={v} role="radio" aria-checked={view === v} className={view === v ? 'is-active' : ''} onClick={() => changeView(v)}>
              {VIEW_LABELS[v]}
            </button>
          ))}
        </div>
        <span className="kitchen__count">未完了 {cards.length}件</span>
        {!soundOn && (
          <button
            className="btn"
            onClick={async () => {
              setSoundOn(await unlockAudio());
              playNotify();
            }}
          >
            🔈 通知音を有効にする
          </button>
        )}
      </header>

      <div className="kitchen__body">
        <main className="kitchen__cards">
          {board.loaded && cards.length === 0 && <p className="kitchen__empty">調理待ちの注文はありません</p>}
          {cards.map((o) => {
            const elapsed = now - o.acceptedAt;
            const level = elapsed >= alert ? 'alert' : elapsed >= warn ? 'warn' : 'normal';
            return (
              <button
                key={o.id}
                className={`kcard kcard--${level}${o.status === 'calling' ? ' is-calling' : ''}${o.modifiedAt ? ' is-modified' : ''}`}
                disabled={busyId === o.id}
                onClick={() => act(o, true)}
                aria-label={`注文 ${formatOrderNumber(o.orderNumber)} を調理完了にする`}
              >
                <div className="kcard__head">
                  <span className="kcard__number">{formatOrderNumber(o.orderNumber)}</span>
                  <span className={`kcard__dining kcard__dining--${o.diningOption}`}>{DINING_OPTION_LABELS[o.diningOption]}</span>
                </div>
                <div className="kcard__meta">
                  <span>{new Date(o.acceptedAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })} 受付</span>
                  <span className="kcard__elapsed">{elapsedLabel(elapsed)}</span>
                </div>
                {o.status === 'calling' && <div className="kcard__flag">呼び出し中</div>}
                {o.modifiedAt && <div className="kcard__flag kcard__flag--modified">変更あり</div>}
                <ul className="kcard__items">
                  {kitchenItems(o, view).map((item) => (
                    <li key={item.key}>
                      <span className="kcard__qty">{item.quantity}</span>
                      <span>
                        {item.name}
                        {item.parentName && <small className="kcard__parent">（{item.parentName}）</small>}
                        {item.options.length > 0 && <small className="kcard__options">{item.options.join('・')}</small>}
                      </span>
                    </li>
                  ))}
                </ul>
                {view === 'all' && (
                  <div className="kcard__stations">
                    {STATIONS.filter((s) => o.stations[s].hasItems).map((s) => (
                      <span key={s} className={isStationDone(o, s) ? 'is-done' : ''}>
                        {VIEW_LABELS[s]}
                        {isStationDone(o, s) ? ' ✓' : ''}
                      </span>
                    ))}
                  </div>
                )}
                <div className="kcard__tap">タップで完了</div>
              </button>
            );
          })}
        </main>

        <aside className="kitchen__history">
          <h2>直近に完了</h2>
          {history.length === 0 && <p className="muted small">まだありません</p>}
          <ul>
            {history.map(({ order: o, doneAt }) => {
              const active = o.status === 'accepted' || o.status === 'calling';
              return (
                <li key={o.id}>
                  <span className="kitchen__history-number">{formatOrderNumber(o.orderNumber)}</span>
                  <span className="muted small">
                    {new Date(doneAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}
                    {o.status === 'completed' ? ' 受渡済' : o.status === 'cancelled' ? ' 取消' : ''}
                  </span>
                  {active && (
                    <button className="btn btn--small" disabled={busyId === o.id} onClick={() => act(o, false)}>
                      戻す
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </aside>
      </div>
    </div>
  );
}
