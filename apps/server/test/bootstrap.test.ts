import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { bootstrap } from '../src/bootstrap.js';
import { loadConfig } from '../src/config.js';
import { openDatabase, type DatabaseHandle } from '../src/db/client.js';
import { employees, registers } from '../src/db/schema.js';
import { verifySecret } from '../src/lib/crypto.js';

const log = { info: () => undefined, warn: () => undefined, error: () => undefined } as never;
let h: DatabaseHandle;
beforeEach(() => {
  h = openDatabase(':memory:', path.resolve(import.meta.dirname, '../drizzle'));
});
afterEach(() => h.close());

const env = (extra: Record<string, string> = {}) =>
  loadConfig({ INITIAL_ADMIN_CODE: '1', INITIAL_ADMIN_PASSWORD: 'first-password', ...extra });

describe('初回起動', () => {
  it('従業員がいなければ環境変数の値で管理者を作り、レジ1・2を用意する', async () => {
    await bootstrap(h.db, env(), log);
    const admin = h.db.select().from(employees).get()!;
    expect(admin).toMatchObject({ code: '1', role: 'admin', enabled: true });
    expect(await verifySecret(admin.passwordHash!, 'first-password')).toBe(true);
    expect(h.db.select().from(registers).all().map((r) => r.name)).toEqual(['レジ1', 'レジ2']);
  });

  it('2回目以降の起動では、パスワードを変えた管理者を上書きしない', async () => {
    await bootstrap(h.db, env(), log);
    await bootstrap(h.db, env({ INITIAL_ADMIN_PASSWORD: 'other-password' }), log);
    const admin = h.db.select().from(employees).get()!;
    expect(await verifySecret(admin.passwordHash!, 'first-password')).toBe(true);
  });
});

describe('管理者パスワードの復旧', () => {
  it('ADMIN_PASSWORD_RESET=1 なら、その管理者のパスワードを設定し直して有効にする', async () => {
    await bootstrap(h.db, env(), log);
    h.db.update(employees).set({ enabled: false }).where(eq(employees.code, '1')).run();
    await bootstrap(h.db, env({ INITIAL_ADMIN_PASSWORD: 'new-password', ADMIN_PASSWORD_RESET: '1' }), log);
    const admin = h.db.select().from(employees).get()!;
    expect(admin.enabled).toBe(true);
    expect(await verifySecret(admin.passwordHash!, 'new-password')).toBe(true);
  });
});
