import type { DiningOption, TaxRoundingMode } from './domain.js';

/**
 * 金額・税額の計算。レジの表示とサーバーの確定は必ずこの関数を通す。
 * 金額はすべて整数（円）・税込。浮動小数点数で金額を持たない。
 *
 * ルール（docs/development-plan.md 第5節）
 * 1. 明細の総額 = (単価 + オプション加算額) × 数量
 * 2. 明細割引は適用順に計算する。率は「それまでの割引を引いた後の金額 × 率」を切り捨て。
 *    金額割引が残額を超える分は割引額を減らし、明細は0円で止める
 * 3. 会計割引も同様に、明細割引後の合計に対して適用順に計算する
 * 4. 会計割引は税率グループの金額比で按分し各々切り捨て、残りの端数は金額の大きい
 *    税率グループへ寄せる（同額なら税率の高い方）。グループ内の明細へも同じ方法で按分する
 *    （明細単位の一部返金で使う）
 * 5. 税額は税率ごとの税込合計から 合計 × 税率 / (100 + 税率) を1回だけ端数処理する
 * 6. 税率: 軽減税率の対象 × 店内 = 10% / 軽減税率の対象 × 持ち帰り = 8% / 対象外 = 常に10%
 */

export type TaxRate = 8 | 10;

export interface DiscountRule {
  kind: 'amount' | 'rate';
  /** amount: 円 / rate: % */
  value: number;
}

export interface PricingLine {
  /** 税込単価（店内/持ち帰りで選んだ価格） */
  unitPrice: number;
  /** オプション加算額の合計（1個あたり） */
  optionsDelta: number;
  quantity: number;
  reducedTaxEligible: boolean;
  discounts: readonly DiscountRule[];
}

export interface PricingInput {
  lines: readonly PricingLine[];
  orderDiscounts: readonly DiscountRule[];
  diningOption: DiningOption;
  taxRounding: TaxRoundingMode;
}

export interface PricedLine {
  taxRate: TaxRate;
  gross: number;
  /** 明細割引ごとの割引額（適用順） */
  lineDiscountAmounts: number[];
  lineDiscountTotal: number;
  /** 明細割引後の金額 */
  afterLineDiscount: number;
  /** 会計割引の按分額 */
  allocatedOrderDiscount: number;
  /** 最終金額（明細割引・会計割引の按分後） */
  net: number;
}

export interface TaxSummary {
  taxRate: TaxRate;
  /** 対象額（税込） */
  taxableAmount: number;
  taxAmount: number;
}

export interface PricingResult {
  lines: PricedLine[];
  /** 会計割引ごとの割引額（適用順） */
  orderDiscountAmounts: number[];
  /** 割引前の合計 */
  subtotal: number;
  lineDiscountTotal: number;
  orderDiscountTotal: number;
  discountTotal: number;
  total: number;
  /** 税率の高い順 */
  taxes: TaxSummary[];
}

export function taxRateFor(reducedTaxEligible: boolean, diningOption: DiningOption): TaxRate {
  return reducedTaxEligible && diningOption === 'take_out' ? 8 : 10;
}

/** 割引を適用順に計算する。戻り値は各割引額と残額 */
export function applyDiscounts(base: number, rules: readonly DiscountRule[]) {
  let remaining = base;
  const amounts = rules.map((rule) => {
    const raw = rule.kind === 'rate' ? Math.floor((remaining * rule.value) / 100) : rule.value;
    const amount = Math.max(0, Math.min(raw, remaining));
    remaining -= amount;
    return amount;
  });
  return { amounts, remaining };
}

/**
 * total を weights の比で按分する。各々切り捨てたあと、残りは重みの最も大きいもの
 * （同じなら tieBreak で先に来るもの）に寄せる。重みの合計が0なら全額0。
 */
export function allocate(total: number, weights: readonly number[], tieBreak: (a: number, b: number) => number = (a, b) => a - b) {
  const sum = weights.reduce((s, w) => s + w, 0);
  if (sum === 0 || total === 0) return weights.map(() => 0);
  const shares = weights.map((w) => Math.floor((total * w) / sum));
  const remainder = total - shares.reduce((s, v) => s + v, 0);
  if (remainder > 0) {
    let best = 0;
    for (let i = 1; i < weights.length; i++) {
      const diff = weights[i]! - weights[best]!;
      if (diff > 0 || (diff === 0 && tieBreak(i, best) < 0)) best = i;
    }
    shares[best]! += remainder;
  }
  return shares;
}

export function roundTax(value: number, mode: TaxRoundingMode, numerator: number, denominator: number) {
  // value × numerator / denominator を整数演算で端数処理する
  const product = value * numerator;
  const q = Math.floor(product / denominator);
  const r = product - q * denominator;
  if (mode === 'floor' || r === 0) return q;
  if (mode === 'ceil') return q + 1;
  return r * 2 >= denominator ? q + 1 : q;
}

export function taxIncluded(amount: number, rate: TaxRate, mode: TaxRoundingMode) {
  return roundTax(amount, mode, rate, 100 + rate);
}

export function priceOrder(input: PricingInput): PricingResult {
  const priced = input.lines.map((line) => {
    const gross = (line.unitPrice + line.optionsDelta) * line.quantity;
    const { amounts, remaining } = applyDiscounts(gross, line.discounts);
    return {
      taxRate: taxRateFor(line.reducedTaxEligible, input.diningOption),
      gross,
      lineDiscountAmounts: amounts,
      lineDiscountTotal: gross - remaining,
      afterLineDiscount: remaining,
    };
  });

  const afterLineTotal = priced.reduce((s, l) => s + l.afterLineDiscount, 0);
  const order = applyDiscounts(afterLineTotal, input.orderDiscounts);
  const orderDiscountTotal = afterLineTotal - order.remaining;

  // 会計割引を税率グループへ → 各グループ内の明細へ按分する
  const rates: TaxRate[] = [10, 8];
  const groupTotals = rates.map((rate) =>
    priced.filter((l) => l.taxRate === rate).reduce((s, l) => s + l.afterLineDiscount, 0),
  );
  // 同額なら税率の高い方（rates の先頭 = 10%）へ寄せる
  const groupShares = allocate(orderDiscountTotal, groupTotals);
  const allocated = priced.map(() => 0);
  rates.forEach((rate, gi) => {
    const indexes = priced.flatMap((l, i) => (l.taxRate === rate ? [i] : []));
    const shares = allocate(
      groupShares[gi]!,
      indexes.map((i) => priced[i]!.afterLineDiscount),
    );
    indexes.forEach((lineIndex, k) => {
      allocated[lineIndex] = shares[k]!;
    });
  });

  const lines: PricedLine[] = priced.map((l, i) => ({
    ...l,
    allocatedOrderDiscount: allocated[i]!,
    net: l.afterLineDiscount - allocated[i]!,
  }));

  const taxes = rates
    .map((rate) => {
      const taxableAmount = lines.filter((l) => l.taxRate === rate).reduce((s, l) => s + l.net, 0);
      return { taxRate: rate, taxableAmount, taxAmount: taxIncluded(taxableAmount, rate, input.taxRounding) };
    })
    // 明細のある税率だけ載せる（割引で0円になった税率も、明細があれば載せる）
    .filter((t) => lines.some((l) => l.taxRate === t.taxRate));

  const subtotal = lines.reduce((s, l) => s + l.gross, 0);
  const lineDiscountTotal = lines.reduce((s, l) => s + l.lineDiscountTotal, 0);
  const total = lines.reduce((s, l) => s + l.net, 0);
  return {
    lines,
    orderDiscountAmounts: order.amounts,
    subtotal,
    lineDiscountTotal,
    orderDiscountTotal,
    discountTotal: lineDiscountTotal + orderDiscountTotal,
    total,
    taxes,
  };
}

/** 現金会計の釣銭。預り金が足りなければ null */
export function changeFor(total: number, cashReceived: number) {
  return cashReceived >= total ? cashReceived - total : null;
}
