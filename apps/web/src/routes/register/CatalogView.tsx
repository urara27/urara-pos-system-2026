import { useCallback, useEffect, useState } from 'react';
import type { Catalog, Product } from '@pos/shared';
import { api, ApiError } from '../../lib/api';
import { groupsOf, lineAmount, lineUnitPrice, useCart } from './cart';
import { OptionPicker } from './OptionPicker';

const yen = (n: number) => `¥${n.toLocaleString('ja-JP')}`;

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

/** カテゴリのタブと商品ボタン、明細。会計（税・割引・支払）はフェーズ3で実装する */
export function CatalogView({ catalog, error }: { catalog: Catalog | null; error: string | null }) {
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [picking, setPicking] = useState<Product | null>(null);
  const cart = useCart();

  // 選んでいたカテゴリが無効になったら先頭に戻す
  const activeCategory =
    catalog?.categories.find((c) => c.id === categoryId) ?? catalog?.categories[0] ?? null;

  if (!catalog) return <div className="center-message">{error ?? '商品を読み込んでいます…'}</div>;

  const products = catalog.products.filter((p) => p.categoryId === activeCategory?.id);

  const select = (p: Product) => {
    if (p.soldOut) return;
    const groups = groupsOf(p, catalog.optionGroups);
    if (groups.length === 0) cart.add(p, [], 1);
    else setPicking(p);
  };

  const subtotal = cart.lines.reduce((sum, l) => sum + lineAmount(l), 0);
  const count = cart.lines.reduce((sum, l) => sum + l.quantity, 0);

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
                <span className="product-btn__price">{p.soldOut ? '売切' : yen(p.priceEatIn)}</span>
              </button>
            ))}
          </div>
        )}
      </section>

      <aside className="pos__cart">
        <h2>注文明細</h2>
        {cart.lines.length === 0 ? (
          <p className="muted">商品を選んでください</p>
        ) : (
          <ul className="cart-lines">
            {cart.lines.map((l) => (
              <li key={l.key} className="cart-line">
                <div className="cart-line__main">
                  <span className="cart-line__name">{l.name}</span>
                  {l.options.length > 0 && (
                    <span className="cart-line__options">
                      {l.options.map((o) => (o.priceDelta > 0 ? `${o.name}(+${o.priceDelta})` : o.name)).join('・')}
                    </span>
                  )}
                  <span className="muted small">@{yen(lineUnitPrice(l))}</span>
                </div>
                <div className="cart-line__qty">
                  <button className="btn btn--small" onClick={() => cart.setQuantity(l.key, l.quantity - 1)} aria-label="減らす">
                    −
                  </button>
                  <span>{l.quantity}</span>
                  <button className="btn btn--small" onClick={() => cart.setQuantity(l.key, l.quantity + 1)} aria-label="増やす">
                    ＋
                  </button>
                </div>
                <span className="cart-line__amount">{yen(lineAmount(l))}</span>
                <button className="btn btn--small" onClick={() => cart.remove(l.key)} aria-label={`${l.name}を削除`}>
                  削除
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="pos__total">
          <span>小計（{count}点）</span>
          <strong>{yen(subtotal)}</strong>
        </div>
        <div className="row">
          <button
            className="btn"
            disabled={cart.lines.length === 0}
            onClick={() => window.confirm('明細をすべて取り消しますか？') && cart.clear()}
          >
            全取消
          </button>
          <button className="btn btn--primary btn--large" disabled title="会計はフェーズ3で実装します">
            会計へ
          </button>
        </div>
      </aside>

      {picking && (
        <OptionPicker
          product={picking}
          groups={groupsOf(picking, catalog.optionGroups)}
          onClose={() => setPicking(null)}
          onAdd={(options, quantity) => {
            cart.add(picking, options, quantity);
            setPicking(null);
          }}
        />
      )}
    </div>
  );
}
