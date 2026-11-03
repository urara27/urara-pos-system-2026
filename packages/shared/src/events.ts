import type { DeviceRole } from './domain.js';
import type { OrderView } from './orders.js';

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

/** 注文に起きたこと。端末はこれで表示を更新し、音を鳴らすかを決める */
export type OrderChange =
  | 'created'
  | 'station_completed'
  | 'station_reopened'
  | 'called'
  | 'recalled'
  | 'uncalled'
  | 'handed_over'
  | 'handover_undone'
  | 'modified'
  | 'cancelled';

export interface OrderUpdatedPayload {
  order: OrderView;
  change: OrderChange;
}

export interface ServerToClientEvents {
  /** 注文の作成・状態変化。受け取った OrderView で置き換える */
  'order.updated': (e: EventEnvelope<OrderUpdatedPayload>) => void;
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
