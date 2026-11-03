import { useState } from 'react';
import type { DiningOption, OptionGroup, Product } from '@pos/shared';
import { priceFor } from './cart';

const yen = (n: number) => `¥${n.toLocaleString('ja-JP')}`;

/** 既定の選択肢を初期選択にする（売切は除く） */
function initialSelection(groups: OptionGroup[]) {
  return Object.fromEntries(
    groups.map((g) => [g.id, g.options.filter((o) => o.isDefault && !o.soldOut).map((o) => o.id)]),
  ) as Record<number, number[]>;
}

/**
 * 商品のオプション選択。「1つを必ず選ぶ」グループは選ばないと追加できない。
 * 加算額0円の選択肢（無料トッピング）も明細に記録する。
 */
export function OptionPicker({
  product,
  groups,
  dining,
  onAdd,
  onClose,
}: {
  product: Product;
  groups: OptionGroup[];
  dining: DiningOption | null;
  onAdd: (optionIds: number[], quantity: number) => void;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState(() => initialSelection(groups));
  const [quantity, setQuantity] = useState(1);
  const base = priceFor(product, dining);

  const toggle = (group: OptionGroup, optionId: number) =>
    setSelected((s) => {
      const current = s[group.id] ?? [];
      if (group.selection === 'single') return { ...s, [group.id]: [optionId] };
      return {
        ...s,
        [group.id]: current.includes(optionId) ? current.filter((id) => id !== optionId) : [...current, optionId],
      };
    });

  const chosen = groups.flatMap((g) => g.options.filter((o) => (selected[g.id] ?? []).includes(o.id)));
  const missing = groups.filter((g) => g.selection === 'single' && (selected[g.id] ?? []).length === 0);
  const unit = base + chosen.reduce((s, o) => s + o.priceDelta, 0);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal option-picker" role="dialog" aria-modal="true" aria-label={`${product.name}のオプション`}>
        <div className="modal__header">
          <h2>
            {product.name} <span className="muted">{yen(base)}</span>
          </h2>
          <button type="button" className="btn btn--small" onClick={onClose} aria-label="閉じる">
            ✕
          </button>
        </div>
        {groups.map((g) => (
          <section key={g.id} className="option-picker__group">
            <h3>
              {g.name}
              <small className="muted">{g.selection === 'single' ? '（1つ選択・必須）' : '（複数選択可）'}</small>
            </h3>
            <div className="option-picker__choices">
              {g.options.map((o) => {
                const on = (selected[g.id] ?? []).includes(o.id);
                return (
                  <button
                    key={o.id}
                    type="button"
                    className={`choice${on ? ' is-selected' : ''}`}
                    disabled={o.soldOut}
                    aria-pressed={on}
                    onClick={() => toggle(g, o.id)}
                  >
                    <span>{o.name}</span>
                    <small>{o.soldOut ? '売切' : o.priceDelta > 0 ? `+${yen(o.priceDelta)}` : '±0'}</small>
                  </button>
                );
              })}
            </div>
          </section>
        ))}
        <div className="option-picker__footer">
          <div className="stepper">
            <button type="button" className="btn" onClick={() => setQuantity((q) => Math.max(1, q - 1))} aria-label="数量を減らす">
              −
            </button>
            <span className="stepper__value">{quantity}</span>
            <button type="button" className="btn" onClick={() => setQuantity((q) => Math.min(99, q + 1))} aria-label="数量を増やす">
              ＋
            </button>
          </div>
          <button
            type="button"
            className="btn btn--primary btn--large"
            disabled={missing.length > 0}
            onClick={() => onAdd(chosen.map((o) => o.id), quantity)}
          >
            {missing.length > 0 ? `${missing[0]!.name}を選んでください` : `追加 ${yen(unit * quantity)}`}
          </button>
        </div>
      </div>
    </div>
  );
}
