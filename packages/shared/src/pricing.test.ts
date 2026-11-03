import { describe, expect, it } from 'vitest';
import { allocate, applyDiscounts, changeFor, priceOrder, roundTax, taxRateFor, type PricingLine } from './pricing.js';

const line = (unitPrice: number, quantity = 1, extra: Partial<PricingLine> = {}): PricingLine => ({
  unitPrice,
  optionsDelta: 0,
  quantity,
  reducedTaxEligible: true,
  discounts: [],
  ...extra,
});

describe('税率の決定', () => {
  it.each([
    [true, 'eat_in', 10],
    [true, 'take_out', 8],
    [false, 'eat_in', 10],
    [false, 'take_out', 10],
  ] as const)('軽減対象=%s / %s → %i%%', (eligible, dining, rate) => {
    expect(taxRateFor(eligible, dining)).toBe(rate);
  });
});

describe('税額の端数処理（税込から逆算）', () => {
  it.each([
    // 1100円・10% → 100円ちょうど
    [1100, 10, 'floor', 100],
    // 1000円・10% → 90.90…
    [1000, 10, 'floor', 90],
    [1000, 10, 'round', 91],
    [1000, 10, 'ceil', 91],
    // 540円・8% → 40円ちょうど
    [540, 8, 'floor', 40],
    // 500円・8% → 37.03…
    [500, 8, 'floor', 37],
    [500, 8, 'round', 37],
    [500, 8, 'ceil', 38],
    // 55円・10% → 5.0 ちょうど（切り上げでも 5）
    [55, 10, 'ceil', 5],
    [0, 10, 'ceil', 0],
  ] as const)('%i円 %i%% %s → %i円', (amount, rate, mode, expected) => {
    expect(roundTax(amount, mode, rate, 100 + rate)).toBe(expected);
  });

  it('四捨五入はちょうど .5 で切り上げる', () => {
    // 1 × 1/2 = 0.5 → 1、27円 × 10/110 = 2.45… → 2
    expect(roundTax(1, 'round', 1, 2)).toBe(1);
    expect(roundTax(27, 'round', 10, 110)).toBe(2);
  });
});

describe('割引の適用', () => {
  it('適用順に計算し、率は残額に掛けて切り捨てる', () => {
    // 1000 → 10% で 100 → 残 900 → 50円 → 残 850 → 15% で 127.5 → 127
    const r = applyDiscounts(1000, [
      { kind: 'rate', value: 10 },
      { kind: 'amount', value: 50 },
      { kind: 'rate', value: 15 },
    ]);
    expect(r.amounts).toEqual([100, 50, 127]);
    expect(r.remaining).toBe(723);
  });

  it('残額を超える割引は0円で止める', () => {
    const r = applyDiscounts(300, [
      { kind: 'amount', value: 500 },
      { kind: 'rate', value: 10 },
    ]);
    expect(r.amounts).toEqual([300, 0]);
    expect(r.remaining).toBe(0);
  });
});

describe('按分', () => {
  it('比で切り捨て、端数は重みの大きい方へ', () => {
    expect(allocate(100, [2, 1])).toEqual([67, 33]);
    expect(allocate(10, [1, 1, 1])).toEqual([4, 3, 3]);
  });
  it('同じ重みなら先頭へ寄せる', () => {
    expect(allocate(1, [500, 500])).toEqual([1, 0]);
  });
  it('合計0なら全て0', () => {
    expect(allocate(100, [0, 0])).toEqual([0, 0]);
  });
});

describe('会計の計算', () => {
  it('オプション加算と数量', () => {
    const r = priceOrder({
      lines: [line(500, 2, { optionsDelta: 50 })],
      orderDiscounts: [],
      diningOption: 'eat_in',
      taxRounding: 'floor',
    });
    expect(r.subtotal).toBe(1100);
    expect(r.total).toBe(1100);
    expect(r.taxes).toEqual([{ taxRate: 10, taxableAmount: 1100, taxAmount: 100 }]);
  });

  it('持ち帰りでは軽減対象が8%、対象外（酒類）は10%のまま', () => {
    const r = priceOrder({
      lines: [line(540), line(550, 1, { reducedTaxEligible: false })],
      orderDiscounts: [],
      diningOption: 'take_out',
      taxRounding: 'floor',
    });
    expect(r.lines.map((l) => l.taxRate)).toEqual([8, 10]);
    expect(r.taxes).toEqual([
      { taxRate: 10, taxableAmount: 550, taxAmount: 50 },
      { taxRate: 8, taxableAmount: 540, taxAmount: 40 },
    ]);
  });

  it('税額は明細ごとではなく、税率ごとの合計から1回だけ計算する', () => {
    // 各 105円 × 3 明細: 明細ごとに切り捨てると 9×3=27 だが、合計 315 → 28
    const r = priceOrder({
      lines: [line(105), line(105), line(105)],
      orderDiscounts: [],
      diningOption: 'eat_in',
      taxRounding: 'floor',
    });
    expect(r.taxes[0]!.taxAmount).toBe(28);
  });

  it('明細割引と会計割引', () => {
    const r = priceOrder({
      lines: [line(500, 1, { discounts: [{ kind: 'amount', value: 100 }] }), line(300)],
      orderDiscounts: [{ kind: 'rate', value: 10 }],
      diningOption: 'eat_in',
      taxRounding: 'floor',
    });
    // 明細割引後 400 + 300 = 700 → 10% = 70
    expect(r.lineDiscountTotal).toBe(100);
    expect(r.orderDiscountAmounts).toEqual([70]);
    expect(r.total).toBe(630);
    // 70 を 400:300 で按分 → 40 / 30
    expect(r.lines.map((l) => l.allocatedOrderDiscount)).toEqual([40, 30]);
    expect(r.lines.map((l) => l.net)).toEqual([360, 270]);
  });

  it('会計割引は税率グループの比で按分してから税額を計算する（端数は大きいグループへ）', () => {
    // 持ち帰り: 食品 800（8%）+ 酒 400（10%）、会計割引 100円
    // 100 × 800/1200 = 66.6 → 66、100 × 400/1200 = 33.3 → 33、端数1 → 大きい8%側 → 67/33
    const r = priceOrder({
      lines: [line(800), line(400, 1, { reducedTaxEligible: false })],
      orderDiscounts: [{ kind: 'amount', value: 100 }],
      diningOption: 'take_out',
      taxRounding: 'floor',
    });
    expect(r.lines.map((l) => [l.taxRate, l.allocatedOrderDiscount])).toEqual([
      [8, 67],
      [10, 33],
    ]);
    expect(r.taxes).toEqual([
      { taxRate: 10, taxableAmount: 367, taxAmount: 33 }, // 367×10/110 = 33.36
      { taxRate: 8, taxableAmount: 733, taxAmount: 54 }, // 733×8/108 = 54.29
    ]);
    expect(r.total).toBe(1100);
  });

  it('税率グループが同額なら端数は10%側へ寄せる', () => {
    const r = priceOrder({
      lines: [line(500), line(500, 1, { reducedTaxEligible: false })],
      orderDiscounts: [{ kind: 'amount', value: 1 }],
      diningOption: 'take_out',
      taxRounding: 'floor',
    });
    const byRate = Object.fromEntries(r.lines.map((l) => [l.taxRate, l.allocatedOrderDiscount]));
    expect(byRate).toEqual({ 10: 1, 8: 0 });
  });

  it('グループ内の明細への按分合計はグループの按分額と一致する', () => {
    const r = priceOrder({
      lines: [line(333), line(333), line(334)],
      orderDiscounts: [{ kind: 'amount', value: 100 }],
      diningOption: 'eat_in',
      taxRounding: 'floor',
    });
    expect(r.lines.reduce((s, l) => s + l.allocatedOrderDiscount, 0)).toBe(100);
    expect(r.total).toBe(900);
  });

  it('100%割引で0円の会計もできる', () => {
    const r = priceOrder({
      lines: [line(500)],
      orderDiscounts: [{ kind: 'rate', value: 100 }],
      diningOption: 'eat_in',
      taxRounding: 'floor',
    });
    expect(r.total).toBe(0);
    expect(r.taxes).toEqual([{ taxRate: 10, taxableAmount: 0, taxAmount: 0 }]);
  });

  it('税額の合計は「合計 - 税抜」と矛盾しない（税込合計 = 各税率の対象額の和）', () => {
    const r = priceOrder({
      lines: [line(398, 3), line(1280, 1, { reducedTaxEligible: false }), line(120, 7)],
      orderDiscounts: [{ kind: 'rate', value: 7 }, { kind: 'amount', value: 33 }],
      diningOption: 'take_out',
      taxRounding: 'round',
    });
    expect(r.taxes.reduce((s, t) => s + t.taxableAmount, 0)).toBe(r.total);
    expect(r.subtotal - r.discountTotal).toBe(r.total);
  });
});

describe('釣銭', () => {
  it('預り金から計算し、不足は null', () => {
    expect(changeFor(630, 1000)).toBe(370);
    expect(changeFor(630, 630)).toBe(0);
    expect(changeFor(630, 500)).toBeNull();
  });
});
