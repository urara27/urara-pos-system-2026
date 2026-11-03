import { describe, expect, it } from 'vitest';
import {
  buildReceiptLayout,
  displayWidth,
  formatReceiptDate,
  renderReceiptText,
  type ReceiptDocument,
} from './receipt.js';

const doc = (patch: Partial<ReceiptDocument> = {}): ReceiptDocument => ({
  kind: 'sale',
  originalReceiptNumber: null,
  reprint: false,
  store: { code: 'S1', name: '店', address: '', phone: '', registrationNumber: 'T1234567890123', header: '', footer: '' },
  issuedAt: Date.UTC(2026, 10, 3, 15, 5), // 2026-11-04 00:05 JST
  register: { number: 1, name: 'レジ1' },
  staffName: '山田',
  receiptNumber: '20261103-1-0001',
  diningOption: 'eat_in',
  order: { number: 7, numberingMode: 'ticket' },
  lines: [{ name: 'コーヒー', quantity: 1, unitPrice: 400, taxRate: 10, gross: 400, options: [], discounts: [] }],
  subtotal: 400,
  orderDiscounts: [],
  total: 400,
  taxes: [{ taxRate: 10, taxableAmount: 400, taxAmount: 36 }],
  payment: { method: 'paypay', cashReceived: null, change: null },
  ...patch,
});

describe('レシートのレイアウト', () => {
  it('日時は日本時間で印字する', () => {
    expect(formatReceiptDate(Date.UTC(2026, 10, 3, 15, 5))).toBe('2026年11月04日 00:05');
  });

  it('全角は幅2、半角は幅1で数える', () => {
    expect(displayWidth('abc')).toBe(3);
    expect(displayWidth('レジ')).toBe(4);
    expect(displayWidth('¥1,000')).toBe(6);
    expect(displayWidth('ｱｲｳ')).toBe(3);
  });

  it('等幅テキストは48桁に収まり、左右の項目は右端で揃う', () => {
    const text = renderReceiptText(buildReceiptLayout(doc({ store: { ...doc().store, name: 'とても長い店舗名'.repeat(5) } })));
    for (const line of text.split('\n')) expect(displayWidth(line)).toBeLessThanOrEqual(48);
    const total = text.split('\n').find((l) => l.startsWith('合計'))!;
    // 倍角は24桁分（表示上48桁）
    expect(displayWidth(total)).toBe(24);
    expect(total.endsWith('¥400')).toBe(true);
  });

  it('PayPay では預り金・釣銭を出さず、注文番号がなければ注文番号欄を出さない', () => {
    const text = renderReceiptText(buildReceiptLayout(doc({ order: null })));
    expect(text).toContain('PayPay');
    expect(text).not.toContain('お預り');
    expect(text).not.toContain('注文番号');
  });

  it('返金レシートは【返金】と明記する', () => {
    expect(renderReceiptText(buildReceiptLayout(doc({ kind: 'refund' })))).toContain('【返金】');
  });
});
