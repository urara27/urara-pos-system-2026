import { useState } from 'react';
import { yenText, type Discount, type DiscountScope } from '@pos/shared';
import type { AppliedDiscount } from './cart';

const yen = yenText;
const describe = (d: Pick<Discount, 'kind' | 'value'>) => (d.kind === 'rate' ? `${d.value}%引` : `${yen(d.value)}引`);

/**
 * 割引の選択。管理画面で登録した割引から選ぶか、権限があれば手入力する。
 * 明細割引と会計割引のどちらでも使う（scope で絞り込む）。
 */
export function DiscountPicker({
  scope,
  discounts,
  canManual,
  targetLabel,
  onPick,
  onClose,
}: {
  scope: DiscountScope;
  discounts: Discount[];
  canManual: boolean;
  targetLabel: string;
  onPick: (discount: Omit<AppliedDiscount, 'key'>) => void;
  onClose: () => void;
}) {
  const [kind, setKind] = useState<'amount' | 'rate'>('amount');
  const [value, setValue] = useState('');
  const options = discounts.filter((d) => d.scope === scope);
  const manualValue = Number(value);
  const manualValid = Number.isInteger(manualValue) && manualValue >= 1 && (kind === 'amount' || manualValue <= 100);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="割引の選択">
        <div className="modal__header">
          <h2>{targetLabel}の割引</h2>
          <button type="button" className="btn btn--small" onClick={onClose} aria-label="閉じる">
            ✕
          </button>
        </div>
        {options.length === 0 ? (
          <p className="muted">使える割引・クーポンがありません。</p>
        ) : (
          <div className="option-picker__choices">
            {options.map((d) => (
              <button
                key={d.id}
                type="button"
                className="choice"
                onClick={() =>
                  onPick({ request: { discountId: d.id }, label: d.name, rule: { kind: d.kind, value: d.value } })
                }
              >
                <span>{d.name}</span>
                <small>{describe(d)}</small>
              </button>
            ))}
          </div>
        )}
        {canManual && (
          <section className="manual-discount">
            <h3>手入力</h3>
            <div className="row">
              <div className="segmented segmented--light" role="radiogroup" aria-label="種類">
                {(['amount', 'rate'] as const).map((k) => (
                  <button key={k} type="button" role="radio" aria-checked={kind === k} className={kind === k ? 'is-active' : ''} onClick={() => setKind(k)}>
                    {k === 'amount' ? '金額（円）' : '率（%）'}
                  </button>
                ))}
              </div>
              <input
                inputMode="numeric"
                aria-label="値"
                value={value}
                onChange={(e) => setValue(e.target.value.replace(/\D/g, ''))}
                placeholder={kind === 'amount' ? '例: 50' : '例: 10'}
              />
              <button
                type="button"
                className="btn btn--primary"
                disabled={!manualValid}
                onClick={() =>
                  onPick({
                    request: { manual: { kind, value: manualValue } },
                    label: kind === 'rate' ? `手入力 ${manualValue}%引` : `手入力 ${manualValue}円引`,
                    rule: { kind, value: manualValue },
                  })
                }
              >
                適用
              </button>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
