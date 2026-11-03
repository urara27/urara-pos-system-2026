import { z } from 'zod';
import type { PaymentMethod, TaxRoundingMode } from './domain.js';
import { employeeCodeSchema, pinSchema } from './api.js';
import { taxIncluded, type TaxRate, type TaxSummary } from './pricing.js';

/**
 * 返金・商品変更の計算（要件3.6）。
 * 元の販売データは変えず、返金（マイナス）の取引を作って元の取引に紐付ける。
 *
 * - 明細の一部返金: 数量 n のうち k 個を返金するとき、返金額は
 *   floor(金額 × (返金済み + k) / n) − floor(金額 × 返金済み / n)。
 *   累積で計算するので、何回に分けて返金しても合計は元の金額（割引の按分後）にちょうど一致する
 * - 税額: 税率ごとの返金対象額も累積で計算し、全額を返金したときは元の税額をそのまま戻す
 */

/** 累積で按分した k 個分の金額（0 ≤ prev, prev + k ≤ n） */
export function proportionalShare(amount: number, total: number, prev: number, k: number) {
  const cum = (q: number) => (q >= total ? amount : Math.floor((amount * q) / total));
  return cum(prev + k) - cum(prev);
}

export interface RefundableLine {
  lineId: number;
  quantity: number;
  /** 返金済みの数量 */
  refundedQuantity: number;
  taxRate: TaxRate;
  gross: number;
  lineDiscount: number;
  allocatedOrderDiscount: number;
  /** 割引の按分後の金額（＝お客様が支払った額） */
  net: number;
}

export interface ReturnedLineAmount {
  lineId: number;
  quantity: number;
  taxRate: TaxRate;
  gross: number;
  lineDiscount: number;
  allocatedOrderDiscount: number;
  net: number;
}

/** 返金する明細の金額（すべて正の値で返す。記録するときに符号を反転する） */
export function returnedLineAmount(line: RefundableLine, quantity: number): ReturnedLineAmount {
  const share = (amount: number) => proportionalShare(amount, line.quantity, line.refundedQuantity, quantity);
  const gross = share(line.gross);
  const net = share(line.net);
  const lineDiscount = share(line.lineDiscount);
  return {
    lineId: line.lineId,
    quantity,
    taxRate: line.taxRate,
    gross,
    lineDiscount,
    // 端数の食い違いを出さないよう、会計割引の按分は差し引きで決める
    allocatedOrderDiscount: gross - lineDiscount - net,
    net,
  };
}

/**
 * 返金する分の税率ごとの対象額と税額（正の値）。
 * original: 元の取引の税率ごとの集計 / refunded: これまでに返金した分の税率ごとの集計
 */
export function refundTaxes(
  original: TaxSummary[],
  refunded: TaxSummary[],
  returned: ReturnedLineAmount[],
  rounding: TaxRoundingMode,
): TaxSummary[] {
  const rates = [...new Set(returned.map((r) => r.taxRate))].sort((a, b) => b - a);
  return rates.map((rate) => {
    const orig = original.find((t) => t.taxRate === rate) ?? { taxRate: rate, taxableAmount: 0, taxAmount: 0 };
    const prev = refunded.find((t) => t.taxRate === rate) ?? { taxRate: rate, taxableAmount: 0, taxAmount: 0 };
    const taxableAmount = returned.filter((r) => r.taxRate === rate).reduce((s, r) => s + r.net, 0);
    const cumTax = (taxable: number) =>
      taxable >= orig.taxableAmount ? orig.taxAmount : taxIncluded(taxable, rate, rounding);
    const taxAmount = cumTax(prev.taxableAmount + taxableAmount) - cumTax(prev.taxableAmount);
    return { taxRate: rate, taxableAmount, taxAmount };
  });
}

/** 税率ごとの集計を足し合わせる（返金分はマイナスで渡す） */
export function sumTaxes(...groups: TaxSummary[][]): TaxSummary[] {
  const map = new Map<TaxRate, TaxSummary>();
  for (const t of groups.flat()) {
    const cur = map.get(t.taxRate) ?? { taxRate: t.taxRate, taxableAmount: 0, taxAmount: 0 };
    map.set(t.taxRate, { taxRate: t.taxRate, taxableAmount: cur.taxableAmount + t.taxableAmount, taxAmount: cur.taxAmount + t.taxAmount });
  }
  return [...map.values()].sort((a, b) => b.taxRate - a.taxRate);
}

// ───────── API ─────────

export const returnItem = z.object({
  lineId: z.number().int().positive(),
  quantity: z.number().int().min(1).max(99),
});

/** 商品変更で追加する商品（割引は付けない） */
export const additionItem = z.object({
  productId: z.number().int().positive(),
  optionIds: z.array(z.number().int().positive()).max(50).default([]),
  quantity: z.number().int().min(1).max(99),
});
export type AdditionItem = z.input<typeof additionItem>;

export const refundQuoteRequest = z.object({
  returns: z.array(returnItem).min(1, '返金する明細を選んでください').max(100),
  additions: z.array(additionItem).max(100).default([]),
});
export type RefundQuoteRequest = z.input<typeof refundQuoteRequest>;

export const refundRequest = refundQuoteRequest.extend({
  idempotencyKey: z.string().min(8).max(100),
  registerSessionId: z.number().int().positive(),
  reason: z.string().trim().min(1, '理由を入力してください').max(200),
  /** 責任者（責任者・管理者）の承認 */
  approver: z.object({ code: employeeCodeSchema, pin: pinSchema }),
  /** 差額を追加でいただくとき（商品変更で高くなる場合）の支払。返金のときは元の支払方法で返す */
  cashReceived: z.number().int().min(0).max(10_000_000).optional(),
  /** 画面に出していた差額（追加 − 返金）。サーバーの計算と違えば確定しない */
  expectedDifference: z.number().int(),
});
export type RefundRequest = z.input<typeof refundRequest>;

export interface RefundQuote {
  originalTransactionId: number;
  paymentMethod: PaymentMethod;
  returns: { lineId: number; name: string; quantity: number; amount: number }[];
  additions: { productId: number; name: string; options: string[]; quantity: number; amount: number }[];
  /** 返金する額（正の値） */
  returnAmount: number;
  /** 追加する商品の額 */
  additionAmount: number;
  /** 差額 = 追加 − 返金。正ならいただく、負なら返す */
  difference: number;
  /** すべての明細を返金し、追加も無い（＝全額返金。未完了の注文は取消になる） */
  fullRefund: boolean;
  taxes: TaxSummary[];
}

export interface RefundResult {
  transactionId: number;
  receiptNumber: string;
  kind: 'refund' | 'exchange';
  difference: number;
  paymentMethod: PaymentMethod;
  cashReceived: number | null;
  change: number | null;
  /** 注文の扱い */
  orderEffect: 'cancelled' | 'modified' | 'none';
  replayed: boolean;
}

// ───────── 取引の検索 ─────────

export const transactionSearchQuery = z.object({
  receiptNumber: z.string().trim().max(30).optional(),
  orderNumber: z.coerce.number().int().min(1).max(999).optional(),
  /** 日時の範囲（epoch ms）。どちらも無ければ今日の営業日 */
  from: z.coerce.number().int().optional(),
  to: z.coerce.number().int().optional(),
  amountMin: z.coerce.number().int().optional(),
  amountMax: z.coerce.number().int().optional(),
  employeeId: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
export type TransactionSearchQuery = z.input<typeof transactionSearchQuery>;

export interface TransactionSummary {
  id: number;
  kind: 'sale' | 'refund' | 'exchange';
  receiptNumber: string;
  originalTransactionId: number | null;
  createdAt: number;
  businessDate: string;
  registerNumber: number;
  employeeName: string;
  diningOption: 'eat_in' | 'take_out';
  paymentMethod: PaymentMethod;
  total: number;
  orderNumber: number | null;
  orderStatus: 'accepted' | 'calling' | 'completed' | 'cancelled' | null;
  /** 返金できる数量が残っているか（販売のみ） */
  refundable: boolean;
}

export interface TransactionDetail extends TransactionSummary {
  lines: {
    lineId: number;
    name: string;
    options: string[];
    quantity: number;
    refundedQuantity: number;
    taxRate: number;
    net: number;
  }[];
  /** この取引に紐付く返金・変更 */
  related: TransactionSummary[];
  reason: string | null;
  approvedByName: string | null;
}
