import { useEffect, useState } from 'react';
import {
  PAYMENT_METHOD_LABELS,
  type AdditionItem,
  type Catalog,
  type Product,
  type RefundQuote,
  type RefundResult,
  type TransactionDetail,
} from '@pos/shared';
import { Keypad } from '../../components/Keypad';
import { ReceiptDialog } from '../../components/ReceiptPreview';
import { api, ApiError } from '../../lib/api';
import { randomId } from '../../lib/id';
import { groupsOf, priceFor } from './cart';
import { yen } from './CatalogView';
import { OptionPicker } from './OptionPicker';

/** 明細ID → 返金する数量 */
export type ReturnSelection = Record<number, number>;

const REASONS = ['お客様都合', '作り間違い', '打ち間違い', '品切れ'];
type Field = 'code' | 'pin' | 'cash';

/**
 * 返金・商品変更の確認と確定。
 * 内容（返品・追加）が変わるたびにサーバーで試算し、責任者の PIN と理由を入れて確定する。
 * 差額は元の支払方法で精算する（PayPay の返金は PayPay 側で行い、ここでは記録だけ残す）。
 */
export function RefundFlow({
  detail,
  catalog,
  mode,
  returns,
  registerSessionId,
  onCancel,
  onDone,
}: {
  detail: TransactionDetail;
  catalog: Catalog | null;
  mode: 'refund' | 'exchange';
  returns: ReturnSelection;
  registerSessionId: number;
  onCancel: () => void;
  onDone: () => void;
}) {
  const [idempotencyKey] = useState(randomId);
  const [additions, setAdditions] = useState<(AdditionItem & { key: string; label: string })[]>([]);
  const [picking, setPicking] = useState<Product | null>(null);
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [quote, setQuote] = useState<RefundQuote | null>(null);
  const [reason, setReason] = useState('');
  const [code, setCode] = useState('');
  const [pin, setPin] = useState('');
  const [cash, setCash] = useState('');
  const [field, setField] = useState<Field>('code');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RefundResult | null>(null);
  const [showReceipt, setShowReceipt] = useState(false);

  const returnItems = Object.entries(returns)
    .filter(([, q]) => q > 0)
    .map(([lineId, quantity]) => ({ lineId: Number(lineId), quantity }));
  const additionItems = additions.map(({ productId, optionIds, quantity }) => ({ productId, optionIds, quantity }));
  const requestKey = JSON.stringify({ returnItems, additionItems });

  useEffect(() => {
    setQuote(null);
    api<RefundQuote>(`/api/transactions/${detail.id}/refund-quote`, {
      method: 'POST',
      auth: 'staff',
      body: { returns: returnItems, additions: additionItems },
    })
      .then((q) => {
        setQuote(q);
        setError(null);
      })
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : '試算できませんでした'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.id, requestKey]);

  const needsCash = quote !== null && quote.difference > 0 && detail.paymentMethod === 'cash';
  const cashOk = !needsCash || (cash !== '' && Number(cash) >= quote!.difference);
  const ready = quote !== null && reason.trim() !== '' && code !== '' && pin.length >= 4 && cashOk && (mode === 'refund' || additions.length > 0);

  const submit = async () => {
    if (!quote || !ready) return;
    setBusy(true);
    setError(null);
    try {
      setResult(
        await api<RefundResult>(`/api/transactions/${detail.id}/refund`, {
          method: 'POST',
          auth: 'staff',
          body: {
            returns: returnItems,
            additions: additionItems,
            idempotencyKey,
            registerSessionId,
            reason: reason.trim(),
            approver: { code, pin },
            expectedDifference: quote.difference,
            ...(needsCash ? { cashReceived: Number(cash) } : {}),
          },
        }),
      );
    } catch (err) {
      if (err instanceof ApiError && err.status === 0) {
        setError('サーバーと通信できません。返金は確定していません。通信を確認してもう一度押してください');
      } else {
        setError(err instanceof ApiError ? err.message : '確定できませんでした');
        if (err instanceof ApiError && err.status === 401) setPin('');
      }
    } finally {
      setBusy(false);
    }
  };

  // ───────── 完了 ─────────
  if (result) {
    const amount = Math.abs(result.difference);
    return (
      <div className="complete">
        {showReceipt && <ReceiptDialog transactionId={result.transactionId} onClose={() => setShowReceipt(false)} />}
        <p className="complete__label">{result.kind === 'refund' ? '返金しました' : '商品を変更しました'}</p>
        {result.difference < 0 && (
          <p className="refund-instruction">
            {result.paymentMethod === 'cash'
              ? `現金 ${yen(amount)} をお客様にお返しください`
              : `PayPay の管理画面（またはアプリ）で ${yen(amount)} を返金してください`}
          </p>
        )}
        {result.difference > 0 && (
          <p className="refund-instruction">
            差額 {yen(amount)} をいただきました
            {result.change !== null && `（お釣り ${yen(result.change)}）`}
          </p>
        )}
        {result.orderEffect === 'cancelled' && <p className="complete__note">注文は取消になり、キッチン・お客様の画面から消えました</p>}
        {result.orderEffect === 'modified' && <p className="complete__note">キッチンの注文を変更しました</p>}
        <p className="muted">レシート番号 {result.receiptNumber}</p>
        <div className="row">
          <button className="btn btn--large" onClick={() => setShowReceipt(true)}>
            レシートを表示
          </button>
          <button className="btn btn--primary btn--xl" onClick={onDone}>
            完了
          </button>
        </div>
      </div>
    );
  }

  const activeCategory = catalog?.categories.find((c) => c.id === categoryId) ?? catalog?.categories[0] ?? null;
  const keypad =
    field === 'code' ? (
      <Keypad label="責任者の従業員コード" value={code} onChange={setCode} />
    ) : field === 'pin' ? (
      <Keypad label="責任者の PIN" value={pin} onChange={setPin} masked />
    ) : (
      <Keypad label="差額のお預り（円）" value={cash} onChange={setCash} maxLength={7} />
    );

  return (
    <div className="refund">
      <header className="history__header">
        <button className="btn" onClick={onCancel} disabled={busy}>
          ← 取引に戻る
        </button>
        <h2>{mode === 'refund' ? '返金' : '商品の変更'}（{detail.receiptNumber}）</h2>
      </header>

      <div className="refund__body">
        <section className="refund__left">
          <h3>返品する商品</h3>
          <ul className="refund__items">
            {quote?.returns.map((r) => (
              <li key={r.lineId}>
                <span>
                  {r.name} × {r.quantity}
                </span>
                <span>−{yen(r.amount)}</span>
              </li>
            ))}
          </ul>

          {mode === 'exchange' && catalog && (
            <>
              <h3>代わりの商品</h3>
              <div className="pos__tabs">
                {catalog.categories.map((c) => (
                  <button key={c.id} className={c.id === activeCategory?.id ? 'is-active' : ''} onClick={() => setCategoryId(c.id)}>
                    {c.name}
                  </button>
                ))}
              </div>
              <div className="refund__products">
                {catalog.products
                  .filter((p) => p.categoryId === activeCategory?.id)
                  .map((p) => (
                    <button
                      key={p.id}
                      className="product-btn"
                      disabled={p.soldOut}
                      onClick={() => {
                        if (groupsOf(p, catalog.optionGroups).length === 0) {
                          setAdditions((a) => [...a, { key: randomId(), productId: p.id, optionIds: [], quantity: 1, label: p.name }]);
                        } else setPicking(p);
                      }}
                    >
                      <span className="product-btn__name">{p.name}</span>
                      <span className="product-btn__price">{p.soldOut ? '売切' : yen(priceFor(p, detail.diningOption))}</span>
                    </button>
                  ))}
              </div>
              <ul className="refund__items">
                {quote?.additions.map((a, i) => (
                  <li key={additions[i]?.key ?? i}>
                    <span>
                      {[a.name, ...a.options].join('・')} × {a.quantity}
                    </span>
                    <span>
                      +{yen(a.amount)}
                      <button className="link-btn" aria-label="外す" onClick={() => setAdditions((list) => list.filter((_, k) => k !== i))}>
                        ✕
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}

          {quote && (
            <div className="refund__total">
              <span>{quote.difference < 0 ? `ご返金（${PAYMENT_METHOD_LABELS[quote.paymentMethod]}）` : quote.difference > 0 ? '差額のお支払' : '差額'}</span>
              <strong>{yen(Math.abs(quote.difference))}</strong>
            </div>
          )}
          {quote?.fullRefund && <p className="notice">全額返金です。受け渡し前の注文は取消になります。</p>}
          {quote && quote.difference < 0 && quote.paymentMethod === 'paypay' && (
            <p className="notice">PayPay の返金は、確定後に PayPay の管理画面（またはアプリ）で行ってください。</p>
          )}

          <h3>理由</h3>
          <div className="chips">
            {REASONS.map((r) => (
              <button key={r} type="button" className={reason === r ? 'chip is-active' : 'chip'} onClick={() => setReason(r)}>
                {r}
              </button>
            ))}
          </div>
          <input aria-label="理由" value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} placeholder="理由を入力" />
        </section>

        <section className="refund__right">
          <div className="refund__fields">
            <button className={`payment__field${field === 'code' ? ' is-focused' : ''}`} onClick={() => setField('code')}>
              <span>責任者コード</span>
              <strong>{code || '未入力'}</strong>
            </button>
            <button className={`payment__field${field === 'pin' ? ' is-focused' : ''}`} onClick={() => setField('pin')}>
              <span>PIN</span>
              <strong>{pin ? '●'.repeat(pin.length) : '未入力'}</strong>
            </button>
            {needsCash && (
              <button className={`payment__field${field === 'cash' ? ' is-focused' : ''}`} onClick={() => setField('cash')}>
                <span>お預り</span>
                <strong>{cash ? yen(Number(cash)) : '未入力'}</strong>
              </button>
            )}
          </div>
          {keypad}
        </section>
      </div>

      <footer className="payment__footer">
        {error && <p className="error">{error}</p>}
        <button className="btn btn--primary btn--xl" disabled={!ready || busy} onClick={submit}>
          {busy ? '確定中…' : mode === 'refund' ? `返金を確定（${quote ? yen(-quote.difference) : '…'}）` : '変更を確定'}
        </button>
      </footer>

      {picking && catalog && (
        <OptionPicker
          product={picking}
          groups={groupsOf(picking, catalog.optionGroups)}
          dining={detail.diningOption}
          onClose={() => setPicking(null)}
          onAdd={(optionIds, quantity) => {
            setAdditions((a) => [...a, { key: randomId(), productId: picking.id, optionIds, quantity, label: picking.name }]);
            setPicking(null);
          }}
        />
      )}
    </div>
  );
}
