import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { STAFF_SESSION_HEADER, type ReceiptDocument, type ReceiptRow } from '@pos/shared';
import { auditLogs } from '../src/db/schema.js';
import { createShop, json, simpleSale, type Shop } from './shop.js';

let shop: Shop;
beforeEach(async () => {
  shop = await createShop();
  const { settings } = await shop.admin<{ settings: Record<string, unknown> }>('GET', '/api/admin/settings');
  await shop.admin('PUT', '/api/admin/settings', {
    ...settings,
    storeName: 'テスト食堂',
    address: '東京都千代田区1-1-1',
    phone: '03-0000-0000',
    invoiceRegistrationNumber: 'T1234567890123',
    receiptHeader: 'いらっしゃいませ',
    receiptFooter: 'またのお越しをお待ちしております',
  });
});
afterEach(async () => {
  await shop.close();
});

type ReceiptView = { document: ReceiptDocument; rows: ReceiptRow[]; text: string };

const sizeOf = (rows: ReceiptRow[], text: string) =>
  rows.find((r) => r.type === 'text' && r.text === text) as Extract<ReceiptRow, { type: 'text' }> | undefined;

/** 持ち帰り: ポテト（軽減対象→8%）+ ビール（対象外→10%）、会計割引100円、現金2000円 */
async function takeOutSale() {
  const reg = await shop.openRegister(1);
  const sizeL = shop.ids.size.options.find((o) => o.name === 'L')!;
  const res = await reg.checkout({
    diningOption: 'take_out',
    lines: [
      { productId: shop.ids.potato.id, optionIds: [sizeL.id], quantity: 2, discounts: [{ discountId: shop.ids.lineCoupon.id }] },
      { productId: shop.ids.beer.id, quantity: 1 },
    ],
    orderDiscounts: [{ discountId: shop.ids.coupon.id }],
    payment: { method: 'cash', cashReceived: 2000 },
    // ポテトL 400×2=800 → 1割引 80 → 720、ビール 600 → 合計 1320 → 100円引 → 1220
    expectedTotal: 1220,
  });
  expect(res.statusCode).toBe(200);
  return { reg, sale: json(res) };
}

describe('レシート', () => {
  it('適格簡易請求書の記載事項と要件3.7の項目をすべて含む', async () => {
    const { reg, sale } = await takeOutSale();
    const res = await shop.t.app.inject({ method: 'GET', url: `/api/transactions/${sale.transactionId}/receipt`, headers: reg.headers });
    expect(res.statusCode).toBe(200);
    const { text, document } = res.json<ReceiptView>();

    for (const expected of [
      'いらっしゃいませ', // ヘッダー
      'テスト食堂', // 事業者の名称
      '東京都千代田区1-1-1',
      'TEL 03-0000-0000',
      '登録番号 T1234567890123', // 登録番号
      'レジ 1（レジ1）', // レジ番号
      '担当 スタッフ', // 担当者
      sale.receiptNumber, // レシート番号
      '持ち帰り',
      'ポテト※', // 明細（軽減税率の対象である旨）
      '・L（+¥100）', // オプション
      '¥400 × 2',
      '割引 1割引', // 明細割引
      '割引 100円引', // 会計割引
      '合計',
      '¥1,220',
      '10%対象', // 税率ごとの対価の額
      '8%対象',
      '内消費税(10%)', // 税率ごとの消費税額
      '内消費税(8%)',
      'お支払',
      '現金',
      'お預り',
      '¥2,000',
      'お釣り',
      '¥780',
      '※は軽減税率（8%）対象商品です',
      '注文番号',
      'またのお越しをお待ちしております', // フッター
    ]) {
      expect(text, expected).toContain(expected);
    }
    // 取引年月日
    expect(text).toMatch(/\d{4}年\d{2}月\d{2}日 \d{2}:\d{2}/);
    // 税率ごとの金額は会計時の記録と一致する（按分: 100 × 720/1320 = 54.5 → 54, 端数は大きい8%側へ → 55 / 45）
    expect(document.taxes).toEqual([
      { taxRate: 10, taxableAmount: 555, taxAmount: 50 },
      { taxRate: 8, taxableAmount: 665, taxAmount: 49 },
    ]);
    expect(document.reprint).toBe(false);
    expect(text).not.toContain('再発行');
  });

  it('自動採番の注文番号は特大、番号札は大きめで印字する', async () => {
    const { reg, sale } = await takeOutSale();
    const auto = (
      await shop.t.app.inject({ method: 'GET', url: `/api/transactions/${sale.transactionId}/receipt`, headers: reg.headers })
    ).json<ReceiptView>();
    expect(sizeOf(auto.rows, '100')?.size).toBe('xlarge');

    const ticketReg = await shop.openRegister(2);
    const ticket = json(await ticketReg.checkout(simpleSale(shop, { ticketNumber: 7 })));
    const view = (
      await shop.t.app.inject({ method: 'GET', url: `/api/transactions/${ticket.transactionId}/receipt`, headers: ticketReg.headers })
    ).json<ReceiptView>();
    expect(sizeOf(view.rows, '007')?.size).toBe('large');
    // 店内の会計では軽減税率の注記を出さない
    expect(view.text).not.toContain('※は軽減税率');
  });

  it('再発行は「再発行」と明記し、操作ログに残す', async () => {
    const { reg, sale } = await takeOutSale();
    const res = await shop.t.app.inject({ method: 'POST', url: `/api/transactions/${sale.transactionId}/reprint`, headers: reg.headers });
    expect(res.statusCode).toBe(200);
    const body = res.json<ReceiptView & { result: { driver: string; printed: boolean } }>();
    expect(body.document.reprint).toBe(true);
    expect(body.text).toContain('【再発行】');
    expect(body.text).toContain('※この控えは再発行したものです');
    expect(body.result).toMatchObject({ driver: 'dummy', printed: false });
    const logs = shop.t.database.db.select().from(auditLogs).where(eq(auditLogs.action, 'receipt.reprinted')).all();
    expect(logs).toHaveLength(1);
    expect(logs[0]!.after).toEqual({ receiptNumber: sale.receiptNumber });
  });

  it('PDF で出力できる（日本語フォントを埋め込む）', async () => {
    const { reg, sale } = await takeOutSale();
    const res = await shop.t.app.inject({
      method: 'GET',
      url: `/api/transactions/${sale.transactionId}/receipt.pdf?reprint=1`,
      headers: reg.headers,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toContain(`receipt-${sale.receiptNumber}-reprint.pdf`);
    const pdf = res.rawPayload;
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    // TrueType を埋め込み、使った文字だけに絞っている（数 MB のフォント全体ではない）
    expect(pdf.includes('/FontFile2')).toBe(true);
    expect(pdf.length).toBeLessThan(300_000);
  });

  it('管理者は参照でき、ログインしていないレジやキッチンは参照できない', async () => {
    const { sale } = await takeOutSale();
    const url = `/api/transactions/${sale.transactionId}/receipt`;
    const adminToken = await shop.t.adminLogin();
    expect((await shop.t.app.inject({ method: 'GET', url, headers: { [STAFF_SESSION_HEADER]: adminToken } })).statusCode).toBe(200);
    const kitchen = await shop.device('kitchen');
    expect((await shop.t.app.inject({ method: 'GET', url, headers: kitchen.headers })).statusCode).toBe(401);
    expect((await shop.t.app.inject({ method: 'GET', url })).statusCode).toBe(401);
  });

  it('存在しない取引は 404', async () => {
    const { reg } = await takeOutSale();
    expect((await shop.t.app.inject({ method: 'GET', url: '/api/transactions/9999/receipt', headers: reg.headers })).statusCode).toBe(404);
  });
});
