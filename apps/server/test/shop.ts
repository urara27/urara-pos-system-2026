import { randomUUID } from 'node:crypto';
import {
  DEVICE_TOKEN_HEADER,
  STAFF_SESSION_HEADER,
  type CheckoutRequest,
  type CheckoutResult,
  type OrderBoard,
} from '@pos/shared';
import { ADMIN, createTestApp, STAFF, type TestApp } from './helpers.js';

/**
 * 注文フローのテスト用の店。
 * - バーガー 500円（フード、セットドリンク付き: コーラ=ドリンク）
 * - ポテト 300円（フード、サイズ M+0 / L+100 必須）
 * - ビール 600円（ドリンク、軽減税率の対象外）
 * - てりやき 480円（売切）
 * - 持ち帰り価格が別のコーヒー 400 / 持ち帰り 380
 */
export async function createShop() {
  const t = await createTestApp();
  const adminToken = await t.adminLogin();
  const admin = async <T>(method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) => {
    const res = await t.app.inject({ method, url, headers: { [STAFF_SESSION_HEADER]: adminToken }, payload });
    if (res.statusCode >= 400) throw new Error(`${url}: ${res.body}`);
    return res.json<T>();
  };

  const food = await admin<{ id: number }>('POST', '/api/admin/categories', { name: 'フード' });
  const drink = await admin<{ id: number }>('POST', '/api/admin/categories', { name: 'ドリンク' });
  const setDrink = await admin<{ id: number; options: { id: number; name: string }[] }>('POST', '/api/admin/option-groups', {
    name: 'セットドリンク',
    selection: 'single',
    options: [
      { name: 'コーラ', priceDelta: 0, station: 'drink', isDefault: true },
      { name: 'ジンジャー', priceDelta: 50, station: 'drink' },
    ],
  });
  const size = await admin<{ id: number; options: { id: number; name: string }[] }>('POST', '/api/admin/option-groups', {
    name: 'サイズ',
    selection: 'single',
    options: [
      { name: 'M', priceDelta: 0, isDefault: true },
      { name: 'L', priceDelta: 100 },
    ],
  });
  const product = (body: object) => admin<{ id: number }>('POST', '/api/admin/products', body);
  const burger = await product({ name: 'バーガーセット', kitchenName: 'バーガー', priceEatIn: 500, categoryId: food.id, station: 'food', optionGroupIds: [setDrink.id] });
  const potato = await product({ name: 'ポテト', priceEatIn: 300, categoryId: food.id, station: 'food', optionGroupIds: [size.id] });
  const beer = await product({ name: 'ビール', priceEatIn: 600, reducedTaxEligible: false, categoryId: drink.id, station: 'drink' });
  const teriyaki = await product({ name: 'てりやき', priceEatIn: 480, categoryId: food.id, station: 'food', soldOut: true });
  const coffee = await product({ name: 'コーヒー', priceEatIn: 400, priceTakeOut: 380, categoryId: drink.id, station: 'drink' });
  const coupon = await admin<{ id: number }>('POST', '/api/admin/discounts', { name: '100円引', kind: 'amount', value: 100, scope: 'order' });
  const lineCoupon = await admin<{ id: number }>('POST', '/api/admin/discounts', { name: '1割引', kind: 'rate', value: 10, scope: 'line' });

  // レジ1・3 は自動採番、レジ2 は番号札
  await admin('POST', '/api/admin/registers', { number: 1, name: 'レジ1', numberingMode: 'auto' });
  await admin('POST', '/api/admin/registers', { number: 2, name: 'レジ2', numberingMode: 'ticket' });
  await admin('POST', '/api/admin/registers', { number: 3, name: 'レジ3', numberingMode: 'auto' });
  const registers = (await admin<{ registers: { id: number; number: number }[] }>('GET', '/api/admin/registers')).registers;

  /** レジ端末を登録し、ログインしてレジを開設する */
  const openRegister = async (registerNumber: number, employee: { code: string; pin: string } = STAFF) => {
    const device = await t.pairDevice('register', `レジ端末${registerNumber}`);
    const login = await t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { [DEVICE_TOKEN_HEADER]: device.token },
      payload: employee,
    });
    const headers = { [DEVICE_TOKEN_HEADER]: device.token, [STAFF_SESSION_HEADER]: login.json<{ token: string }>().token };
    const registerId = registers.find((r) => r.number === registerNumber)!.id;
    const opened = await t.app.inject({
      method: 'POST',
      url: '/api/register/sessions',
      headers,
      payload: { registerId, openingCash: 10000 },
    });
    if (opened.statusCode !== 200) throw new Error(opened.body);
    const sessionId = opened.json<{ sessionId: number }>().sessionId;

    const checkout = (body: Omit<CheckoutRequest, 'registerSessionId' | 'idempotencyKey'> & { idempotencyKey?: string }) =>
      t.app.inject({
        method: 'POST',
        url: '/api/transactions',
        headers,
        payload: { idempotencyKey: randomUUID(), registerSessionId: sessionId, ...body },
      });
    return { device, headers, sessionId, registerId, checkout };
  };

  const device = async (role: 'kitchen' | 'pickup' | 'customer') => {
    const d = await t.pairDevice(role, `${role}-端末`);
    const headers = { [DEVICE_TOKEN_HEADER]: d.token };
    const post = (url: string) => t.app.inject({ method: 'POST', url, headers });
    const board = async () => (await t.app.inject({ method: 'GET', url: '/api/orders/board', headers })).json<OrderBoard>();
    return { ...d, headers, post, board };
  };

  return {
    t,
    admin,
    ids: { food, drink, setDrink, size, burger, potato, beer, teriyaki, coffee, coupon, lineCoupon },
    registers,
    openRegister,
    device,
    close: () => t.close(),
  };
}

export type Shop = Awaited<ReturnType<typeof createShop>>;

/** バーガーセット（コーラ）1点を現金1000円で */
export function simpleSale(shop: Shop, extra: Partial<CheckoutRequest> = {}): Omit<CheckoutRequest, 'registerSessionId' | 'idempotencyKey'> {
  const cola = shop.ids.setDrink.options.find((o) => o.name === 'コーラ')!;
  return {
    diningOption: 'eat_in',
    lines: [{ productId: shop.ids.burger.id, optionIds: [cola.id], quantity: 1 }],
    payment: { method: 'cash', cashReceived: 1000 },
    expectedTotal: 500,
    ...extra,
  };
}

export const json = <T = CheckoutResult>(res: { json: <U>() => U }) => res.json<T>();
export { ADMIN, STAFF };
