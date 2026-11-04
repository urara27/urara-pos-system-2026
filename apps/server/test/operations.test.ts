import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { STAFF_SESSION_HEADER, type AuditLogEntry } from '@pos/shared';
import { businessDays } from '../src/db/schema.js';
import type { OperationsStatus } from '../src/modules/operations/service.js';
import { createShop, json, simpleSale, type Shop } from './shop.js';

let shop: Shop;
let adminToken: string;
beforeEach(async () => {
  shop = await createShop();
  adminToken = await shop.t.adminLogin();
});
afterEach(async () => {
  await shop.close();
});

const admin = (method: 'GET' | 'POST', url: string) =>
  shop.t.app.inject({ method, url, headers: { [STAFF_SESSION_HEADER]: adminToken } });
const status = async () => (await admin('GET', '/api/admin/operations')).json<OperationsStatus>();
const closeRegister = (reg: Awaited<ReturnType<Shop['openRegister']>>) =>
  shop.t.app.inject({ method: 'POST', url: `/api/register/sessions/${reg.sessionId}/close`, headers: reg.headers, payload: { countedCash: 10500 } });

describe('閉店操作', () => {
  it('開設中のレジがあれば閉店できない', async () => {
    const reg = await shop.openRegister(1);
    await reg.checkout(simpleSale(shop));
    const res = await admin('POST', '/api/admin/business-day/close');
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toContain('レジ1');
    expect((await status()).openRegisters.map((r) => r.registerName)).toEqual(['レジ1']);
  });

  it('全レジを閉設すると閉店でき、営業日を閉じてバックアップを取る', async () => {
    const reg = await shop.openRegister(1);
    const sale = json(await reg.checkout(simpleSale(shop)));
    await closeRegister(reg);

    const res = await admin('POST', '/api/admin/business-day/close');
    expect(res.statusCode).toBe(200);
    const { date, backup } = res.json<{ date: string; backup: { name: string } }>();
    expect(backup.name).toMatch(new RegExp(`^pos-STORE01-${date}-\\d{8}-\\d{6}\\.sqlite$`));

    const s = await status();
    expect(s.current).toMatchObject({ date, status: 'closed', closedBy: 'manual', closedByName: '管理者' });
    expect(s.backups.map((b) => b.name)).toEqual([backup.name]);

    // バックアップは単体で開ける完全な DB で、閉店時点の取引を含む
    const copy = new Database(path.join(shop.t.backupDir, backup.name), { readonly: true });
    try {
      const row = copy.prepare('select receipt_number from transactions').get() as { receipt_number: string };
      expect(row.receipt_number).toBe(sale.receiptNumber);
      expect(copy.pragma('integrity_check', { simple: true })).toBe('ok');
    } finally {
      copy.close();
    }
  });

  it('閉店後は同じ営業日に会計・開設できず、再開すれば戻る', async () => {
    const reg = await shop.openRegister(1);
    await closeRegister(reg);
    await admin('POST', '/api/admin/business-day/close');
    expect((await admin('POST', '/api/admin/business-day/close')).statusCode).toBe(409);
    await expect(shop.openRegister(3)).rejects.toThrow('閉店');

    expect((await admin('POST', '/api/admin/business-day/reopen')).statusCode).toBe(200);
    const reg3 = await shop.openRegister(3);
    expect((await reg3.checkout(simpleSale(shop))).statusCode).toBe(200);
  });

  it('閉店・バックアップは操作ログの「閉店・バックアップ」に残る', async () => {
    await admin('POST', '/api/admin/business-day/close');
    const logs = (await admin('GET', '/api/admin/audit-logs?category=operation')).json<{ logs: AuditLogEntry[] }>().logs;
    expect(logs.map((l) => l.actionLabel)).toEqual(['バックアップ', '閉店（営業日の終了）']);
  });
});

describe('自動閉店', () => {
  it('閉店し忘れた前の営業日は、切替時刻を過ぎたら自動で閉じてバックアップを取る', async () => {
    const reg = await shop.openRegister(1);
    await reg.checkout(simpleSale(shop));
    // 今日の営業日を「昨日」に書き換えて、閉店し忘れた状態にする
    const db = shop.t.database.db;
    const today = db.select().from(businessDays).get()!;
    db.update(businessDays).set({ date: '2000-01-01' }).where(eq(businessDays.id, today.id)).run();

    const closed = await shop.t.operations.autoClose();
    expect(closed).toEqual(['2000-01-01']);
    const day = db.select().from(businessDays).where(eq(businessDays.id, today.id)).get()!;
    expect(day).toMatchObject({ status: 'closed', closedBy: 'auto' });
    expect(fs.readdirSync(shop.t.backupDir).filter((n) => n.includes('2000-01-01'))).toHaveLength(1);

    // もう一度見回っても何もしない
    expect(await shop.t.operations.autoClose()).toEqual([]);
    // 今日の営業日はそのまま会計できる（新しい営業日が始まる）
    expect((await reg.checkout(simpleSale(shop))).statusCode).toBe(200);
  });
});

describe('バックアップの世代管理', () => {
  it('手動でも取れ、決めた世代数（テストでは3）を超えた古いものから消す', async () => {
    const names: string[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await admin('POST', '/api/admin/backups');
      expect(res.statusCode).toBe(200);
      names.push(res.json<{ name: string }>().name);
      // 同じ秒に取ると名前が同じになるので時刻をずらす
      await new Promise((r) => setTimeout(r, 1100));
    }
    const kept = (await status()).backups.map((b) => b.name);
    expect(kept).toHaveLength(3);
    expect(kept).toEqual(names.slice(-3).reverse());
    expect(fs.readdirSync(shop.t.backupDir).some((n) => n.endsWith('.part'))).toBe(false);
  }, 20_000);

  it('管理者以外は使えない', async () => {
    expect((await shop.t.app.inject({ method: 'POST', url: '/api/admin/backups' })).statusCode).toBe(401);
    expect((await shop.t.app.inject({ method: 'POST', url: '/api/admin/business-day/close' })).statusCode).toBe(401);
  });
});
