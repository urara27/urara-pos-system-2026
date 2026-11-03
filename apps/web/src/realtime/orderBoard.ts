import { useCallback, useState } from 'react';
import type { OrderBoard, OrderView } from '@pos/shared';
import { api } from '../lib/api';

export interface BoardState {
  active: OrderView[];
  recent: OrderView[];
  /** 一度でも取得できたか */
  loaded: boolean;
}

const RECENT_LIMIT = 30;
const isActive = (o: OrderView) => o.status === 'accepted' || o.status === 'calling';
const byAccepted = (a: OrderView, b: OrderView) => a.acceptedAt - b.acceptedAt || a.id - b.id;

/** order.updated で届いた注文を一覧へ反映する。古い版（version が小さい）は無視する */
export function applyOrder(prev: BoardState, order: OrderView): BoardState {
  const current = [...prev.active, ...prev.recent].find((o) => o.id === order.id);
  if (current && current.version > order.version) return prev;
  const active = prev.active.filter((o) => o.id !== order.id);
  const recent = prev.recent.filter((o) => o.id !== order.id);
  if (isActive(order)) return { ...prev, active: [...active, order].sort(byAccepted), recent };
  return { ...prev, active, recent: [order, ...recent].slice(0, RECENT_LIMIT) };
}

/**
 * キッチン・カスタマー・ピックアップ共通の注文一覧。
 * 接続・再接続のたびに reload で全件を取り直し、その後は apply でイベントを反映する。
 */
export function useOrderBoard() {
  const [board, setBoard] = useState<BoardState>({ active: [], recent: [], loaded: false });
  const reload = useCallback(() => {
    api<OrderBoard>('/api/orders/board')
      .then((b) => setBoard({ active: b.active, recent: b.recent, loaded: true }))
      .catch(() => undefined);
  }, []);
  const apply = useCallback((order: OrderView) => setBoard((prev) => applyOrder(prev, order)), []);
  return { board, reload, apply };
}
