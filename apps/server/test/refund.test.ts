import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type {
  CheckoutResult,
  EventEnvelope,
  OrderUpdatedPayload,
  RefundQuote,
  RefundRequest,
  RefundResult,
  RegisterSessionSummary,
  TransactionDetail,
  TransactionSummary,
} from '@pos/shared';
import { auditLogs, transactions, transactionTaxSummaries } from '../src/db/schema.js';
import { connectSocket, listen, waitFor } from './helpers.js';
import { ADMIN, STAFF, createShop, json, simpleSale, type Shop } from './shop.js';

let shop: Shop;
beforeEach(async () => {
  shop = await createShop();
});
afterEach(async () => {
  await shop.close();
});

type Register = Awaited<ReturnType<Shop['openRegister']>>;
const db = () => shop.t.database.db;
const approver = { code: ADMIN.code, pin: ADMIN.pin };

async function detail(reg: Register, id: number) {
  return (await shop.t.app.inject({ method: 'GET', url: `/api/transactions/${id}/detail`, headers: reg.headers })).json<TransactionDetail>();
}

async function quote(reg: Register, id: number, body: { returns: { lineId: number; quantity: number }[]; additions?: unknown[] }) {
  const res = await shop.t.app.inject({ method: 'POST', url: `/api/transactions/${id}/refund-quote`, headers: reg.headers, payload: body });
  return res;
}

/** 試算してから、その差額で確定する */
async function refund(
  reg: Register,
  id: number,
  body: { returns: { lineId: number; quantity: number }[]; additions?: unknown[] },
  extra: Partial<RefundRequest> = {},
) {
  const q = (await quote(reg, id, body)).json<RefundQuote>();
  return shop.t.app.inject({
    method: 'POST',
    url: `/api/transactions/${id}/refund`,
    headers: reg.headers,
    payload: {
      ...body,
      idempotencyKey: randomUUID(),
      registerSessionId: reg.sessionId,
      reason: 'お客様都合',
      approver,
      expectedDifference: q.difference,
      ...extra,
    },
  });
}

const allReturns = (d: TransactionDetail) =>
  d.lines.filter((l) => l.quantity > l.refundedQuantity).map((l) => ({ lineId: l.lineId, quantity: l.quantity - l.refundedQuantity }));

describe('全額返金', () => {
  it('受け渡し前の注文は取消になり、キッチン等へ通知される。元の販売データは変えない', async () => {
    const baseUrl = await listen(shop.t.app);
    const reg = await shop.openRegister(1);
    const kitchen = await shop.device('kitchen');
    const sale = json(await reg.checkout(simpleSale(shop)));
    const before = db().select().from(transactions).where(eq(transactions.id, sale.transactionId)).get();

    const socket = connectSocket(baseUrl, { deviceToken: kitchen.token });
    try {
      await waitFor(socket, 'system.hello');
      const event = waitFor<EventEnvelope<OrderUpdatedPayload>>(socket, 'order.updated');
      const res = await refund(reg, sale.transactionId, { returns: allReturns(await detail(reg, sale.transactionId)) });
      expect(res.statusCode).toBe(200);
      const r = res.json<RefundResult>();
      expect(r).toMatchObject({ kind: 'refund', difference: -500, paymentMethod: 'cash', orderEffect: 'cancelled' });
      const { payload } = await event;
      expect(payload.change).toBe('cancelled');
      expect(payload.order.status).toBe('cancelled');
    } finally {
      socket.disconnect();
    }

    expect((await kitchen.board()).active).toHaveLength(0);
    expect(db().select().from(transactions).where(eq(transactions.id, sale.transactionId)).get()).toEqual(before);
  });

  it('税額は元の取引の税額をそのまま戻す（合計がちょうど0になる）', async () => {
    const reg = await shop.openRegister(1);
    const sale = json(
      await reg.checkout({
        diningOption: 'take_out',
        lines: [
          { productId: shop.ids.coffee.id, quantity: 3 },
          { productId: shop.ids.beer.id, quantity: 1 },
        ],
        orderDiscounts: [{ discountId: shop.ids.coupon.id }],
        payment: { method: 'paypay' },
        expectedTotal: 380 * 3 + 600 - 100,
      }),
    );
    const r = (await refund(reg, sale.transactionId, { returns: allReturns(await detail(reg, sale.transactionId)) })).json<RefundResult>();
    const taxes = (id: number) => db().select().from(transactionTaxSummaries).where(eq(transactionTaxSummaries.transactionId, id)).all();
    for (const t of taxes(sale.transactionId)) {
      const back = taxes(r.transactionId).find((x) => x.taxRate === t.taxRate)!;
      expect(back.taxableAmount).toBe(-t.taxableAmount);
      expect(back.taxAmount).toBe(-t.taxAmount);
    }
  });

  it('受け渡し済みの注文を全額返金しても、注文は受け渡し済みのまま', async () => {
    const reg = await shop.openRegister(1);
    const pickup = await shop.device('pickup');
    const sale = json(await reg.checkout(simpleSale(shop)));
    await pickup.post(`/api/orders/${sale.orderId}/handover`);
    const r = (await refund(reg, sale.transactionId, { returns: allReturns(await detail(reg, sale.transactionId)) })).json<RefundResult>();
    expect(r.orderEffect).toBe('none');
    const recent = (await pickup.board()).recent.find((o) => o.id === sale.orderId)!;
    expect(recent.status).toBe('completed');
  });

  it('返金は返金したレジの現金在高から差し引かれる', async () => {
    const reg1 = await shop.openRegister(1);
    const reg3 = await shop.openRegister(3);
    const sale = json(await reg1.checkout(simpleSale(shop)));
    await refund(reg3, sale.transactionId, { returns: allReturns(await detail(reg1, sale.transactionId)) });
    const summary = async (reg: Register) =>
      (await shop.t.app.inject({ method: 'GET', url: `/api/register/sessions/${reg.sessionId}`, headers: reg.headers })).json<RegisterSessionSummary>();
    expect((await summary(reg1)).expectedCash).toBe(10500);
    expect((await summary(reg3)).expectedCash).toBe(9500);
  });
});

describe('一部返金', () => {
  /** バーガーセット（ジンジャー550・1割引）+ ポテトL×2（800）、会計100円引 → 1195円 */
  async function discountedSale(reg: Register) {
    const ginger = shop.ids.setDrink.options.find((o) => o.name === 'ジンジャー')!;
    const sizeL = shop.ids.size.options.find((o) => o.name === 'L')!;
    return json<CheckoutResult>(
      await reg.checkout({
        diningOption: 'eat_in',
        lines: [
          { productId: shop.ids.burger.id, optionIds: [ginger.id], quantity: 1, discounts: [{ discountId: shop.ids.lineCoupon.id }] },
          { productId: shop.ids.potato.id, optionIds: [sizeL.id], quantity: 2 },
        ],
        orderDiscounts: [{ discountId: shop.ids.coupon.id }],
        payment: { method: 'cash', cashReceived: 2000 },
        expectedTotal: 1195,
      }),
    );
  }

  it('割引を按分した額で返金し、分けて返金しても合計は支払額に一致する', async () => {
    const reg = await shop.openRegister(1);
    const sale = await discountedSale(reg);
    const d = await detail(reg, sale.transactionId);
    const potato = d.lines.find((l) => l.name === 'ポテト')!;
    // 会計割引100円の按分: 495:800 → 38 / 62（端数は大きい方へ）→ ポテトの支払額 738
    expect(potato.net).toBe(738);

    const first = (await refund(reg, sale.transactionId, { returns: [{ lineId: potato.lineId, quantity: 1 }] })).json<RefundResult>();
    expect(first.difference).toBe(-369);
    expect(first.orderEffect).toBe('modified');
    const second = (await refund(reg, sale.transactionId, { returns: [{ lineId: potato.lineId, quantity: 1 }] })).json<RefundResult>();
    expect(first.difference + second.difference).toBe(-738);
    // 残り数量を超える返金はできない
    const over = await quote(reg, sale.transactionId, { returns: [{ lineId: potato.lineId, quantity: 1 }] });
    expect(over.statusCode).toBe(400);
  });

  it('受け渡し前なら、キッチンの表示から返金した数量が減り「変更あり」になる', async () => {
    const reg = await shop.openRegister(1);
    const kitchen = await shop.device('kitchen');
    const sale = await discountedSale(reg);
    const potato = (await detail(reg, sale.transactionId)).lines.find((l) => l.name === 'ポテト')!;
    await refund(reg, sale.transactionId, { returns: [{ lineId: potato.lineId, quantity: 1 }] });
    const order = (await kitchen.board()).active[0]!;
    expect(order.modifiedAt).not.toBeNull();
    expect(order.items.find((i) => i.name === 'ポテト')!.quantity).toBe(1);
    expect(order.status).toBe('accepted');
  });

  it('ドリンクの明細をすべて返金したら、ドリンクのステーションは完了扱いになる', async () => {
    const reg = await shop.openRegister(1);
    const kitchen = await shop.device('kitchen');
    const sale = json(
      await reg.checkout({
        diningOption: 'eat_in',
        lines: [
          { productId: shop.ids.potato.id, optionIds: [shop.ids.size.options[0]!.id], quantity: 1 },
          { productId: shop.ids.beer.id, quantity: 1 },
        ],
        payment: { method: 'paypay' },
        expectedTotal: 900,
      }),
    );
    const beer = (await detail(reg, sale.transactionId)).lines.find((l) => l.name === 'ビール')!;
    await refund(reg, sale.transactionId, { returns: [{ lineId: beer.lineId, quantity: 1 }] });
    const order = (await kitchen.board()).active[0]!;
    expect(order.stations.drink.hasItems).toBe(false);
    expect(order.stations.food.hasItems).toBe(true);
  });
});

describe('商品の変更（差額の精算）', () => {
  it('返品と追加を1つの取引で記録し、差額を元の支払方法で精算する', async () => {
    const reg = await shop.openRegister(1);
    const kitchen = await shop.device('kitchen');
    // ビール 600円（PayPay）→ コーヒー 400円 × 2 に変更（差額 +200）
    const sale = json(
      await reg.checkout({
        diningOption: 'eat_in',
        lines: [{ productId: shop.ids.beer.id, quantity: 1 }],
        payment: { method: 'paypay' },
        expectedTotal: 600,
      }),
    );
    await kitchen.post(`/api/orders/${sale.orderId}/stations/all/complete`);
    const beer = (await detail(reg, sale.transactionId)).lines[0]!;
    const body = { returns: [{ lineId: beer.lineId, quantity: 1 }], additions: [{ productId: shop.ids.coffee.id, quantity: 2 }] };
    const q = (await quote(reg, sale.transactionId, body)).json<RefundQuote>();
    expect(q).toMatchObject({ returnAmount: 600, additionAmount: 800, difference: 200, fullRefund: false, paymentMethod: 'paypay' });

    const res = await refund(reg, sale.transactionId, body);
    expect(res.statusCode).toBe(200);
    expect(res.json<RefundResult>()).toMatchObject({ kind: 'exchange', difference: 200, orderEffect: 'modified' });

    // キッチン: ビールが消えてコーヒー×2になり、追加したドリンクは未完了に戻る
    const order = (await kitchen.board()).active[0]!;
    expect(order.items.map((i) => [i.name, i.quantity])).toEqual([['コーヒー', 2]]);
    expect(order.stations.drink).toEqual({ hasItems: true, completedAt: null });

    // 追加した商品も、後から返金できる
    const d = await detail(reg, sale.transactionId);
    const coffee = d.lines.find((l) => l.name === 'コーヒー')!;
    expect(coffee).toMatchObject({ quantity: 2, refundedQuantity: 0 });
    const back = (await refund(reg, sale.transactionId, { returns: [{ lineId: coffee.lineId, quantity: 2 }] })).json<RefundResult>();
    expect(back.difference).toBe(-800);
    expect(back.orderEffect).toBe('cancelled');
  });

  it('現金で差額をいただくときは預り金が必要で、釣銭を返す', async () => {
    const reg = await shop.openRegister(1);
    const sale = json(await reg.checkout(simpleSale(shop))); // 現金 500
    const line = (await detail(reg, sale.transactionId)).lines[0]!;
    const body = { returns: [{ lineId: line.lineId, quantity: 1 }], additions: [{ productId: shop.ids.beer.id, quantity: 1 }] };
    expect((await refund(reg, sale.transactionId, body)).statusCode).toBe(400);
    const r = (await refund(reg, sale.transactionId, body, { cashReceived: 1000 })).json<RefundResult>();
    expect(r).toMatchObject({ difference: 100, cashReceived: 1000, change: 900 });
  });
});

describe('承認・入力チェック', () => {
  it('責任者以上の PIN が必要で、理由も必須', async () => {
    const reg = await shop.openRegister(1);
    const sale = json(await reg.checkout(simpleSale(shop)));
    const body = { returns: allReturns(await detail(reg, sale.transactionId)) };
    expect((await refund(reg, sale.transactionId, body, { approver: { code: STAFF.code, pin: STAFF.pin } })).statusCode).toBe(401);
    expect((await refund(reg, sale.transactionId, body, { approver: { code: ADMIN.code, pin: '9999' } })).statusCode).toBe(401);
    expect((await refund(reg, sale.transactionId, body, { reason: '' })).statusCode).toBe(400);
    expect(db().select().from(transactions).all()).toHaveLength(1);
  });

  it('承認者・理由・金額を操作ログと取引に記録する', async () => {
    const reg = await shop.openRegister(1);
    const sale = json(await reg.checkout(simpleSale(shop)));
    const r = (await refund(reg, sale.transactionId, { returns: allReturns(await detail(reg, sale.transactionId)) }, { reason: '作り間違い' })).json<RefundResult>();
    const d = await detail(reg, r.transactionId);
    expect(d).toMatchObject({ kind: 'refund', originalTransactionId: sale.transactionId, reason: '作り間違い', approvedByName: '管理者', total: -500 });
    const log = db().select().from(auditLogs).where(eq(auditLogs.action, 'refund.created')).get()!;
    expect(log.after).toMatchObject({ reason: '作り間違い', difference: -500, originalReceiptNumber: sale.receiptNumber });
  });

  it('同じ冪等キーで再送しても1回分しか返金しない', async () => {
    const reg = await shop.openRegister(1);
    const sale = json(await reg.checkout(simpleSale(shop)));
    // 端末は通信の再送で「まったく同じ内容」を送る
    const payload = {
      returns: allReturns(await detail(reg, sale.transactionId)),
      idempotencyKey: 'refund-key-0001',
      registerSessionId: reg.sessionId,
      reason: 'お客様都合',
      approver,
      expectedDifference: -500,
    };
    const send = () => shop.t.app.inject({ method: 'POST', url: `/api/transactions/${sale.transactionId}/refund`, headers: reg.headers, payload });
    const a = await send();
    const b = await send();
    expect(b.json<RefundResult>().replayed).toBe(true);
    expect(b.json<RefundResult>().receiptNumber).toBe(a.json<RefundResult>().receiptNumber);
    expect(db().select().from(transactions).all()).toHaveLength(2);
  });

  it('返金の取引そのものは返金できない', async () => {
    const reg = await shop.openRegister(1);
    const sale = json(await reg.checkout(simpleSale(shop)));
    const r = (await refund(reg, sale.transactionId, { returns: allReturns(await detail(reg, sale.transactionId)) })).json<RefundResult>();
    const line = (await detail(reg, r.transactionId)).lines[0]!;
    expect((await quote(reg, r.transactionId, { returns: [{ lineId: line.lineId, quantity: 1 }] })).statusCode).toBe(400);
  });
});

describe('取引の検索', () => {
  it('当日の一覧・レシート番号・注文番号・金額で探せる', async () => {
    const reg = await shop.openRegister(1);
    const a = json(await reg.checkout(simpleSale(shop))); // 500
    json(await reg.checkout({ diningOption: 'eat_in', lines: [{ productId: shop.ids.beer.id, quantity: 1 }], payment: { method: 'paypay' }, expectedTotal: 600 }));
    const search = async (qs: string) =>
      (await shop.t.app.inject({ method: 'GET', url: `/api/transactions?${qs}`, headers: reg.headers })).json<{ transactions: TransactionSummary[] }>().transactions;

    expect((await search('')).map((t) => t.total)).toEqual([600, 500]); // 新しい順
    expect((await search(`receiptNumber=${a.receiptNumber.slice(-4)}`)).map((t) => t.id)).toEqual([a.transactionId]);
    expect((await search('orderNumber=100')).map((t) => t.id)).toEqual([a.transactionId]);
    expect((await search('amountMin=550')).map((t) => t.total)).toEqual([600]);
    expect((await search('')).every((t) => t.refundable)).toBe(true);

    // 返金するとその取引も一覧に出て、元の取引は返金済みになる
    await refund(reg, a.transactionId, { returns: allReturns(await detail(reg, a.transactionId)) });
    const list = await search('orderNumber=100');
    expect(list.map((t) => [t.kind, t.total])).toEqual([
      ['refund', -500],
      ['sale', 500],
    ]);
    expect(list.find((t) => t.kind === 'sale')!.refundable).toBe(false);
    expect((await detail(reg, a.transactionId)).related.map((t) => t.kind)).toEqual(['refund']);
  });

  it('過去の営業日の取引も日時の範囲で探せる', async () => {
    const reg = await shop.openRegister(1);
    const a = json(await reg.checkout(simpleSale(shop)));
    const yesterday = Date.now() - 24 * 60 * 60 * 1000;
    db().update(transactions).set({ createdAt: yesterday }).where(eq(transactions.id, a.transactionId)).run();
    const res = await shop.t.app.inject({
      method: 'GET',
      url: `/api/transactions?from=${yesterday - 1000}&to=${yesterday + 1000}`,
      headers: reg.headers,
    });
    expect(res.json<{ transactions: TransactionSummary[] }>().transactions.map((t) => t.id)).toEqual([a.transactionId]);
  });
});

describe('返金のレシート', () => {
  it('【返金】・元のレシート番号・返品・ご返金を載せる', async () => {
    const reg = await shop.openRegister(1);
    const sale = json(await reg.checkout(simpleSale(shop)));
    const r = (await refund(reg, sale.transactionId, { returns: allReturns(await detail(reg, sale.transactionId)) })).json<RefundResult>();
    const { text } = (
      await shop.t.app.inject({ method: 'GET', url: `/api/transactions/${r.transactionId}/receipt`, headers: reg.headers })
    ).json<{ text: string }>();
    for (const s of ['【返金】', `元のレシート番号`, sale.receiptNumber, '返品 バーガーセット', '-¥500', 'ご返金', 'ご返金方法', '現金', '注文番号']) {
      expect(text, s).toContain(s);
    }
    expect(text).not.toContain('お預り');
  });
});

