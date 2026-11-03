import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEVICE_TOKEN_HEADER, STAFF_SESSION_HEADER } from '@pos/shared';
import { ADMIN, createTestApp, STAFF, type TestApp } from './helpers.js';

let t: TestApp;
beforeEach(async () => {
  t = await createTestApp();
});
afterEach(async () => {
  await t.close();
});

describe('端末ペアリング', () => {
  it('管理者が発行したコードで端末を登録でき、役割が固定される', async () => {
    const { token, device } = await t.pairDevice('kitchen', 'キッチン1');
    expect(token).toBeTruthy();
    const me = await t.app.inject({
      method: 'GET',
      url: '/api/devices/me',
      headers: { [DEVICE_TOKEN_HEADER]: token },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toEqual({ device: { id: device.id, name: 'キッチン1', role: 'kitchen' } });
  });

  it('ペアリングコードは1回しか使えない', async () => {
    const adminToken = await t.adminLogin();
    const { code } = (
      await t.app.inject({
        method: 'POST',
        url: '/api/admin/pairing-codes',
        headers: { [STAFF_SESSION_HEADER]: adminToken },
        payload: { role: 'pickup' },
      })
    ).json<{ code: string }>();
    const first = await t.app.inject({ method: 'POST', url: '/api/devices/pair', payload: { code, name: 'A' } });
    const second = await t.app.inject({ method: 'POST', url: '/api/devices/pair', payload: { code, name: 'B' } });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(400);
  });

  it('有効期限切れのコードは使えない', async () => {
    const { code } = t.auth.createPairingCode('register', 1, Date.now() - 11 * 60 * 1000);
    const res = await t.app.inject({ method: 'POST', url: '/api/devices/pair', payload: { code, name: 'A' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_pairing_code');
  });

  it('未登録の端末トークンは拒否される', async () => {
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/devices/me',
      headers: { [DEVICE_TOKEN_HEADER]: 'bogus' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('無効化した端末は操作できなくなる', async () => {
    const { token, device } = await t.pairDevice('register');
    const adminToken = await t.adminLogin();
    const patch = await t.app.inject({
      method: 'PATCH',
      url: `/api/admin/devices/${device.id}`,
      headers: { [STAFF_SESSION_HEADER]: adminToken },
      payload: { enabled: false },
    });
    expect(patch.statusCode).toBe(200);
    const me = await t.app.inject({
      method: 'GET',
      url: '/api/devices/me',
      headers: { [DEVICE_TOKEN_HEADER]: token },
    });
    expect(me.statusCode).toBe(401);
  });

  it('連続して失敗すると一時的に拒否される', async () => {
    const attempts = [];
    for (let i = 0; i < 11; i++) {
      attempts.push(
        await t.app.inject({ method: 'POST', url: '/api/devices/pair', payload: { code: '000000', name: 'x' } }),
      );
    }
    expect(attempts.at(-2)!.statusCode).toBe(400);
    expect(attempts.at(-1)!.statusCode).toBe(429);
  });
});

describe('従業員ログイン（レジ）', () => {
  it('レジ端末で従業員コードとPINでログインできる', async () => {
    const { token } = await t.pairDevice('register');
    const login = await t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { [DEVICE_TOKEN_HEADER]: token },
      payload: { code: STAFF.code, pin: STAFF.pin },
    });
    expect(login.statusCode).toBe(200);
    const session = login.json<{ token: string; employee: { name: string } }>();
    expect(session.employee.name).toBe('スタッフ');

    const me = await t.app.inject({
      method: 'GET',
      url: '/api/auth/session',
      headers: { [DEVICE_TOKEN_HEADER]: token, [STAFF_SESSION_HEADER]: session.token },
    });
    expect(me.statusCode).toBe(200);
  });

  it('PINが違えば 401', async () => {
    const { token } = await t.pairDevice('register');
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { [DEVICE_TOKEN_HEADER]: token },
      payload: { code: STAFF.code, pin: '9999' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('レジ以外の端末ではログインできない', async () => {
    const { token } = await t.pairDevice('kitchen');
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { [DEVICE_TOKEN_HEADER]: token },
      payload: { code: STAFF.code, pin: STAFF.pin },
    });
    expect(res.statusCode).toBe(403);
  });

  it('セッションは発行した端末でしか使えない', async () => {
    const a = await t.pairDevice('register', 'A');
    const b = await t.pairDevice('register', 'B');
    const { token: session } = (
      await t.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { [DEVICE_TOKEN_HEADER]: a.token },
        payload: { code: STAFF.code, pin: STAFF.pin },
      })
    ).json<{ token: string }>();
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/auth/session',
      headers: { [DEVICE_TOKEN_HEADER]: b.token, [STAFF_SESSION_HEADER]: session },
    });
    expect(res.statusCode).toBe(401);
  });

  it('ログアウト後はセッションが使えない', async () => {
    const { token } = await t.pairDevice('register');
    const { token: session } = (
      await t.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { [DEVICE_TOKEN_HEADER]: token },
        payload: { code: STAFF.code, pin: STAFF.pin },
      })
    ).json<{ token: string }>();
    const headers = { [DEVICE_TOKEN_HEADER]: token, [STAFF_SESSION_HEADER]: session };
    await t.app.inject({ method: 'POST', url: '/api/auth/logout', headers });
    const res = await t.app.inject({ method: 'GET', url: '/api/auth/session', headers });
    expect(res.statusCode).toBe(401);
  });
});

describe('管理画面ログイン', () => {
  it('管理者はパスワードでログインできる', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/admin/login',
      payload: { code: ADMIN.code, password: ADMIN.password },
    });
    expect(res.statusCode).toBe(200);
  });

  it('管理者以外はログインできない', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/admin/login',
      payload: { code: STAFF.code, password: 'whatever-password' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('未ログインでは管理APIを呼べない', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/admin/devices' });
    expect(res.statusCode).toBe(401);
  });

  it('レジのスタッフセッションでは管理APIを呼べない', async () => {
    const { token } = await t.pairDevice('register');
    const { token: session } = (
      await t.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { [DEVICE_TOKEN_HEADER]: token },
        payload: { code: ADMIN.code, pin: ADMIN.pin },
      })
    ).json<{ token: string }>();
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/admin/devices',
      headers: { [STAFF_SESSION_HEADER]: session },
    });
    expect(res.statusCode).toBe(401);
  });
});
