import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { io as connect, type Socket } from 'socket.io-client';
import {
  DEVICE_TOKEN_HEADER,
  STAFF_SESSION_HEADER,
  type ClientToServerEvents,
  type DeviceRole,
  type ServerToClientEvents,
} from '@pos/shared';
import { buildApp } from '../src/app.js';
import { openDatabase } from '../src/db/client.js';
import { employees } from '../src/db/schema.js';
import { hashSecret } from '../src/lib/crypto.js';

const migrationsDir = path.resolve(import.meta.dirname, '../drizzle');

export const ADMIN = { code: '1', password: 'admin-password', pin: '0000' };
export const STAFF = { code: '101', pin: '1234' };

/** テスト用: インメモリ DB に管理者とスタッフを入れたアプリを作る */
export async function createTestApp() {
  const database = openDatabase(':memory:', migrationsDir);
  database.db
    .insert(employees)
    .values([
      {
        code: ADMIN.code,
        name: '管理者',
        role: 'admin',
        canManualDiscount: true,
        pinHash: await hashSecret(ADMIN.pin),
        passwordHash: await hashSecret(ADMIN.password),
      },
      { code: STAFF.code, name: 'スタッフ', role: 'staff', pinHash: await hashSecret(STAFF.pin) },
    ])
    .run();
  const built = await buildApp({ db: database.db });
  const { app } = built;

  const adminLogin = async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/login',
      payload: { code: ADMIN.code, password: ADMIN.password },
    });
    return res.json<{ token: string }>().token;
  };

  const pairDevice = async (role: DeviceRole, name = `${role}-1`) => {
    const adminToken = await adminLogin();
    const codeRes = await app.inject({
      method: 'POST',
      url: '/api/admin/pairing-codes',
      headers: { [STAFF_SESSION_HEADER]: adminToken },
      payload: { role },
    });
    const { code } = codeRes.json<{ code: string }>();
    const pairRes = await app.inject({ method: 'POST', url: '/api/devices/pair', payload: { code, name } });
    return pairRes.json<{ token: string; device: { id: number } }>();
  };

  const close = async () => {
    await app.close();
    database.close();
  };

  return { ...built, database, adminLogin, pairDevice, close, deviceHeader: DEVICE_TOKEN_HEADER };
}

export type TestApp = Awaited<ReturnType<typeof createTestApp>>;

export async function listen(app: TestApp['app']) {
  await app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = app.server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

export type ClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

export function connectSocket(baseUrl: string, auth: Record<string, string>): ClientSocket {
  return connect(baseUrl, { auth, transports: ['websocket'], reconnection: false, forceNew: true });
}

export function waitFor<T>(socket: ClientSocket, event: keyof ServerToClientEvents, timeoutMs = 3000) {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeoutMs);
    socket.once(event as 'system.ping', (payload: unknown) => {
      clearTimeout(timer);
      resolve(payload as T);
    });
  });
}
