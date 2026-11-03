import { useCallback, useEffect, useState } from 'react';
import { DINING_OPTION_LABELS, DINING_OPTIONS, type Catalog, type Product, type TaxRoundingMode } from '@pos/shared';
import { api, ApiError } from '../../lib/api';
import { groupsOf, priceFor, quote, useCart, type Quote } from './cart';
import { DiscountPicker } from './DiscountPicker';
import { OptionPicker } from './OptionPicker';

export const yen = (n: number) => `¥${n.toLocaleString('ja-JP')}`;

/** カタログの取得。接続・再接続時と catalog.updated で取り直す */
export function useCatalog() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => {
    api<Catalog>('/api/catalog')
      .then((c) => {
        setCatalog(c);
        setError(null);
      })
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : '商品を読み込めませんでした'));
  }, []);
  useEffect(reload, [reload]);
  return { catalog, error, reload };
}

type DiscountTarget = { scope: 'line'; lineKey: string; label: string } | { scope: 'order' };

/** 商品選択と明細。「会計へ」で支払画面に進む */
export function CatalogView({
  catalog,
  error,
  taxRounding,
  canManualDiscount,
  onCheckout,
}: {
  catalog: Catalog | null;
  error: string | null;
  taxRounding: TaxRoundingMode;
  canManualDiscount: boolean;
  onCheckout: (q: Quote) => void;
}) {
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [picking, setPicking] = useState<Product | null>(null);
  const [discountTarget, setDiscountTarget] = useState<DiscountTarget | null>(null);
  const cart = useCart();

  if (!catalog) return <div className="center-message">{error ?? '商品を読み込んでいます…'}</div>;

  // 選んでいたカテゴリが無効になったら先頭に戻す
  const activeCategory = catalog.categories.find((c) => c.id === categoryId) ?? catalog.categories[0] ?? null;
  const products = catalog.products.filter((p) => p.categoryId === activeCategory?.id);
  const q = quote(catalog, cart, taxRounding);
  const count = cart.lines.reduce((sum, l) => sum + l.quantity, 0);

  const select = (p: Product) => {
    if (p.soldOut) return;
    if (groupsOf(p, catalog.optionGroups).length === 0) cart.add(p.id, [], 1);
    else setPicking(p);
  };

  const canCheckout = cart.lines.length > 0 && cart.diningOption !== null && !q.hasProblem;

  return (
    <div className="pos">
      <section className="pos__menu">
        {error && <p className="error">{error}</p>}
        <div className="pos__tabs" role="tablist">
          {catalog.categories.map((c) => (
            <button
              key={c.id}
              role="tab"
              aria-selected={c.id === activeCategory?.id}
              className={c.id === activeCategory?.id ? 'is-active' : ''}
              onClick={() => setCategoryId(c.id)}
            >
              {c.name}
            </button>
          ))}
        </div>
        {catalog.categories.length === 0 ? (
          <p className="placeholder">商品が登録されていません。管理画面で登録してください。</p>
        ) : (
          <div className="pos__grid">
            {products.map((p) => (
              <button
                key={p.id}
                className={`product-btn${p.soldOut ? ' is-sold-out' : ''}`}
                style={p.buttonColor ? { borderTopColor: p.buttonColor } : undefined}
                disabled={p.soldOut}
                onClick={() => select(p)}
              >
                <span className="product-btn__name">{p.name}</span>
                <span className="product-btn__price">{p.soldOut ? '売切' : yen(priceFor(p, cart.diningOption))}</span>
              </button>
            ))}
          </div>
        )}
      </section>

      <aside className="pos__cart">
        <div className="dining-toggle" role="radiogroup" aria-label="店内／持ち帰り">
          {DINING_OPTIONS.map((d) => (
            <button
              key={d}
              role="radio"
              aria-checked={cart.diningOption === d}
              className={cart.diningOption === d ? 'is-active' : ''}
              onClick={() => cart.setDiningOption(d)}
            >
              {DINING_OPTION_LABELS[d]}
            </button>
          ))}
        </div>

        {cart.lines.length === 0 ? (
          <p className="muted">商品を選んでください</p>
        ) : (
          <ul className="cart-lines">
            {q.lines.map((ql, i) => {
              const priced = q.pricing.lines[i]!;
              const { line } = ql;
              return (
                <li key={line.key} className={`cart-line${ql.problem ? ' has-problem' : ''}`}>
                  <div className="cart-line__main">
                    <span className="cart-line__name">{ql.product?.name ?? '（販売終了）'}</span>
                    {ql.options.length > 0 && (
                      <span className="cart-line__options">
                        {ql.options.map((o) => (o.priceDelta > 0 ? `${o.name}(+${o.priceDelta})` : o.name)).join('・')}
                      </span>
                    )}
                    {line.discounts.map((d, k) => (
                      <span key={d.key} className="cart-line__discount">
                        {d.label} −{yen(priced.lineDiscountAmounts[k]!)}
                        <button className="link-btn" onClick={() => cart.removeLineDiscount(line.key, d.key)} aria-label={`${d.label}を外す`}>
                          ✕
                        </button>
                      </span>
                    ))}
                    {ql.problem && <span className="error small">{ql.problem}</span>}
                  </div>
                  <span className="cart-line__amount">{yen(priced.afterLineDiscount)}</span>
                  <div className="cart-line__qty">
                    <button className="btn btn--small" onClick={() => cart.setQuantity(line.key, line.quantity - 1)} aria-label="減らす">
                      −
                    </button>
                    <span>{line.quantity}</span>
                    <button className="btn btn--small" onClick={() => cart.setQuantity(line.key, line.quantity + 1)} aria-label="増やす">
                      ＋
                    </button>
                  </div>
                  <div className="cart-line__actions">
                    <button
                      className="btn btn--small"
                      onClick={() => setDiscountTarget({ scope: 'line', lineKey: line.key, label: ql.product?.name ?? '明細' })}
                    >
                      割引
                    </button>
                    <button className="btn btn--small" onClick={() => cart.remove(line.key)} aria-label={`${ql.product?.name ?? ''}を削除`}>
                      削除
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        <div className="pos__summary">
          <div className="pos__summary-row">
            <span>小計（{count}点）</span>
            <span>{yen(q.pricing.subtotal - q.pricing.lineDiscountTotal)}</span>
          </div>
          {cart.orderDiscounts.map((d, k) => (
            <div key={d.key} className="pos__summary-row pos__summary-row--discount">
              <span>
                {d.label}
                <button className="link-btn" onClick={() => cart.removeOrderDiscount(d.key)} aria-label={`${d.label}を外す`}>
                  ✕
                </button>
              </span>
              <span>−{yen(q.pricing.orderDiscountAmounts[k]!)}</span>
            </div>
          ))}
          <div className="pos__total">
            <span>合計</span>
            <strong>{yen(q.pricing.total)}</strong>
          </div>
          <div className="pos__tax muted small">
            {cart.diningOption === null
              ? '店内／持ち帰りを選ぶと税額が決まります'
              : q.pricing.taxes.map((t) => `${t.taxRate}%対象 ${yen(t.taxableAmount)}（内税 ${yen(t.taxAmount)}）`).join('　')}
          </div>
        </div>

        <div className="row pos__actions">
          <button className="btn" disabled={cart.lines.length === 0} onClick={() => setDiscountTarget({ scope: 'order' })}>
            会計割引
          </button>
          <button
            className="btn"
            disabled={cart.lines.length === 0}
            onClick={() => window.confirm('明細をすべて取り消しますか？') && cart.clear()}
          >
            全取消
          </button>
          <button className="btn btn--primary btn--large" disabled={!canCheckout} onClick={() => onCheckout(q)}>
            {cart.lines.length > 0 && cart.diningOption === null ? '店内／持ち帰りを選択' : '会計へ'}
          </button>
        </div>
      </aside>

      {picking && (
        <OptionPicker
          product={picking}
          groups={groupsOf(picking, catalog.optionGroups)}
          dining={cart.diningOption}
          onClose={() => setPicking(null)}
          onAdd={(optionIds, quantity) => {
            cart.add(picking.id, optionIds, quantity);
            setPicking(null);
          }}
        />
      )}
      {discountTarget && (
        <DiscountPicker
          scope={discountTarget.scope}
          discounts={catalog.discounts}
          canManual={canManualDiscount}
          targetLabel={discountTarget.scope === 'order' ? '会計全体' : discountTarget.label}
          onClose={() => setDiscountTarget(null)}
          onPick={(d) => {
            if (discountTarget.scope === 'order') cart.addOrderDiscount(d);
            else cart.addLineDiscount(discountTarget.lineKey, d);
            setDiscountTarget(null);
          }}
        />
      )}
    </div>
  );
}
