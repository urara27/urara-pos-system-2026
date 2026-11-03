import { describe, expect, it } from 'vitest';
import { proportionalShare, refundTaxes, returnedLineAmount, sumTaxes, type RefundableLine } from './refund.js';

const line = (patch: Partial<RefundableLine> = {}): RefundableLine => ({
  lineId: 1,
  quantity: 3,
  refundedQuantity: 0,
  taxRate: 10,
  gross: 1000,
  lineDiscount: 0,
  allocatedOrderDiscount: 0,
  net: 1000,
  ...patch,
});

describe('一部返金の按分', () => {
  it('分けて返金しても合計は元の金額にちょうど一致する', () => {
    // 1000円を3個: 333 / 333 / 334（端数は最後に寄る）
    expect(proportionalShare(1000, 3, 0, 1)).toBe(333);
    expect(proportionalShare(1000, 3, 1, 1)).toBe(333);
    expect(proportionalShare(1000, 3, 2, 1)).toBe(334);
    expect(proportionalShare(1000, 3, 0, 3)).toBe(1000);
    // 2個 → 1個 の順でも合計 1000
    expect(proportionalShare(1000, 3, 0, 2) + proportionalShare(1000, 3, 2, 1)).toBe(1000);
  });

  it('割引を適用した明細は、割引の按分後の金額で返金する', () => {
    // 500円×2、明細割引100、会計割引の按分45 → 支払 855
    const l = line({ quantity: 2, gross: 1000, lineDiscount: 100, allocatedOrderDiscount: 45, net: 855 });
    const first = returnedLineAmount(l, 1);
    expect(first).toEqual({ lineId: 1, quantity: 1, taxRate: 10, gross: 500, lineDiscount: 50, allocatedOrderDiscount: 23, net: 427 });
    const second = returnedLineAmount({ ...l, refundedQuantity: 1 }, 1);
    expect(second.net).toBe(428);
    expect(first.net + second.net).toBe(855);
    expect(first.gross - first.lineDiscount - first.allocatedOrderDiscount).toBe(first.net);
  });
});

describe('返金の税額', () => {
  const original = [
    { taxRate: 10 as const, taxableAmount: 1000, taxAmount: 90 },
    { taxRate: 8 as const, taxableAmount: 540, taxAmount: 40 },
  ];

  it('全額返金すると元の税額をそのまま戻す', () => {
    const returned = [
      returnedLineAmount(line({ quantity: 3, net: 1000, gross: 1000 }), 3),
      returnedLineAmount(line({ lineId: 2, quantity: 1, taxRate: 8, gross: 540, net: 540 }), 1),
    ];
    expect(refundTaxes(original, [], returned, 'floor')).toEqual(original);
  });

  it('分けて返金した税額の合計も元の税額と一致する', () => {
    const l = line({ quantity: 3, net: 1000, gross: 1000 });
    const r1 = [returnedLineAmount(l, 1)]; // 333 → 30
    const t1 = refundTaxes(original, [], r1, 'floor');
    expect(t1).toEqual([{ taxRate: 10, taxableAmount: 333, taxAmount: 30 }]);
    const r2 = [returnedLineAmount({ ...l, refundedQuantity: 1 }, 2)]; // 667 → 90 - 30 = 60
    const t2 = refundTaxes(original, t1, r2, 'floor');
    expect(t2).toEqual([{ taxRate: 10, taxableAmount: 667, taxAmount: 60 }]);
    expect(t1[0]!.taxAmount + t2[0]!.taxAmount).toBe(90);
  });

  it('税率ごとに足し合わせる（返金はマイナス）', () => {
    expect(
      sumTaxes(
        [{ taxRate: 10, taxableAmount: -500, taxAmount: -45 }],
        [{ taxRate: 10, taxableAmount: 700, taxAmount: 63 }, { taxRate: 8, taxableAmount: 300, taxAmount: 22 }],
      ),
    ).toEqual([
      { taxRate: 10, taxableAmount: 200, taxAmount: 18 },
      { taxRate: 8, taxableAmount: 300, taxAmount: 22 },
    ]);
  });
});
