import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  DINING_OPTION_LABELS,
  formatOrderNumber,
  ORDER_STATUS_LABELS,
  PAYMENT_METHOD_LABELS,
  type Catalog,
  type TransactionDetail,
  type TransactionSummary,
} from '@pos/shared';
import { ReceiptDialog } from '../../components/ReceiptPreview';
import { api, ApiError } from '../../lib/api';
import { yen } from './CatalogView';
import { RefundFlow, type ReturnSelection } from './RefundFlow';

const KIND_LABELS: Record<TransactionSummary['kind'], string> = { sale: '販売', refund: '返金', exchange: '商品変更' };
const time = (ms: number) => new Date(ms).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
const dateTime = (ms: number) => new Date(ms).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const message = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);

interface Filters {
  receiptNumber: string;
  orderNumber: string;
  date: string;
  amountMin: string;
  amountMax: string;
  employeeId: string;
}
const EMPTY: Filters = { receiptNumber: '', orderNumber: '', date: '', amountMin: '', amountMax: '', employeeId: '' };

function toQuery(f: Filters) {
  const q = new URLSearchParams();
  if (f.receiptNumber.trim()) q.set('receiptNumber', f.receiptNumber.trim());
  if (f.orderNumber) q.set('orderNumber', String(Number(f.orderNumber)));
  if (f.date) {
    // 日付を指定したらその日の0時〜24時（過去の営業日も探せる）
    const from = new Date(`${f.date}T00:00:00`).getTime();
    q.set('from', String(from));
    q.set('to', String(from + 24 * 60 * 60 * 1000 - 1));
  }
  if (f.amountMin) q.set('amountMin', f.amountMin);
  if (f.amountMax) q.set('amountMax', f.amountMax);
  if (f.employeeId) q.set('employeeId', f.employeeId);
  return q.toString();
}

/**
 * 取引の履歴と検索（要件3.6）。条件を入れなければ当日の営業日の取引を新しい順に出す。
 * 取引を選ぶと明細を見て、全額返金・一部返金・商品の変更ができる。
 */
export function TransactionHistory({
  catalog,
  registerSessionId,
  onClose,
}: {
  catalog: Catalog | null;
  registerSessionId: number;
  onClose: () => void;
}) {
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [list, setList] = useState<TransactionSummary[] | null>(null);
  const [employees, setEmployees] = useState<{ id: number; name: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const search = useCallback((f: Filters) => {
    setError(null);
    api<{ transactions: TransactionSummary[] }>(`/api/transactions?${toQuery(f)}`, { auth: 'staff' })
      .then((res) => setList(res.transactions))
      .catch((err: unknown) => setError(message(err, '検索できませんでした')));
  }, []);

  useEffect(() => {
    search(EMPTY);
    api<{ employees: { id: number; name: string }[] }>('/api/transactions/employees', { auth: 'staff' })
      .then((res) => setEmployees(res.employees))
      .catch(() => undefined);
  }, [search]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    search(filters);
  };
  const set = (k: keyof Filters, v: string) => setFilters((f) => ({ ...f, [k]: v }));

  if (selectedId !== null) {
    return (
      <TransactionDetailView
        id={selectedId}
        catalog={catalog}
        registerSessionId={registerSessionId}
        onOpen={setSelectedId}
        onBack={() => {
          setSelectedId(null);
          search(filters);
        }}
      />
    );
  }

  return (
    <div className="history">
      <header className="history__header">
        <button className="btn" onClick={onClose}>
          ← 会計に戻る
        </button>
        <h2>取引履歴</h2>
      </header>
      <form className="history__filters" onSubmit={submit}>
        <label>
          <span>レシート番号</span>
          <input value={filters.receiptNumber} onChange={(e) => set('receiptNumber', e.target.value)} placeholder="一部でも可" />
        </label>
        <label>
          <span>注文番号</span>
          <input inputMode="numeric" value={filters.orderNumber} onChange={(e) => set('orderNumber', e.target.value.replace(/\D/g, '').slice(0, 3))} />
        </label>
        <label>
          <span>日付</span>
          <input type="date" value={filters.date} onChange={(e) => set('date', e.target.value)} />
        </label>
        <label>
          <span>金額（円）</span>
          <span className="row">
            <input inputMode="numeric" className="input-narrow" value={filters.amountMin} onChange={(e) => set('amountMin', e.target.value.replace(/[^\d-]/g, ''))} placeholder="下限" />
            〜
            <input inputMode="numeric" className="input-narrow" value={filters.amountMax} onChange={(e) => set('amountMax', e.target.value.replace(/[^\d-]/g, ''))} placeholder="上限" />
          </span>
        </label>
        <label>
          <span>担当者</span>
          <select value={filters.employeeId} onChange={(e) => set('employeeId', e.target.value)}>
            <option value="">すべて</option>
            {employees.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
        </label>
        <div className="row">
          <button className="btn btn--primary">検索</button>
          <button
            type="button"
            className="btn"
            onClick={() => {
              setFilters(EMPTY);
              search(EMPTY);
            }}
          >
            当日の一覧
          </button>
        </div>
      </form>
      {error && <p className="error">{error}</p>}
      <div className="history__list">
        {list?.length === 0 && <p className="muted">該当する取引はありません</p>}
        {list?.map((t) => (
          <button key={t.id} className={`history-row history-row--${t.kind}`} onClick={() => setSelectedId(t.id)}>
            <span className="history-row__time">{t.businessDate === list[0]?.businessDate ? time(t.createdAt) : dateTime(t.createdAt)}</span>
            <span className="history-row__kind">{KIND_LABELS[t.kind]}</span>
            <span className="history-row__number">{t.orderNumber !== null ? formatOrderNumber(t.orderNumber) : '—'}</span>
            <span className="history-row__receipt">{t.receiptNumber}</span>
            <span>{t.employeeName}</span>
            <span>{PAYMENT_METHOD_LABELS[t.paymentMethod]}</span>
            <span className="history-row__total">{yen(t.total)}</span>
            <span className="history-row__state small">
              {t.kind === 'sale' && !t.refundable ? '返金済み' : t.orderStatus ? ORDER_STATUS_LABELS[t.orderStatus] : ''}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function TransactionDetailView({
  id,
  catalog,
  registerSessionId,
  onOpen,
  onBack,
}: {
  id: number;
  catalog: Catalog | null;
  registerSessionId: number;
  onOpen: (id: number) => void;
  onBack: () => void;
}) {
  const [detail, setDetail] = useState<TransactionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<ReturnSelection>({});
  const [flow, setFlow] = useState<'refund' | 'exchange' | null>(null);
  const [receiptFor, setReceiptFor] = useState<number | null>(null);

  const load = useCallback(() => {
    api<TransactionDetail>(`/api/transactions/${id}/detail`, { auth: 'staff' })
      .then((d) => {
        setDetail(d);
        setSelection({});
      })
      .catch((err: unknown) => setError(message(err, '取引を読み込めませんでした')));
  }, [id]);
  useEffect(load, [load]);

  if (!detail) return <div className="center-message">{error ?? '読み込み中…'}</div>;

  const isSale = detail.kind === 'sale';
  const remaining = (l: TransactionDetail['lines'][number]) => l.quantity - l.refundedQuantity;
  const selectedCount = Object.values(selection).reduce((s, n) => s + n, 0);
  const selectAll = () => setSelection(Object.fromEntries(detail.lines.filter((l) => remaining(l) > 0).map((l) => [l.lineId, remaining(l)])));

  if (flow) {
    return (
      <RefundFlow
        detail={detail}
        catalog={catalog}
        mode={flow}
        returns={selection}
        registerSessionId={registerSessionId}
        onCancel={() => setFlow(null)}
        onDone={() => {
          setFlow(null);
          load();
        }}
      />
    );
  }

  return (
    <div className="history">
      {receiptFor !== null && <ReceiptDialog transactionId={receiptFor} onClose={() => setReceiptFor(null)} />}
      <header className="history__header">
        <button className="btn" onClick={onBack}>
          ← 一覧に戻る
        </button>
        <h2>
          {KIND_LABELS[detail.kind]} {detail.receiptNumber}
        </h2>
        <button className="btn" onClick={() => setReceiptFor(detail.id)}>
          レシート
        </button>
      </header>
      {error && <p className="error">{error}</p>}

      <dl className="history__meta">
        <div>
          <dt>日時</dt>
          <dd>{new Date(detail.createdAt).toLocaleString('ja-JP')}</dd>
        </div>
        <div>
          <dt>注文番号</dt>
          <dd>
            {detail.orderNumber !== null ? formatOrderNumber(detail.orderNumber) : '—'}
            {detail.orderStatus && `（${ORDER_STATUS_LABELS[detail.orderStatus]}）`}
          </dd>
        </div>
        <div>
          <dt>レジ・担当</dt>
          <dd>
            レジ{detail.registerNumber}・{detail.employeeName}
          </dd>
        </div>
        <div>
          <dt>店内／持ち帰り・支払</dt>
          <dd>
            {DINING_OPTION_LABELS[detail.diningOption]}・{PAYMENT_METHOD_LABELS[detail.paymentMethod]}
          </dd>
        </div>
        <div>
          <dt>合計</dt>
          <dd>
            <strong>{yen(detail.total)}</strong>
          </dd>
        </div>
        {detail.reason && (
          <div>
            <dt>理由・承認者</dt>
            <dd>
              {detail.reason}（承認: {detail.approvedByName}）
            </dd>
          </div>
        )}
      </dl>

      <table className="history__lines">
        <thead>
          <tr>
            <th>商品</th>
            <th className="num">数量</th>
            <th className="num">支払額</th>
            {isSale && <th>返金する数量</th>}
          </tr>
        </thead>
        <tbody>
          {detail.lines.map((l) => (
            <tr key={l.lineId} className={isSale && remaining(l) === 0 ? 'is-done' : ''}>
              <td>
                {l.name}
                {l.taxRate === 8 && '※'}
                {l.options.length > 0 && <small className="muted">（{l.options.join('・')}）</small>}
              </td>
              <td className="num">
                {l.quantity}
                {l.refundedQuantity > 0 && <small className="muted">（返金済 {l.refundedQuantity}）</small>}
              </td>
              <td className="num">{yen(l.net)}</td>
              {isSale && (
                <td>
                  {remaining(l) > 0 ? (
                    <span className="stepper stepper--small">
                      <button className="btn btn--small" aria-label="減らす" onClick={() => setSelection((s) => ({ ...s, [l.lineId]: Math.max(0, (s[l.lineId] ?? 0) - 1) }))}>
                        −
                      </button>
                      <span className="stepper__value">{selection[l.lineId] ?? 0}</span>
                      <button
                        className="btn btn--small"
                        aria-label="増やす"
                        onClick={() => setSelection((s) => ({ ...s, [l.lineId]: Math.min(remaining(l), (s[l.lineId] ?? 0) + 1) }))}
                      >
                        ＋
                      </button>
                    </span>
                  ) : (
                    <span className="muted small">返金済み</span>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>

      {detail.related.length > 0 && (
        <section className="history__related">
          <h3>この取引の返金・変更</h3>
          {detail.related.map((r) => (
            <button key={r.id} className="history-row" onClick={() => onOpen(r.id)}>
              <span>{dateTime(r.createdAt)}</span>
              <span className="history-row__kind">{KIND_LABELS[r.kind]}</span>
              <span className="history-row__receipt">{r.receiptNumber}</span>
              <span className="history-row__total">{yen(r.total)}</span>
            </button>
          ))}
        </section>
      )}
      {!isSale && detail.originalTransactionId !== null && (
        <button className="btn" onClick={() => onOpen(detail.originalTransactionId!)}>
          元の取引を開く
        </button>
      )}

      {isSale && detail.refundable && (
        <footer className="history__actions">
          <button className="btn" onClick={selectAll}>
            すべて選ぶ
          </button>
          <button className="btn btn--large" disabled={selectedCount === 0 || !catalog} onClick={() => setFlow('exchange')}>
            選んだ商品を変更
          </button>
          <button className="btn btn--primary btn--large" disabled={selectedCount === 0} onClick={() => setFlow('refund')}>
            選んだ数量を返金
          </button>
        </footer>
      )}
    </div>
  );
}
