import { randomUUID } from 'node:crypto';
import type { Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import {
  rooms,
  type ClientToServerEvents,
  type DeviceInfo,
  type EventEnvelope,
  type ServerToClientEvents,
} from '@pos/shared';
import type { AuthService } from '../modules/auth/service.js';

type EventName = keyof ServerToClientEvents;
type PayloadOf<E extends EventName> =
  Parameters<ServerToClientEvents[E]>[0] extends EventEnvelope<infer P> ? P : never;

interface SocketData {
  device?: DeviceInfo;
  adminEmployeeId?: number;
}

type PosSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;

/**
 * Socket.IO の配信を一手に引き受ける。WebSocket は通知専用で、状態変更は REST で行う。
 * 端末は接続のたびに `system.hello` を受け、全状態を REST で取り直す。
 */
export class RealtimeHub {
  readonly bootId = randomUUID();
  private seq = 0;
  readonly io: Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;
  /** deviceId → 接続中のソケット数（同じ端末の多重タブも数える） */
  private readonly online = new Map<number, number>();

  constructor(httpServer: HttpServer, private readonly auth: AuthService) {
    this.io = new Server(httpServer, {
      path: '/socket.io',
      serveClient: false,
      // 店内LANのみ。切断検知を速めて「通信状態」表示を正確にする
      pingInterval: 5000,
      pingTimeout: 5000,
    });
    this.io.use((socket, next) => {
      const { deviceToken, adminSession } = (socket.handshake.auth ?? {}) as Record<string, unknown>;
      const device = typeof deviceToken === 'string' ? this.auth.authenticateDevice(deviceToken) : null;
      if (device) {
        socket.data.device = device;
        return next();
      }
      const session = typeof adminSession === 'string' ? this.auth.authenticateSession(adminSession) : null;
      if (session?.kind === 'admin') {
        socket.data.adminEmployeeId = session.employee.id;
        return next();
      }
      next(new Error('unauthorized'));
    });
    this.io.on('connection', (socket) => this.onConnection(socket));
  }

  private onConnection(socket: PosSocket) {
    const { device, adminEmployeeId } = socket.data;
    void socket.join(rooms.all);
    if (device) {
      void socket.join([rooms.role(device.role), rooms.device(device.id)]);
      this.online.set(device.id, (this.online.get(device.id) ?? 0) + 1);
      this.auth.touchDevice(device.id);
      socket.emit(
        'system.hello',
        this.envelope({
          serverTime: Date.now(),
          client: { kind: 'device', deviceId: device.id, role: device.role, name: device.name },
        }),
      );
      socket.on('disconnect', () => {
        const count = (this.online.get(device.id) ?? 1) - 1;
        if (count <= 0) this.online.delete(device.id);
        else this.online.set(device.id, count);
        this.auth.touchDevice(device.id);
        this.broadcastPresence();
      });
    } else if (adminEmployeeId !== undefined) {
      void socket.join(rooms.admin);
      socket.emit(
        'system.hello',
        this.envelope({ serverTime: Date.now(), client: { kind: 'admin', employeeId: adminEmployeeId } }),
      );
    }
    this.broadcastPresence();
  }

  private envelope<T>(payload: T): EventEnvelope<T> {
    return { bootId: this.bootId, seq: ++this.seq, sentAt: Date.now(), payload };
  }

  emit<E extends EventName>(room: string, event: E, payload: PayloadOf<E>) {
    const args = [this.envelope(payload)] as unknown as Parameters<ServerToClientEvents[E]>;
    this.io.to(room).emit(event, ...args);
  }

  isOnline(deviceId: number) {
    return this.online.has(deviceId);
  }

  broadcastPresence() {
    this.emit(rooms.admin, 'devices.presence', { onlineDeviceIds: [...this.online.keys()] });
  }

  /** 無効化した端末を即座に切断する */
  disconnectDevice(deviceId: number) {
    this.io.in(rooms.device(deviceId)).disconnectSockets(true);
  }

  /** 全接続を切る。HTTP サーバー自体は Fastify が閉じる */
  disconnectAll() {
    this.io.disconnectSockets(true);
    this.io.engine.close();
  }
}
