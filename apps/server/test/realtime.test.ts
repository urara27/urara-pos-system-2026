import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  STAFF_SESSION_HEADER,
  type EventEnvelope,
  type HelloPayload,
  type PingPayload,
  type PresencePayload,
} from '@pos/shared';
import { connectSocket, createTestApp, listen, waitFor, type ClientSocket, type TestApp } from './helpers.js';

let t: TestApp;
let baseUrl: string;
const sockets: ClientSocket[] = [];

beforeEach(async () => {
  t = await createTestApp();
  baseUrl = await listen(t.app);
});
afterEach(async () => {
  sockets.splice(0).forEach((s) => s.disconnect());
  await t.close();
});

function open(auth: Record<string, string>) {
  const socket = connectSocket(baseUrl, auth);
  sockets.push(socket);
  return socket;
}

describe('リアルタイム通信', () => {
  it('接続すると hello で自分の役割を受け取る', async () => {
    const { token, device } = await t.pairDevice('customer');
    const socket = open({ deviceToken: token });
    const hello = await waitFor<EventEnvelope<HelloPayload>>(socket, 'system.hello');
    expect(hello.bootId).toBe(t.hub.bootId);
    expect(hello.payload.client).toEqual({ kind: 'device', deviceId: device.id, role: 'customer', name: 'customer-1' });
  });

  it('未登録の端末は接続できない', async () => {
    const socket = open({ deviceToken: 'bogus' });
    const err = await new Promise<Error>((resolve) => socket.once('connect_error', resolve));
    expect(err.message).toBe('unauthorized');
  });

  it('管理画面から送ったテスト通知が全端末に届く', async () => {
    const kitchen = await t.pairDevice('kitchen');
    const pickup = await t.pairDevice('pickup');
    const a = open({ deviceToken: kitchen.token });
    const b = open({ deviceToken: pickup.token });
    await Promise.all([waitFor(a, 'system.hello'), waitFor(b, 'system.hello')]);

    const received = Promise.all([
      waitFor<EventEnvelope<PingPayload>>(a, 'system.ping'),
      waitFor<EventEnvelope<PingPayload>>(b, 'system.ping'),
    ]);
    const adminToken = await t.adminLogin();
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/admin/broadcast-ping',
      headers: { [STAFF_SESSION_HEADER]: adminToken },
      payload: { message: 'テスト' },
    });
    expect(res.statusCode).toBe(200);
    const [ea, eb] = await received;
    expect(ea.payload).toEqual({ message: 'テスト', from: '管理者' });
    expect(eb.seq).toBe(ea.seq);
  });

  it('管理画面は端末の接続状態を受け取り、一覧に反映される', async () => {
    const adminToken = await t.adminLogin();
    const admin = open({ adminSession: adminToken });
    await waitFor(admin, 'system.hello');

    const { token, device } = await t.pairDevice('pickup');
    const presence = waitFor<EventEnvelope<PresencePayload>>(admin, 'devices.presence');
    open({ deviceToken: token });
    expect((await presence).payload.onlineDeviceIds).toContain(device.id);

    const list = await t.app.inject({
      method: 'GET',
      url: '/api/admin/devices',
      headers: { [STAFF_SESSION_HEADER]: adminToken },
    });
    expect(list.json().devices.find((d: { id: number }) => d.id === device.id).online).toBe(true);
  });

  it('無効化した端末は即座に切断される', async () => {
    const { token, device } = await t.pairDevice('kitchen');
    const socket = open({ deviceToken: token });
    await waitFor(socket, 'system.hello');
    const disconnected = new Promise<string>((resolve) => socket.once('disconnect', resolve));
    const adminToken = await t.adminLogin();
    await t.app.inject({
      method: 'PATCH',
      url: `/api/admin/devices/${device.id}`,
      headers: { [STAFF_SESSION_HEADER]: adminToken },
      payload: { enabled: false },
    });
    expect(await disconnected).toBe('io server disconnect');
  });
});
