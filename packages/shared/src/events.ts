import type { DeviceRole } from './domain.js';

/**
 * サーバー→端末のイベント。状態変更はすべて REST で行い、WebSocket は通知専用。
 * 端末は接続（再接続）のたびに `system.hello` を受け取り、必要な全状態を REST で取り直す。
 */
export interface EventEnvelope<T> {
  /** サーバー起動ごとに変わるID。変わったら端末は全状態を取り直す */
  bootId: string;
  /** 起動後の単調増加番号 */
  seq: number;
  sentAt: number;
  payload: T;
}

export interface HelloPayload {
  serverTime: number;
  client:
    | { kind: 'device'; deviceId: number; role: DeviceRole; name: string }
    | { kind: 'admin'; employeeId: number };
}

export interface PingPayload {
  message: string;
  from: string;
}

export interface PresencePayload {
  onlineDeviceIds: number[];
}

/** 商品・カテゴリ・オプション・割引のどれかが変わった。レジはカタログを取り直す */
export interface CatalogUpdatedPayload {
  reason: 'categories' | 'products' | 'optionGroups' | 'discounts';
}

export interface ServerToClientEvents {
  'system.hello': (e: EventEnvelope<HelloPayload>) => void;
  'system.ping': (e: EventEnvelope<PingPayload>) => void;
  'devices.presence': (e: EventEnvelope<PresencePayload>) => void;
  'catalog.updated': (e: EventEnvelope<CatalogUpdatedPayload>) => void;
  /** 店舗・運用設定が変わった。各端末は必要な設定を取り直す */
  'settings.updated': (e: EventEnvelope<Record<string, never>>) => void;
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface ClientToServerEvents {}

/** Socket.IO ルーム名 */
export const rooms = {
  all: 'all',
  admin: 'admin',
  role: (role: DeviceRole) => `role:${role}`,
  device: (id: number) => `device:${id}`,
} as const;
