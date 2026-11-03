import { useState } from 'react';
import { KITCHEN_VIEWS, type KitchenView } from '@pos/shared';
import { useDevice, useDeviceRealtime } from '../components/DeviceGate';
import { useWakeLock } from '../lib/hooks';
import { keys, local } from '../lib/storage';

const VIEW_LABELS: Record<KitchenView, string> = { all: 'すべて', food: 'フード', drink: 'ドリンク' };

function loadView(): KitchenView {
  const saved = local.get(keys.kitchenView);
  return KITCHEN_VIEWS.includes(saved as KitchenView) ? (saved as KitchenView) : 'all';
}

/** キッチンモニター。表示範囲は端末ごとに保存する（再起動後も維持）。注文カードはフェーズ3 */
export function KitchenPage() {
  const device = useDevice();
  const [view, setView] = useState<KitchenView>(loadView);
  useWakeLock();
  useDeviceRealtime();

  const changeView = (next: KitchenView) => {
    local.set(keys.kitchenView, next);
    setView(next);
  };

  return (
    <div className="kitchen">
      <header className="topbar">
        <strong>{device.name}</strong>
        <div className="segmented" role="radiogroup" aria-label="表示範囲">
          {KITCHEN_VIEWS.map((v) => (
            <button
              key={v}
              role="radio"
              aria-checked={view === v}
              className={view === v ? 'is-active' : ''}
              onClick={() => changeView(v)}
            >
              {VIEW_LABELS[v]}
            </button>
          ))}
        </div>
      </header>
      <section className="placeholder">
        <h2>キッチン（{VIEW_LABELS[view]}）</h2>
        <p>注文カードの表示と調理完了操作はフェーズ3で実装します。</p>
      </section>
    </div>
  );
}
