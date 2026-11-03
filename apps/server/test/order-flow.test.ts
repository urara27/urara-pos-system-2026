import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { EventEnvelope, OrderUpdatedPayload, OrderView, RegisterSessionSummary } from '@pos/shared';
import {
  auditLogs,
  orders as ordersTable,
  transactionDiscounts,
  transactionLines,
  transactions,
  transactionTaxSummaries,
} from '../src/db/schema.js';
import { connectSocket, listen, waitFor } from './helpers.js';
import { ADMIN, createShop, json, simpleSale, type Shop } from './shop.js';

let shop: Shop;
beforeEach(async () => {
  shop = await createShop();
});
afterEach(async () => {
  await shop.close();
});

const db = () => shop.t.database.db;
const cola = () => shop.ids.setDrink.options.find((o) => o.name === 'コーラ')!;
const ginger = () => shop.ids.setDrink.options.find((o) => o.name === 'ジンジャー')!;
const sizeL = () => shop.ids.size.options.find((o) => o.name === 'L')!;
const sizeM = () => shop.ids.size.options.find((o) => o.name === 'M')!;

describe('会計確定', () => {
  it('現金会計で販売データ・注文・番号を記録し、釣銭を返す', async () => {
    const reg = await shop.openRegister(1);
    const res = await reg.checkout(simpleSale(shop));
    expect(res.statusCode).toBe(200);
    const r = json(res);
    expect(r.orderNumber).toBe(100);
    expect(r.receiptNumber).toMatch(/^\d{8}-1-0001$/);
    expect(r.change).toBe(500);
    expect(r.replayed).toBe(false);

    const tx = db().select().from(transactions).where(eq(transactions.id, r.transactionId)).get()!;
    expect(tx.total).toBe(500);
    expect(tx.paymentMethod).toBe('cash');
    const tax = db().select().from(transactionTaxSummaries).where(eq(transactionTaxSummaries.transactionId, tx.id)).all();
    expect(tax).toEqual([{ transactionId: tx.id, taxRate: 10, taxableAmount: 500, taxAmount: 45 }]);
  });

  it('セットのドリンクがあればドリンクのステーションも未完了になる', async () => {
    const reg = await shop.openRegister(1);
    const kitchen = await shop.device('kitchen');
    await reg.checkout(simpleSale(shop));
    const [order] = (await kitchen.board()).active;
    expect(order!.stations.food).toEqual({ hasItems: true, completedAt: null });
    expect(order!.stations.drink).toEqual({ hasItems: true, completedAt: null });

    // ポテトだけならドリンクは最初から完了扱い
    await reg.checkout({
      diningOption: 'eat_in',
      lines: [{ productId: shop.ids.potato.id, optionIds: [sizeM().id], quantity: 1 }],
      payment: { method: 'paypay' },
      expectedTotal: 300,
    });
    const potatoOrder = (await kitchen.board()).active[1]!;
    expect(potatoOrder.stations.drink.hasItems).toBe(false);
  });

  it('持ち帰りは持ち帰り価格と8%（軽減対象）で計算し、酒類は10%', async () => {
    const reg = await shop.openRegister(1);
    const res = await reg.checkout({
      diningOption: 'take_out',
      lines: [
        { productId: shop.ids.coffee.id, quantity: 2 }, // 380 × 2 = 760（8%）
        { productId: shop.ids.beer.id, quantity: 1 }, // 600（10%）
      ],
      payment: { method: 'paypay' },
      expectedTotal: 1360,
    });
    expect(res.statusCode).toBe(200);
    const id = json(res).transactionId;
    const tax = db().select().from(transactionTaxSummaries).where(eq(transactionTaxSummaries.transactionId, id)).all();
    expect(tax.map((x) => [x.taxRate, x.taxableAmount, x.taxAmount]).sort((a, b) => b[0]! - a[0]!)).toEqual([
      [10, 600, 54],
      [8, 760, 56],
    ]);
  });

  it('明細割引・会計割引を適用し、按分額と操作ログを記録する', async () => {
    const reg = await shop.openRegister(1);
    const res = await reg.checkout({
      diningOption: 'eat_in',
      lines: [
        { productId: shop.ids.burger.id, optionIds: [ginger().id], quantity: 1, discounts: [{ discountId: shop.ids.lineCoupon.id }] }, // 550 → 1割引 55 → 495
        { productId: shop.ids.potato.id, optionIds: [sizeL().id], quantity: 1 }, // 400
      ],
      orderDiscounts: [{ discountId: shop.ids.coupon.id }], // 895 → 100円引 → 795
      payment: { method: 'cash', cashReceived: 795 },
      expectedTotal: 795,
    });
    expect(res.statusCode).toBe(200);
    const id = json(res).transactionId;
    const lines = db().select().from(transactionLines).where(eq(transactionLines.transactionId, id)).all();
    expect(lines.map((l) => [l.grossAmount, l.lineDiscountAmount, l.allocatedOrderDiscount, l.netAmount])).toEqual([
      [550, 55, 56, 439], // 100 × 495/895 = 55.3 → 55、端数1は大きい方へ → 56
      [400, 0, 44, 356],
    ]);
    const discounts = db().select().from(transactionDiscounts).where(eq(transactionDiscounts.transactionId, id)).all();
    expect(discounts.map((d) => [d.scope, d.amount])).toEqual([
      ['line', 55],
      ['order', 100],
    ]);
    expect(db().select().from(auditLogs).where(eq(auditLogs.action, 'discount.applied')).all()).toHaveLength(1);
  });

  it('同じ冪等キーで再送しても1回分しか登録しない', async () => {
    const reg = await shop.openRegister(1);
    const body = { ...simpleSale(shop), idempotencyKey: 'fixed-key-0001' };
    const first = json(await reg.checkout(body));
    const second = json(await reg.checkout(body));
    expect(second.replayed).toBe(true);
    expect(second.orderNumber).toBe(first.orderNumber);
    expect(second.receiptNumber).toBe(first.receiptNumber);
    expect(db().select().from(transactions).all()).toHaveLength(1);
  });

  it('表示していた合計とサーバーの計算が違えば確定しない', async () => {
    const reg = await shop.openRegister(1);
    const res = await reg.checkout(simpleSale(shop, { expectedTotal: 480 }));
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('total_mismatch');
    expect(db().select().from(transactions).all()).toHaveLength(0);
  });

  it('売切・必須オプション未選択・他商品のオプション・預り金不足は拒否する', async () => {
    const reg = await shop.openRegister(1);
    const cases = [
      { lines: [{ productId: shop.ids.teriyaki.id, quantity: 1 }], expectedTotal: 480 },
      { lines: [{ productId: shop.ids.potato.id, quantity: 1 }], expectedTotal: 300 },
      { lines: [{ productId: shop.ids.potato.id, optionIds: [sizeM().id, sizeL().id], quantity: 1 }], expectedTotal: 400 },
      { lines: [{ productId: shop.ids.beer.id, optionIds: [sizeL().id], quantity: 1 }], expectedTotal: 700 },
    ];
    for (const c of cases) {
      const res = await reg.checkout({ diningOption: 'eat_in', payment: { method: 'paypay' }, ...c });
      expect(res.statusCode, JSON.stringify(c)).toBe(400);
    }
    const short = await reg.checkout(simpleSale(shop, { payment: { method: 'cash', cashReceived: 499 } }));
    expect(short.statusCode).toBe(400);
    expect(db().select().from(transactions).all()).toHaveLength(0);
  });

  it('手入力の値引きは権限のある従業員だけ', async () => {
    const manual = { orderDiscounts: [{ manual: { kind: 'amount' as const, value: 50 } }], expectedTotal: 450 };
    const staff = await shop.openRegister(1);
    expect((await staff.checkout(simpleSale(shop, manual))).statusCode).toBe(403);
    const admin = await shop.openRegister(3, { code: ADMIN.code, pin: ADMIN.pin });
    expect((await admin.checkout(simpleSale(shop, manual))).statusCode).toBe(200);
  });

  it('会計の通知がキッチンに届く', async () => {
    const baseUrl = await listen(shop.t.app);
    const reg = await shop.openRegister(1);
    const kitchen = await shop.device('kitchen');
    const socket = connectSocket(baseUrl, { deviceToken: kitchen.token });
    try {
      await waitFor(socket, 'system.hello');
      const event = waitFor<EventEnvelope<OrderUpdatedPayload>>(socket, 'order.updated');
      await reg.checkout(simpleSale(shop));
      const { payload } = await event;
      expect(payload.change).toBe('created');
      expect(payload.order.orderNumber).toBe(100);
      expect(payload.order.items[0]!.options.map((o) => [o.name, o.station])).toEqual([['コーラ', 'drink']]);
    } finally {
      socket.disconnect();
    }
  });
});

describe('注文番号の採番', () => {
  async function setAutoRange(min: number, max: number) {
    const { settings } = await shop.admin<{ settings: Record<string, unknown> }>('GET', '/api/admin/settings');
    await shop.admin('PUT', '/api/admin/settings', { ...settings, autoNumberMin: min, autoNumberMax: max });
  }

  it('自動採番は使用中の番号を飛ばし、上限の次は下限に戻る', async () => {
    await setAutoRange(100, 102);
    const reg = await shop.openRegister(1);
    const pickup = await shop.device('pickup');
    const numbers: number[] = [];
    for (let i = 0; i < 3; i++) numbers.push(json(await reg.checkout(simpleSale(shop))).orderNumber);
    expect(numbers).toEqual([100, 101, 102]);

    // 全部使用中なら採番できない
    const full = await reg.checkout(simpleSale(shop));
    expect(full.statusCode).toBe(409);
    expect(full.json().error.code).toBe('no_order_number');

    // 101 を受け渡すと、102 の次（下限 100 は使用中）→ 101 が採られる
    const board = await pickup.board();
    await pickup.post(`/api/orders/${board.active[1]!.id}/handover`);
    expect(json(await reg.checkout(simpleSale(shop))).orderNumber).toBe(101);
  });

  it('番号札モードは範囲内・未使用の番号だけ受け付ける', async () => {
    const reg = await shop.openRegister(2);
    expect(json(await reg.checkout(simpleSale(shop, { ticketNumber: 7 }))).orderNumber).toBe(7);

    const inUse = await reg.checkout(simpleSale(shop, { ticketNumber: 7 }));
    expect(inUse.statusCode).toBe(409);
    expect(inUse.json().error.message).toContain('007');

    expect((await reg.checkout(simpleSale(shop, { ticketNumber: 150 }))).statusCode).toBe(400);
    expect((await reg.checkout(simpleSale(shop))).statusCode).toBe(400);
  });

  it('複数のレジから同時に会計しても注文番号・レシート番号が重複しない', async () => {
    const a = await shop.openRegister(1);
    const b = await shop.openRegister(3);
    const results = await Promise.all(
      Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? a : b).checkout(simpleSale(shop))),
    );
    expect(results.every((r) => r.statusCode === 200)).toBe(true);
    const bodies = results.map((r) => json(r));
    expect(new Set(bodies.map((r) => r.orderNumber)).size).toBe(40);
    expect(new Set(bodies.map((r) => r.receiptNumber)).size).toBe(40);
    // レジごとの連番は1から欠番なく振られる
    const seqOf = (reg: number) =>
      bodies
        .filter((r) => r.receiptNumber.split('-')[1] === String(reg))
        .map((r) => Number(r.receiptNumber.split('-')[2]))
        .sort((x, y) => x - y);
    expect(seqOf(1)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(seqOf(3)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it('自動採番と番号札の番号は混ざらない', async () => {
    const auto = await shop.openRegister(1);
    const ticket = await shop.openRegister(2);
    const n1 = json(await auto.checkout(simpleSale(shop))).orderNumber;
    const n2 = json(await ticket.checkout(simpleSale(shop, { ticketNumber: 1 }))).orderNumber;
    expect(n1).toBeGreaterThanOrEqual(100);
    expect(n2).toBe(1);
  });
});

describe('注文の状態遷移', () => {
  async function placeOrder() {
    const reg = await shop.openRegister(1);
    const pickup = await shop.device('pickup');
    const kitchen = await shop.device('kitchen');
    const { orderId } = json(await reg.checkout(simpleSale(shop)));
    const act = async (action: string) => {
      const res = await pickup.post(`/api/orders/${orderId}/${action}`);
      return { status: res.statusCode, body: res.json() as OrderView & { error?: { code: string } } };
    };
    return { reg, pickup, kitchen, orderId, act };
  }

  it('呼び出し → 呼び出し取消 → 呼び出し → 受け渡し', async () => {
    const { act } = await placeOrder();
    expect((await act('call')).body.status).toBe('calling');
    expect((await act('recall')).body.status).toBe('calling');
    expect((await act('uncall')).body.status).toBe('accepted');
    expect((await act('call')).body.status).toBe('calling');
    expect((await act('handover')).body.status).toBe('completed');
  });

  it('キッチンが未完了でも呼び出し・受け渡しできる', async () => {
    const { act } = await placeOrder();
    expect((await act('handover')).body.status).toBe('completed');
  });

  it('許されない遷移はサーバーで拒否する', async () => {
    const { act } = await placeOrder();
    expect((await act('uncall')).status).toBe(409);
    await act('handover');
    const res = await act('call');
    expect(res.status).toBe(409);
    expect(res.body.error!.code).toBe('invalid_transition');
  });

  it('受け渡し済みは時間内なら呼び出し中に戻せる', async () => {
    const { act } = await placeOrder();
    await act('handover');
    const res = await act('undo-handover');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('calling');
    expect(res.body.completedAt).toBeNull();
  });

  it('受け渡しから時間が経つと戻せない', async () => {
    const { orderId, pickup } = await placeOrder();
    // 受け渡し時刻を6分前にずらす（既定の取消可能時間は5分）
    await pickup.post(`/api/orders/${orderId}/handover`);
    db().update(ordersTable).set({ completedAt: Date.now() - 6 * 60 * 1000 }).where(eq(ordersTable.id, orderId)).run();
    const res = await pickup.post(`/api/orders/${orderId}/undo-handover`);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('undo_expired');
  });

  it('番号が別の注文で再利用されていたら戻せない', async () => {
    const reg = await shop.openRegister(2);
    const pickup = await shop.device('pickup');
    const first = json(await reg.checkout(simpleSale(shop, { ticketNumber: 5 })));
    await pickup.post(`/api/orders/${first.orderId}/handover`);
    json(await reg.checkout(simpleSale(shop, { ticketNumber: 5 })));
    const res = await pickup.post(`/api/orders/${first.orderId}/undo-handover`);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('number_reused');
  });

  it('ピックアップ以外の端末は呼び出しできない', async () => {
    const { kitchen, orderId } = await placeOrder();
    expect((await kitchen.post(`/api/orders/${orderId}/call`)).statusCode).toBe(403);
  });
});

describe('キッチン', () => {
  it('ステーションごとに完了・取消でき、「すべて」は全ステーションを完了にする', async () => {
    const reg = await shop.openRegister(1);
    const kitchen = await shop.device('kitchen');
    const { orderId } = json(await reg.checkout(simpleSale(shop)));

    const food = (await kitchen.post(`/api/orders/${orderId}/stations/food/complete`)).json<OrderView>();
    expect(food.stations.food.completedAt).not.toBeNull();
    expect(food.stations.drink.completedAt).toBeNull();

    const reopened = (await kitchen.post(`/api/orders/${orderId}/stations/food/reopen`)).json<OrderView>();
    expect(reopened.stations.food.completedAt).toBeNull();

    const all = (await kitchen.post(`/api/orders/${orderId}/stations/all/complete`)).json<OrderView>();
    expect(all.stations.food.completedAt).not.toBeNull();
    expect(all.stations.drink.completedAt).not.toBeNull();
    expect(all.status).toBe('accepted'); // 調理完了は注文の状態とは別
  });

  it('受け渡し済みの注文は操作できない', async () => {
    const reg = await shop.openRegister(1);
    const kitchen = await shop.device('kitchen');
    const pickup = await shop.device('pickup');
    const { orderId } = json(await reg.checkout(simpleSale(shop)));
    await pickup.post(`/api/orders/${orderId}/handover`);
    expect((await kitchen.post(`/api/orders/${orderId}/stations/food/complete`)).statusCode).toBe(409);
    const board = await kitchen.board();
    expect(board.active).toHaveLength(0);
    expect(board.recent.map((o) => o.id)).toEqual([orderId]);
  });

  it('キッチン以外の端末は調理完了にできない', async () => {
    const reg = await shop.openRegister(1);
    const pickup = await shop.device('pickup');
    const { orderId } = json(await reg.checkout(simpleSale(shop)));
    expect((await pickup.post(`/api/orders/${orderId}/stations/food/complete`)).statusCode).toBe(403);
  });
});

describe('レジの開設・閉設', () => {
  it('同じレジを別の端末で同時に開設できない', async () => {
    await shop.openRegister(1);
    await expect(shop.openRegister(1)).rejects.toThrow('別の端末で開設中');
  });

  it('閉設時に理論在高と過不足を計算する', async () => {
    const reg = await shop.openRegister(1);
    await reg.checkout(simpleSale(shop)); // 現金 500
    await reg.checkout(simpleSale(shop, { payment: { method: 'paypay' } })); // PayPay 500
    const res = await shop.t.app.inject({
      method: 'POST',
      url: `/api/register/sessions/${reg.sessionId}/close`,
      headers: reg.headers,
      payload: { countedCash: 10450 },
    });
    expect(res.statusCode).toBe(200);
    const s = res.json<RegisterSessionSummary>();
    expect(s.expectedCash).toBe(10500);
    expect(s.paypaySales).toBe(500);
    expect(s.cashDifference).toBe(-50);
    // 閉設後は会計できない
    expect((await reg.checkout(simpleSale(shop))).statusCode).toBe(409);
  });
});
