import { useState } from 'react';
import {
  changeFor,
  formatOrderNumber,
  type CheckoutRequest,
  type CheckoutResult,
  type NumberingMode,
  type PaymentMethod,
} from '@pos/shared';
import { Keypad } from '../../components/Keypad';
import { api, ApiError } from '../../lib/api';
import { randomId } from '../../lib/id';
import { yen } from './CatalogView';

type Field = 'cash' | 'ticket';

/**
 * 支払。現金は預り金を入れて釣銭を出し、PayPay（店舗提示型）は金額を大きく見せて
 * スタッフがお客様の画面で支払完了を確認してから確定する。
 * 冪等キーはこの画面を開いたときに1つ作り、再試行でも同じキーを送る（二重登録の防止）。
 */
export function PaymentPanel({
  total,
  numberingMode,
  ticketRange,
  buildRequest,
  onComplete,
  onCancel,
}: {
  total: number;
  numberingMode: NumberingMode;
  ticketRange: { min: number; max: number };
  buildRequest: () => Omit<CheckoutRequest, 'idempotencyKey' | 'payment' | 'ticketNumber' | 'expectedTotal'>;
  onComplete: (result: CheckoutResult) => void;
  onCancel: () => void;
}) {
  const [idempotencyKey] = useState(randomId);
  const [method, setMethod] = useState<PaymentMethod | null>(null);
  const [cash, setCash] = useState('');
  const [ticket, setTicket] = useState('');
  const [field, setField] = useState<Field>(numberingMode === 'ticket' ? 'ticket' : 'cash');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; network: boolean } | null>(null);

  const cashReceived = cash === '' ? null : Number(cash);
  const change = cashReceived === null ? null : changeFor(total, cashReceived);
  const ticketNumber = ticket === '' ? null : Number(ticket);
  const ticketOk =
    numberingMode === 'auto' || (ticketNumber !== null && ticketNumber >= ticketRange.min && ticketNumber <= ticketRange.max);
  const ready = ticketOk && (method === 'paypay' || (method === 'cash' && change !== null));

  const submit = async () => {
    if (!ready || !method) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api<CheckoutResult>('/api/transactions', {
        method: 'POST',
        auth: 'staff',
        body: {
          ...buildRequest(),
          idempotencyKey,
          expectedTotal: total,
          payment: method === 'cash' ? { method, cashReceived: cashReceived ?? 0 } : { method },
          ...(numberingMode === 'ticket' ? { ticketNumber } : {}),
        },
      });
      onComplete(result);
    } catch (err) {
      if (err instanceof ApiError && err.status === 0) {
        setError({
          message: 'サーバーと通信できません。会計は確定していません。通信を確認して「再試行」を押してください',
          network: true,
        });
      } else {
        setError({ message: err instanceof ApiError ? err.message : '会計を確定できませんでした', network: false });
      }
    } finally {
      setBusy(false);
    }
  };

  const quick = [total, 1000, 2000, 5000, 10000].filter((v, i, a) => v >= total && a.indexOf(v) === i);

  return (
    <div className="payment">
      <header className="payment__header">
        <button className="btn" onClick={onCancel} disabled={busy}>
          ← 明細に戻る
        </button>
        <div className="payment__total">
          <span>お会計</span>
          <strong>{yen(total)}</strong>
        </div>
      </header>

      <div className="payment__body">
        <section className="payment__left">
          {numberingMode === 'ticket' && (
            <button
              className={`payment__field${field === 'ticket' ? ' is-focused' : ''}`}
              onClick={() => setField('ticket')}
            >
              <span>番号札（{formatOrderNumber(ticketRange.min)}〜{formatOrderNumber(ticketRange.max)}）</span>
              <strong>{ticket === '' ? '未入力' : formatOrderNumber(Number(ticket))}</strong>
            </button>
          )}

          <div className="payment__methods" role="radiogroup" aria-label="支払方法">
            <button
              role="radio"
              aria-checked={method === 'cash'}
              className={method === 'cash' ? 'is-active' : ''}
              onClick={() => {
                setMethod('cash');
                setField('cash');
              }}
            >
              現金
            </button>
            <button role="radio" aria-checked={method === 'paypay'} className={method === 'paypay' ? 'is-active' : ''} onClick={() => setMethod('paypay')}>
              PayPay
            </button>
          </div>

          {method === 'cash' && (
            <>
              <button className={`payment__field${field === 'cash' ? ' is-focused' : ''}`} onClick={() => setField('cash')}>
                <span>お預り</span>
                <strong>{cashReceived === null ? '未入力' : yen(cashReceived)}</strong>
              </button>
              <div className="payment__quick">
                {quick.map((v) => (
                  <button key={v} className="btn" onClick={() => setCash(String(v))}>
                    {v === total ? 'ちょうど' : yen(v)}
                  </button>
                ))}
              </div>
              <div className={`payment__change${change === null && cashReceived !== null ? ' is-short' : ''}`}>
                <span>{change === null && cashReceived !== null ? '不足' : 'お釣り'}</span>
                <strong>
                  {cashReceived === null ? '—' : change === null ? yen(total - cashReceived) : yen(change)}
                </strong>
              </div>
            </>
          )}

          {method === 'paypay' && (
            <div className="paypay">
              <p className="paypay__amount">{yen(total)}</p>
              <ol className="paypay__steps">
                <li>お客様に店舗の QR コードを読み取っていただく</li>
                <li>
                  金額 <strong>{yen(total)}</strong> を入力して支払っていただく
                </li>
                <li>お客様のスマートフォンで支払完了の画面を確認する</li>
              </ol>
            </div>
          )}
        </section>

        <section className="payment__right">
          {(field === 'ticket' && numberingMode === 'ticket') || method === 'cash' ? (
            field === 'ticket' && numberingMode === 'ticket' ? (
              <Keypad label="番号札" value={ticket} onChange={setTicket} maxLength={3} />
            ) : (
              <Keypad label="お預り（円）" value={cash} onChange={setCash} maxLength={7} />
            )
          ) : (
            <div className="payment__hint muted">支払方法を選んでください</div>
          )}
        </section>
      </div>

      <footer className="payment__footer">
        {error && <p className="error">{error.message}</p>}
        <button className="btn btn--primary btn--xl" disabled={!ready || busy} onClick={submit}>
          {busy ? '確定中…' : error?.network ? '再試行' : method === 'paypay' ? '支払確認済み（会計を確定）' : '会計を確定'}
        </button>
      </footer>
    </div>
  );
}

/** 会計完了。注文番号を大きく出す（プリンター導入までは手書きの控えで渡す） */
export function CheckoutComplete({ result, onNext }: { result: CheckoutResult; onNext: () => void }) {
  return (
    <div className="complete">
      <p className="complete__label">注文番号</p>
      <p className="complete__number">{formatOrderNumber(result.orderNumber)}</p>
      {result.numberingMode === 'auto' ? (
        <p className="complete__note">この番号を控えに書いてお客様にお渡しください</p>
      ) : (
        <p className="complete__note">番号札 {formatOrderNumber(result.orderNumber)} をお渡しください</p>
      )}
      <dl className="complete__details">
        <div>
          <dt>合計</dt>
          <dd>{yen(result.total)}</dd>
        </div>
        <div>
          <dt>支払</dt>
          <dd>{result.paymentMethod === 'cash' ? '現金' : 'PayPay'}</dd>
        </div>
        {result.paymentMethod === 'cash' && (
          <>
            <div>
              <dt>お預り</dt>
              <dd>{yen(result.cashReceived ?? 0)}</dd>
            </div>
            <div className="complete__change">
              <dt>お釣り</dt>
              <dd>{yen(result.change ?? 0)}</dd>
            </div>
          </>
        )}
        <div>
          <dt>レシート番号</dt>
          <dd>{result.receiptNumber}</dd>
        </div>
      </dl>
      <button className="btn btn--primary btn--xl" onClick={onNext} autoFocus>
        次のお客様
      </button>
    </div>
  );
}
