import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  parseCsv,
  STAFF_SESSION_HEADER,
  type AuditLogEntry,
  type RefundQuote,
  type RegisterSettlementRow,
  type SalesReport,
  type TransactionDetail,
} from '@pos/shared';
import { ADMIN, createShop, json, simpleSale, type Shop } from './shop.js';

/**
 * 売上画面の数値がテストデータの期待値と一致すること（フェーズ6の完了条件）。
 *
 * テストデータ（すべて今日の営業日）
 *  S1 レジ1 店内 現金   バーガーセット(コーラ)                 500
 *  S2 レジ1 持帰 PayPay コーヒー×2(380×2=760, 8%) + ビール600(10%)   1360
 *  S3 レジ3 店内 現金   ポテトL×2(800) 1割引(-80) 100円引(-100)       620
 *  R1 レジ1 S3 のポテトを1個返金                         -310（割引按分後 620 の半分）
 *  R2 レジ3 S1 を全額返金                                 -500
 *  X1 レジ1 S2 のビールをコーヒー1個(380)に変更           -220（PayPay で返金）
 */

let shop: Shop;
let report: SalesReport;
let adminToken: string;
let reg1: Awaited<ReturnType<Shop['openRegister']>>;
let reg3: Awaited<ReturnType<Shop['openRegister']>>;

const today = () => {
  const d = new Date(Date.now() - 4 * 60 * 60 * 1000); // 既定の切替時刻 4:00
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

async function admin<T>(url: string) {
  const res = await shop.t.app.inject({ method: 'GET', url, headers: { [STAFF_SESSION_HEADER]: adminToken } });
  const isJson = String(res.headers['content-type'] ?? '').includes('json');
  return { status: res.statusCode, body: (isJson ? res.json<T>() : undefined) as T, raw: res };
}

async function refund(
  reg: typeof reg1,
  saleId: number,
  pick: (d: TransactionDetail) => { lineId: number; quantity: number }[],
  additions: unknown[] = [],
) {
  const d = (await shop.t.app.inject({ method: 'GET', url: `/api/transactions/${saleId}/detail`, headers: reg.headers })).json<TransactionDetail>();
  const body = { returns: pick(d), additions };
  const q = (await shop.t.app.inject({ method: 'POST', url: `/api/transactions/${saleId}/refund-quote`, headers: reg.headers, payload: body })).json<RefundQuote>();
  const res = await shop.t.app.inject({
    method: 'POST',
    url: `/api/transactions/${saleId}/refund`,
    headers: reg.headers,
    payload: { ...body, idempotencyKey: randomUUID(), registerSessionId: reg.sessionId, reason: 'テスト', approver: { code: ADMIN.code, pin: ADMIN.pin }, expectedDifference: q.difference },
  });
  expect(res.statusCode, res.body).toBe(200);
}

beforeAll(async () => {
  shop = await createShop();
  adminToken = await shop.t.adminLogin();
  reg1 = await shop.openRegister(1);
  reg3 = await shop.openRegister(3);
  const sizeL = shop.ids.size.options.find((o) => o.name === 'L')!;

  const s1 = json(await reg1.checkout(simpleSale(shop)));
  const s2 = json(
    await reg1.checkout({
      diningOption: 'take_out',
      lines: [
        { productId: shop.ids.coffee.id, quantity: 2 },
        { productId: shop.ids.beer.id, quantity: 1 },
      ],
      payment: { method: 'paypay' },
      expectedTotal: 1360,
    }),
  );
  const s3 = json(
    await reg3.checkout({
      diningOption: 'eat_in',
      lines: [{ productId: shop.ids.potato.id, optionIds: [sizeL.id], quantity: 2, discounts: [{ discountId: shop.ids.lineCoupon.id }] }],
      orderDiscounts: [{ discountId: shop.ids.coupon.id }],
      payment: { method: 'cash', cashReceived: 1000 },
      expectedTotal: 620,
    }),
  );
  await refund(reg1, s3.transactionId, (d) => [{ lineId: d.lines[0]!.lineId, quantity: 1 }]);
  await refund(reg3, s1.transactionId, (d) => d.lines.map((l) => ({ lineId: l.lineId, quantity: l.quantity })));
  await refund(reg1, s2.transactionId, (d) => [{ lineId: d.lines.find((l) => l.name === 'ビール')!.lineId, quantity: 1 }], [
    { productId: shop.ids.coffee.id, quantity: 1 },
  ]);

  const res = await admin<SalesReport>(`/api/admin/reports/sales?from=${today()}`);
  expect(res.status).toBe(200);
  report = res.body;
});



describe('売上確認', () => {
  it('合計・客数・客単価・割引額', () => {
    expect(report.summary).toEqual({
      grossSales: 2480, // 500 + 1360 + 620
      refunds: -1030, // -310 - 500 - 220
      netSales: 1450,
      saleCount: 3,
      cancelledCount: 1, // S1（全額返金）
      customerCount: 2,
      averagePerCustomer: 725, // 1450 / 2
      discountTotal: 90, // 販売 80 + 100、ポテト1個の返金で戻した割引 90（400 - 310）
      refundCount: 3,
    });
  });

  it('商品別（返品した数量を差し引く）', () => {
    expect(report.products.map((p) => [p.name, p.category, p.quantity, p.amount])).toEqual([
      ['コーヒー', 'ドリンク', 3, 1140],
      ['ポテト', 'フード', 1, 310],
      ['バーガーセット', 'フード', 0, 0],
      ['ビール', 'ドリンク', 0, 0],
    ]);
  });

  it('カテゴリ別', () => {
    expect(report.categories).toEqual([
      { name: 'ドリンク', quantity: 3, amount: 1140 },
      { name: 'フード', quantity: 1, amount: 310 },
    ]);
  });

  it('支払方法別・店内/持ち帰り別', () => {
    expect(report.payments).toEqual([
      { method: 'cash', amount: 310, count: 2 }, // 500 + 620 - 310 - 500
      { method: 'paypay', amount: 1140, count: 1 }, // 1360 - 220
    ]);
    expect(report.dining).toEqual([
      { diningOption: 'eat_in', amount: 310, count: 2 },
      { diningOption: 'take_out', amount: 1140, count: 1 },
    ]);
  });

  it('税率別（返金・変更の分を差し引いた対象額と税額）', () => {
    expect(report.taxes).toEqual([
      // 10%: 500(45) + 600(54) + 620(56) - 310(28) - 500(45) - 600(54)
      { taxRate: 10, taxableAmount: 310, taxAmount: 28 },
      // 8%: 760(56) + 380(28)
      { taxRate: 8, taxableAmount: 1140, taxAmount: 84 },
    ]);
  });

  it('レジ別（返金は返金したレジに計上）', () => {
    expect(report.registers).toEqual([
      { registerNumber: 1, name: 'レジ1', amount: 1330, count: 2, cash: 190, paypay: 1140 },
      { registerNumber: 3, name: 'レジ3', amount: 120, count: 1, cash: 120, paypay: 0 },
    ]);
  });

  it('割引の内訳と返金の一覧', () => {
    expect(report.discounts).toEqual([
      { name: '100円引', manual: false, count: 1, amount: 100 },
      { name: '1割引', manual: false, count: 1, amount: 80 },
    ]);
    expect(report.refunds.map((r) => [r.kind, r.amount, r.registerNumber, r.approverName, r.reason])).toEqual([
      ['refund', -310, 1, '管理者', 'テスト'],
      ['refund', -500, 3, '管理者', 'テスト'],
      ['exchange', -220, 1, '管理者', 'テスト'],
    ]);
    expect(report.refunds.every((r) => r.originalReceiptNumber !== null)).toBe(true);
  });

  it('どの切り口でも合計は純売上と一致する', () => {
    const net = report.summary.netSales;
    const sum = (xs: { amount: number }[]) => xs.reduce((s, x) => s + x.amount, 0);
    for (const xs of [report.products, report.categories, report.hourly, report.payments, report.dining, report.registers]) {
      expect(sum(xs)).toBe(net);
    }
    expect(report.taxes.reduce((s, t) => s + t.taxableAmount, 0)).toBe(net);
    expect(report.hourly).toHaveLength(24);
    expect(report.hourly[0]!.hour).toBe(4); // 営業日の切替時刻から並べる
    expect(report.hourly.reduce((s, h) => s + h.count, 0)).toBe(3);
  });

  it('取引の無い日は0で返す', async () => {
    const res = await admin<SalesReport>('/api/admin/reports/sales?from=2000-01-01');
    expect(res.body.summary).toMatchObject({ netSales: 0, customerCount: 0, averagePerCustomer: 0 });
    expect(res.body.products).toEqual([]);
  });

  it('日付の形式・範囲の誤りは 400、管理者以外は 401', async () => {
    expect((await admin('/api/admin/reports/sales?from=2026/11/04')).status).toBe(400);
    expect((await admin(`/api/admin/reports/sales?from=${today()}&to=2000-01-01`)).status).toBe(400);
    expect((await shop.t.app.inject({ method: 'GET', url: `/api/admin/reports/sales?from=${today()}`, headers: reg1.headers })).statusCode).toBe(401);
  });
});

describe('レジ点検・精算', () => {
  it('レジごとの理論在高・PayPay 売上・過不足', async () => {
    await shop.t.app.inject({ method: 'POST', url: `/api/register/sessions/${reg3.sessionId}/close`, headers: reg3.headers, payload: { countedCash: 10100 } });
    const { body } = await admin<{ settlements: RegisterSettlementRow[] }>(`/api/admin/reports/settlements?from=${today()}`);
    expect(body.settlements.map((s) => [s.registerNumber, s.openingCash, s.cashSales, s.paypaySales, s.expectedCash, s.countedCash, s.cashDifference, s.closedAt !== null])).toEqual([
      [1, 10000, 190, 1140, 10190, null, null, false], // 開設中（点検）
      [3, 10000, 120, 0, 10120, 10100, -20, true], // 閉設済み（精算）: 20円不足
    ]);
    expect(body.settlements[1]!.closedByName).toBe('スタッフ');
  });
});

describe('CSV 出力', () => {
  it('BOM 付き UTF-8 で、すべての行に店舗コードと期間を入れる', async () => {
    const { raw } = await admin(`/api/admin/reports/summary.csv?from=${today()}`);
    expect(raw.statusCode).toBe(200);
    expect(raw.headers['content-type']).toContain('text/csv');
    expect(raw.headers['content-disposition']).toContain(`STORE01-summary-${today()}.csv`);
    expect(raw.body.startsWith('﻿')).toBe(true);
    const rows = parseCsv(raw.body);
    expect(rows[0]!.slice(0, 6)).toEqual(['店舗コード', '開始日', '終了日', '総売上', '返金・変更', '純売上']);
    expect(rows[1]!.slice(0, 6)).toEqual(['STORE01', today(), today(), '2480', '-1030', '1450']);
  });

  it('すべての種類を出力でき、取引明細は全取引を含む', async () => {
    for (const kind of ['products', 'categories', 'hourly', 'payments', 'dining', 'taxes', 'discounts', 'registers', 'refunds', 'settlements']) {
      expect((await admin(`/api/admin/reports/${kind}.csv?from=${today()}`)).raw.statusCode, kind).toBe(200);
    }
    const tx = parseCsv((await admin(`/api/admin/reports/transactions.csv?from=${today()}`)).raw.body);
    expect(tx).toHaveLength(1 + 6);
    expect(tx.slice(1).map((r) => r[5])).toEqual(['販売', '販売', '販売', '返金', '返金', '商品変更']);
    expect((await admin(`/api/admin/reports/unknown.csv?from=${today()}`)).raw.statusCode).toBe(400);
  });
});

describe('操作ログ', () => {
  it('分類で絞り込み、新しい順にページ送りできる', async () => {
    const refunds = (await admin<{ logs: AuditLogEntry[] }>('/api/admin/audit-logs?category=refund')).body.logs;
    expect(refunds.map((l) => l.actionLabel)).toEqual(['商品変更', '返金', '返金']);
    expect(refunds[0]!.employeeName).toBe('スタッフ');
    expect(refunds[0]!.deviceName).toBe('レジ端末1');

    const discounts = (await admin<{ logs: AuditLogEntry[] }>('/api/admin/audit-logs?category=discount')).body.logs;
    expect(discounts).toHaveLength(1);

    const page1 = (await admin<{ logs: AuditLogEntry[]; nextBeforeId: number | null }>('/api/admin/audit-logs?limit=2')).body;
    expect(page1.logs).toHaveLength(2);
    expect(page1.nextBeforeId).not.toBeNull();
    const page2 = (await admin<{ logs: AuditLogEntry[] }>(`/api/admin/audit-logs?limit=2&beforeId=${page1.nextBeforeId}`)).body;
    expect(page2.logs[0]!.id).toBeLessThan(page1.logs[1]!.id);
  });
});

afterAll(async () => {
  await shop.close();
});
