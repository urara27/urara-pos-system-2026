import { useState } from 'react';
import {
  DINING_OPTION_LABELS,
  formatOrderNumber,
  isKitchenDone,
  kitchenDoneAt,
  kitchenItems,
  ORDER_STATUS_LABELS,
  type OrderView,
} from '@pos/shared';
import { useDevice, useDeviceRealtime } from '../components/DeviceGate';
import { Keypad } from '../components/Keypad';
import { useToast } from '../components/Toast';
import { api, ApiError } from '../lib/api';
import { useDeviceSettings } from '../lib/deviceSettings';
import { useServerNow } from '../lib/hooks';
import { useOrderBoard } from '../realtime/orderBoard';

type Sort = 'accepted' | 'kitchenDone';
type Action = 'call' | 'recall' | 'uncall' | 'handover' | 'undo-handover';

const ACTION_LABELS: Record<Action, string> = {
  call: '呼び出し',
  recall: '再呼び出し',
  uncall: '呼び出し取消',
  handover: '受け渡し済み',
  'undo-handover': '呼び出し中に戻す',
};

/**
 * ピックアップ端末。未完了の注文を一覧し、調理完了の注文を目立たせる。
 * 一覧のタップかテンキーの番号入力で注文を選び、呼び出し・受け渡しをする。
 * 渡し間違いを防ぐため、選んだ注文の明細を必ず表示する。
 */
export function PickupPage() {
  const device = useDevice();
  const { board, reload, apply } = useOrderBoard();
  const { settings, reload: reloadSettings } = useDeviceSettings();
  const showToast = useToast((s) => s.show);
  const [sort, setSort] = useState<Sort>('accepted');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const now = useServerNow(5000);

  useDeviceRealtime({
    onSync: () => {
      reload();
      reloadSettings();
    },
    handlers: { 'order.updated': (e) => apply(e.payload.order), 'settings.updated': reloadSettings },
  });

  const all = [...board.active, ...board.recent];
  const selected = all.find((o) => o.id === selectedId) ?? null;
  const undoMs = (settings?.handoverUndoSeconds ?? 300) * 1000;
  const canUndo = (o: OrderView) => o.status === 'completed' && o.completedAt !== null && now - o.completedAt <= undoMs;

  const list = [...board.active].sort((a, b) => {
    if (sort === 'accepted') return a.acceptedAt - b.acceptedAt || a.id - b.id;
    // 調理完了順: 完了したものを完了の早い順に、未完了はその後ろに受付順
    const da = kitchenDoneAt(a);
    const db = kitchenDoneAt(b);
    if (da !== null && db !== null) return da - db;
    if (da !== null) return -1;
    if (db !== null) return 1;
    return a.acceptedAt - b.acceptedAt;
  });
  const recentlyHanded = board.recent.filter(canUndo);

  const findByNumber = () => {
    const n = Number(input);
    const order = board.active.find((o) => o.orderNumber === n);
    if (!order) {
      showToast(`番号 ${formatOrderNumber(n)} の未完了の注文はありません`);
      return;
    }
    setSelectedId(order.id);
    setInput('');
  };

  const act = async (order: OrderView, action: Action) => {
    if (action === 'handover' && !window.confirm(`注文 ${formatOrderNumber(order.orderNumber)} を受け渡し済みにしますか？`)) return;
    setBusy(true);
    try {
      const updated = await api<OrderView>(`/api/orders/${order.id}/${action}`, { method: 'POST' });
      apply(updated);
      if (action === 'handover') setSelectedId(null);
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : '操作できませんでした');
      reload();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pickup">
      <header className="topbar">
        <strong>{device.name}</strong>
        <div className="segmented" role="radiogroup" aria-label="並び順">
          <button role="radio" aria-checked={sort === 'accepted'} className={sort === 'accepted' ? 'is-active' : ''} onClick={() => setSort('accepted')}>
            受付順
          </button>
          <button role="radio" aria-checked={sort === 'kitchenDone'} className={sort === 'kitchenDone' ? 'is-active' : ''} onClick={() => setSort('kitchenDone')}>
            調理完了順
          </button>
        </div>
      </header>

      <div className="pickup__body">
        <section className="pickup__list">
          {board.loaded && list.length === 0 && <p className="muted">未完了の注文はありません</p>}
          <div className="pickup__grid">
            {list.map((o) => (
              <button
                key={o.id}
                className={`ptile${isKitchenDone(o) ? ' is-ready' : ''}${o.status === 'calling' ? ' is-calling' : ''}${o.id === selectedId ? ' is-selected' : ''}`}
                onClick={() => setSelectedId(o.id)}
              >
                <span className="ptile__number">{formatOrderNumber(o.orderNumber)}</span>
                <span className="ptile__status">
                  {o.status === 'calling' ? '呼び出し中' : isKitchenDone(o) ? '調理完了' : '調理中'}
                </span>
              </button>
            ))}
          </div>
          {recentlyHanded.length > 0 && (
            <div className="pickup__recent">
              <h2>受け渡し済み（戻せる注文）</h2>
              <div className="row">
                {recentlyHanded.map((o) => (
                  <button key={o.id} className="btn btn--small" onClick={() => setSelectedId(o.id)}>
                    {formatOrderNumber(o.orderNumber)}
                  </button>
                ))}
              </div>
            </div>
          )}
        </section>

        <aside className="pickup__side">
          {selected ? (
            <OrderDetail order={selected} busy={busy} canUndo={canUndo(selected)} onAct={(a) => act(selected, a)} onClose={() => setSelectedId(null)} />
          ) : (
            <div className="pickup__keypad">
              <Keypad label="注文番号" value={input} onChange={setInput} maxLength={3} />
              <button className="btn btn--primary btn--block btn--large" disabled={input === ''} onClick={findByNumber}>
                この番号を選ぶ
              </button>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

function OrderDetail({
  order,
  busy,
  canUndo,
  onAct,
  onClose,
}: {
  order: OrderView;
  busy: boolean;
  canUndo: boolean;
  onAct: (action: Action) => void;
  onClose: () => void;
}) {
  const actions: Action[] =
    order.status === 'accepted'
      ? ['call', 'handover']
      : order.status === 'calling'
        ? ['recall', 'uncall', 'handover']
        : canUndo
          ? ['undo-handover']
          : [];
  return (
    <div className="pdetail">
      <div className="pdetail__head">
        <span className="pdetail__number">{formatOrderNumber(order.orderNumber)}</span>
        <div>
          <div className={`pdetail__status pdetail__status--${order.status}`}>{ORDER_STATUS_LABELS[order.status]}</div>
          <div className="muted small">
            {DINING_OPTION_LABELS[order.diningOption]} ・ {isKitchenDone(order) ? '調理完了' : '調理中'}
          </div>
        </div>
        <button className="btn btn--small" onClick={onClose} aria-label="閉じる">
          ✕
        </button>
      </div>
      <ul className="pdetail__items">
        {kitchenItems(order, 'all').map((item) => (
          <li key={item.key}>
            <span className="kcard__qty">{item.quantity}</span>
            <span>
              {item.name}
              {item.options.length > 0 && <small className="kcard__options">{item.options.join('・')}</small>}
            </span>
          </li>
        ))}
      </ul>
      <div className="pdetail__actions">
        {actions.map((a) => (
          <button
            key={a}
            className={`btn btn--large btn--block${a === 'call' || a === 'handover' ? ' btn--primary' : ''}`}
            disabled={busy}
            onClick={() => onAct(a)}
          >
            {ACTION_LABELS[a]}
          </button>
        ))}
        {actions.length === 0 && <p className="muted">この注文は操作できません</p>}
      </div>
    </div>
  );
}
