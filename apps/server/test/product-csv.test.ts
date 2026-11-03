import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseCsv, STAFF_SESSION_HEADER, toCsv, type Product } from '@pos/shared';
import { PRODUCT_CSV_HEADER } from '../src/modules/masters/product-csv.js';
import { createTestApp, type TestApp } from './helpers.js';

let t: TestApp;
let adminToken: string;

beforeEach(async () => {
  t = await createTestApp();
  adminToken = await t.adminLogin();
  const headers = { [STAFF_SESSION_HEADER]: adminToken };
  await t.app.inject({ method: 'POST', url: '/api/admin/categories', headers, payload: { name: 'バーガー' } });
  await t.app.inject({ method: 'POST', url: '/api/admin/categories', headers, payload: { name: 'ドリンク' } });
  await t.app.inject({
    method: 'POST',
    url: '/api/admin/option-groups',
    headers,
    payload: { name: 'サイズ', selection: 'single', options: [{ name: 'M', priceDelta: 0 }] },
  });
  await t.app.inject({
    method: 'POST',
    url: '/api/admin/option-groups',
    headers,
    payload: { name: 'トッピング', selection: 'multiple', options: [{ name: 'チーズ', priceDelta: 0 }] },
  });
});
afterEach(async () => {
  await t.close();
});

const importCsv = (csv: string) =>
  t.app.inject({
    method: 'POST',
    url: '/api/admin/products/import',
    headers: { [STAFF_SESSION_HEADER]: adminToken },
    payload: { csv },
  });

const listProducts = async () =>
  (
    await t.app.inject({ method: 'GET', url: '/api/admin/products', headers: { [STAFF_SESSION_HEADER]: adminToken } })
  ).json<{ products: Product[] }>().products;

const header = [...PRODUCT_CSV_HEADER];

describe('商品 CSV', () => {
  it('新規登録し、出力した CSV を編集して取り込むと更新される', async () => {
    const res = await importCsv(
      toCsv([
        header,
        ['', 'チーズバーガー', 'チーズ', '500', '', '1', 'バーガー', 'フード', 'サイズ|トッピング', '1', '#ff0000', '0', '1'],
        ['', 'お酒', '', '600', '', '0', 'ドリンク', 'drink', '', '', '', '', ''],
      ]),
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ created: 2, updated: 0 });

    const products = await listProducts();
    expect(products).toHaveLength(2);
    const sake = products.find((p) => p.name === 'お酒')!;
    expect(sake.reducedTaxEligible).toBe(false);
    expect(sake.station).toBe('drink');
    expect(products.find((p) => p.name === 'チーズバーガー')!.optionGroupIds).toHaveLength(2);

    // 出力 → 1行だけ値段を変えて取り込み
    const exported = await t.app.inject({
      method: 'GET',
      url: '/api/admin/products/export',
      headers: { [STAFF_SESSION_HEADER]: adminToken },
    });
    expect(exported.headers['content-type']).toContain('text/csv');
    const rows = parseCsv(exported.body);
    expect(rows[0]).toEqual(header);
    const burgerRow = rows.find((r) => r[1] === 'チーズバーガー')!;
    burgerRow[3] = '550';
    const again = await importCsv(toCsv(rows));
    expect(again.json()).toEqual({ created: 0, updated: 1 });
    expect((await listProducts()).find((p) => p.name === 'チーズバーガー')!.priceEatIn).toBe(550);
  });

  it('1行でも誤りがあれば何も取り込まず、行番号つきで理由を返す', async () => {
    const res = await importCsv(
      toCsv([
        header,
        ['', '正しい行', '', '500', '', '1', 'バーガー', 'フード', '', '', '', '', ''],
        ['', '価格が変', '', 'abc', '', '1', 'バーガー', 'フード', '', '', '', '', ''],
        ['', 'カテゴリ無し', '', '100', '', '1', 'サイド', 'フード', '', '', '', '', ''],
        ['999', 'id違い', '', '100', '', '1', 'バーガー', 'フード', '', '', '', '', ''],
      ]),
    );
    expect(res.statusCode).toBe(400);
    const body = res.json<{ error: { code: string; rows: { row: number; message: string }[] } }>();
    expect(body.error.code).toBe('csv_invalid');
    expect(body.error.rows.map((r) => r.row)).toEqual([3, 4, 5]);
    expect(body.error.rows[1]!.message).toContain('サイド');
    expect(await listProducts()).toHaveLength(0);
  });

  it('見出し行が違えば拒否する', async () => {
    const res = await importCsv('name,price\nx,1\n');
    expect(res.statusCode).toBe(400);
  });
});
