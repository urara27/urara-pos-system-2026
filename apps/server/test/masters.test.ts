import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  DEVICE_TOKEN_HEADER,
  STAFF_SESSION_HEADER,
  type Catalog,
  type Category,
  type EventEnvelope,
  type CatalogUpdatedPayload,
  type OptionGroup,
  type Product,
} from '@pos/shared';
import { auditLogs } from '../src/db/schema.js';
import { connectSocket, createTestApp, listen, waitFor, type TestApp } from './helpers.js';

let t: TestApp;
let adminToken: string;

beforeEach(async () => {
  t = await createTestApp();
  adminToken = await t.adminLogin();
});
afterEach(async () => {
  await t.close();
});

async function admin<T = unknown>(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) {
  const res = await t.app.inject({
    method,
    url,
    headers: { [STAFF_SESSION_HEADER]: adminToken },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
  return { status: res.statusCode, body: res.json<T>() };
}

async function seedMenu() {
  const burgers = (await admin<Category>('POST', '/api/admin/categories', { name: 'バーガー', sortOrder: 1 })).body;
  const drinks = (await admin<Category>('POST', '/api/admin/categories', { name: 'ドリンク', sortOrder: 2 })).body;
  const size = (
    await admin<OptionGroup>('POST', '/api/admin/option-groups', {
      name: 'サイズ',
      selection: 'single',
      options: [
        { name: 'M', priceDelta: 0, isDefault: true },
        { name: 'L', priceDelta: 50 },
      ],
    })
  ).body;
  const setDrink = (
    await admin<OptionGroup>('POST', '/api/admin/option-groups', {
      name: 'セットドリンク',
      selection: 'single',
      options: [
        { name: 'コーラ', priceDelta: 0, station: 'drink', isDefault: true },
        { name: 'ジンジャーエール', priceDelta: 0, station: 'drink' },
      ],
    })
  ).body;
  const burger = (
    await admin<Product>('POST', '/api/admin/products', {
      name: 'チーズバーガー',
      priceEatIn: 500,
      categoryId: burgers.id,
      station: 'food',
      optionGroupIds: [setDrink.id],
    })
  ).body;
  const cola = (
    await admin<Product>('POST', '/api/admin/products', {
      name: 'コーラ',
      priceEatIn: 300,
      categoryId: drinks.id,
      station: 'drink',
      optionGroupIds: [size.id],
    })
  ).body;
  return { burgers, drinks, size, setDrink, burger, cola };
}

describe('マスタ管理', () => {
  it('登録した商品とオプションがレジのカタログに出る', async () => {
    const m = await seedMenu();
    const { token } = await t.pairDevice('register');
    const res = await t.app.inject({ method: 'GET', url: '/api/catalog', headers: { [DEVICE_TOKEN_HEADER]: token } });
    expect(res.statusCode).toBe(200);
    const catalog = res.json<Catalog>();
    expect(catalog.categories.map((c) => c.name)).toEqual(['バーガー', 'ドリンク']);
    expect(catalog.products.find((p) => p.id === m.burger.id)?.optionGroupIds).toEqual([m.setDrink.id]);
    const setDrink = catalog.optionGroups.find((g) => g.id === m.setDrink.id)!;
    expect(setDrink.options.map((o) => [o.name, o.station])).toEqual([
      ['コーラ', 'drink'],
      ['ジンジャーエール', 'drink'],
    ]);
  });

  it('無効な商品・カテゴリ・選択肢はカタログに出ず、売切は出る', async () => {
    const m = await seedMenu();
    await admin('PUT', `/api/admin/categories/${m.drinks.id}`, { name: 'ドリンク', sortOrder: 2, enabled: false });
    await admin('POST', `/api/admin/products/${m.burger.id}/sold-out`, { soldOut: true });
    const opts = m.setDrink.options.map((o) => ({ ...o, enabled: o.name !== 'ジンジャーエール' }));
    await admin('PUT', `/api/admin/option-groups/${m.setDrink.id}`, { ...m.setDrink, options: opts });

    const { token } = await t.pairDevice('register');
    const res = (
      await t.app.inject({ method: 'GET', url: '/api/catalog', headers: { [DEVICE_TOKEN_HEADER]: token } })
    ).json<Catalog>();
    expect(res.products.map((p) => p.name)).toEqual(['チーズバーガー']);
    expect(res.products[0]!.soldOut).toBe(true);
    expect(res.optionGroups.find((g) => g.id === m.setDrink.id)!.options.map((o) => o.name)).toEqual(['コーラ']);
  });

  it('レジ以外の端末・未登録端末はカタログを取れない', async () => {
    const { token } = await t.pairDevice('kitchen');
    const kitchen = await t.app.inject({ method: 'GET', url: '/api/catalog', headers: { [DEVICE_TOKEN_HEADER]: token } });
    expect(kitchen.statusCode).toBe(403);
    expect((await t.app.inject({ method: 'GET', url: '/api/catalog' })).statusCode).toBe(401);
  });

  it('存在しないカテゴリの商品は登録できない', async () => {
    const res = await admin('POST', '/api/admin/products', {
      name: 'x',
      priceEatIn: 100,
      categoryId: 999,
      station: 'food',
    });
    expect(res.status).toBe(400);
  });

  it('金額は0円以上の整数のみ', async () => {
    const { burgers } = await seedMenu();
    for (const priceEatIn of [-1, 100.5]) {
      const res = await admin('POST', '/api/admin/products', { name: 'x', priceEatIn, categoryId: burgers.id, station: 'food' });
      expect(res.status).toBe(400);
    }
  });

  it('カテゴリ名は重複できない', async () => {
    await admin('POST', '/api/admin/categories', { name: 'サイド' });
    expect((await admin('POST', '/api/admin/categories', { name: 'サイド' })).status).toBe(409);
  });

  it('オプションの選択肢は削除できない（無効化のみ）', async () => {
    const { size } = await seedMenu();
    const res = await admin('PUT', `/api/admin/option-groups/${size.id}`, { ...size, options: [size.options[0]] });
    expect(res.status).toBe(400);
  });

  it('「1つを必ず選ぶ」グループの既定は1つまで', async () => {
    const res = await admin('POST', '/api/admin/option-groups', {
      name: 'x',
      selection: 'single',
      options: [
        { name: 'a', priceDelta: 0, isDefault: true },
        { name: 'b', priceDelta: 0, isDefault: true },
      ],
    });
    expect(res.status).toBe(400);
  });

  it('価格変更は操作ログに残る', async () => {
    const { burger } = await seedMenu();
    await admin('PUT', `/api/admin/products/${burger.id}`, { ...burger, priceEatIn: 550 });
    const logs = t.database.db.select().from(auditLogs).where(eq(auditLogs.action, 'product.price_changed')).all();
    expect(logs).toHaveLength(1);
    expect(logs[0]!.before).toEqual({ priceEatIn: 500, priceTakeOut: null });
    expect(logs[0]!.after).toEqual({ priceEatIn: 550, priceTakeOut: null });
  });

  it('割引は率100%超・期間の逆転を拒否し、期間外はカタログに出ない', async () => {
    expect((await admin('POST', '/api/admin/discounts', { name: 'x', kind: 'rate', value: 101, scope: 'line' })).status).toBe(400);
    expect(
      (await admin('POST', '/api/admin/discounts', { name: 'x', kind: 'amount', value: 100, scope: 'order', validFrom: 2000, validTo: 1000 }))
        .status,
    ).toBe(400);
    await admin('POST', '/api/admin/discounts', { name: '有効', kind: 'rate', value: 10, scope: 'order' });
    await admin('POST', '/api/admin/discounts', { name: '期限切れ', kind: 'amount', value: 50, scope: 'line', validTo: Date.now() - 1000 });
    const { token } = await t.pairDevice('register');
    const catalog = (
      await t.app.inject({ method: 'GET', url: '/api/catalog', headers: { [DEVICE_TOKEN_HEADER]: token } })
    ).json<Catalog>();
    expect(catalog.discounts.map((d) => d.name)).toEqual(['有効']);
  });

  it('マスタを変えるとレジへ catalog.updated が届く', async () => {
    const baseUrl = await listen(t.app);
    const { token } = await t.pairDevice('register');
    const socket = connectSocket(baseUrl, { deviceToken: token });
    try {
      await waitFor(socket, 'system.hello');
      const event = waitFor<EventEnvelope<CatalogUpdatedPayload>>(socket, 'catalog.updated');
      await admin('POST', '/api/admin/categories', { name: 'サイド' });
      expect((await event).payload.reason).toBe('categories');
    } finally {
      socket.disconnect();
    }
  });
});

describe('従業員マスタ', () => {
  it('登録した従業員はレジでログインでき、PINは返さない', async () => {
    const res = await admin<Record<string, unknown>>('POST', '/api/admin/employees', {
      code: '201',
      name: '山田',
      role: 'manager',
      pin: '2468',
    });
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('pin');
    expect(res.body).not.toHaveProperty('pinHash');
    const { token } = await t.pairDevice('register');
    const login = await t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { [DEVICE_TOKEN_HEADER]: token },
      payload: { code: '201', pin: '2468' },
    });
    expect(login.statusCode).toBe(200);
  });

  it('従業員コードは重複できない', async () => {
    const res = await admin('POST', '/api/admin/employees', { code: '101', name: 'x', role: 'staff', pin: '1111' });
    expect(res.status).toBe(409);
  });

  it('管理者にはパスワードが必要', async () => {
    const res = await admin('POST', '/api/admin/employees', { code: '300', name: 'x', role: 'admin', pin: '1111' });
    expect(res.status).toBe(400);
  });

  it('ログインできる管理者が0人になる変更は拒否する', async () => {
    const list = (await admin<{ employees: { id: number; code: string }[] }>('GET', '/api/admin/employees')).body;
    const me = list.employees.find((e) => e.code === '1')!;
    const res = await admin('PUT', `/api/admin/employees/${me.id}`, {
      code: '1',
      name: '管理者',
      role: 'admin',
      enabled: false,
    });
    expect(res.status).toBe(400);
  });

  it('PIN を空で更新しても既存の PIN は変わらない', async () => {
    const list = (await admin<{ employees: { id: number; code: string }[] }>('GET', '/api/admin/employees')).body;
    const staff = list.employees.find((e) => e.code === '101')!;
    await admin('PUT', `/api/admin/employees/${staff.id}`, { code: '101', name: '改名', role: 'staff', pin: '' });
    const { token } = await t.pairDevice('register');
    const login = await t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { [DEVICE_TOKEN_HEADER]: token },
      payload: { code: '101', pin: '1234' },
    });
    expect(login.statusCode).toBe(200);
    expect(login.json().employee.name).toBe('改名');
  });
});

describe('店舗・運用設定とレジ', () => {
  async function current() {
    return (await admin<{ settings: Record<string, unknown> }>('GET', '/api/admin/settings')).body.settings;
  }

  it('番号札と自動採番の範囲が重なる設定は保存できない', async () => {
    const s = await current();
    const res = await admin<{ error: { message: string } }>('PUT', '/api/admin/settings', {
      ...s,
      ticketNumberMax: 150,
    });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('重なっています');
  });

  it('範囲が重ならなければ保存でき、変更点が操作ログに残る', async () => {
    const s = await current();
    const res = await admin('PUT', '/api/admin/settings', {
      ...s,
      storeName: 'テスト食堂',
      ticketNumberMax: 199,
      autoNumberMin: 200,
    });
    expect(res.status).toBe(200);
    expect((await current()).autoNumberMin).toBe(200);
    const log = t.database.db.select().from(auditLogs).where(eq(auditLogs.action, 'settings.updated')).get()!;
    expect(log.after).toEqual({ storeName: 'テスト食堂', ticketNumberMax: 199, autoNumberMin: 200 });
  });

  it('登録番号は T + 13桁', async () => {
    const s = await current();
    expect((await admin('PUT', '/api/admin/settings', { ...s, invoiceRegistrationNumber: 'T123' })).status).toBe(400);
    expect(
      (await admin('PUT', '/api/admin/settings', { ...s, invoiceRegistrationNumber: 'T1234567890123' })).status,
    ).toBe(200);
  });

  it('レジ番号は重複できず、発行モードをレジごとに設定できる', async () => {
    const created = await admin<{ id: number }>('POST', '/api/admin/registers', {
      number: 3,
      name: 'レジ3',
      numberingMode: 'ticket',
    });
    expect(created.status).toBe(200);
    expect((await admin('POST', '/api/admin/registers', { number: 3, name: 'x', numberingMode: 'auto' })).status).toBe(409);
  });
});
