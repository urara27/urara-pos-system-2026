import { and, asc, desc, eq, gte, inArray, isNotNull, or } from 'drizzle-orm';
import {
  formatOrderNumber,
  nextStatus,
  ORDER_STATUS_LABELS,
  STATIONS,
  type KitchenView,
  type OrderAction,
  type OrderBoard,
  type OrderView,
  type Station,
} from '@pos/shared';
import { immediateTransaction, type Db } from '../../db/client.js';
import {
  orderEvents,
  orders,
  orderStationStatus,
  storeSettings,
  transactionLineOptions,
  transactionLines,
  transactions,
} from '../../db/schema.js';
import { rethrowUnique } from '../../lib/db-errors.js';
import { AppError, notFound } from '../../lib/errors.js';
import { activeOrderNumbers } from './numbering.js';

/** 受け渡し済み・取消の注文を「直近」として出す期間 */
const RECENT_WINDOW_MS = 12 * 60 * 60 * 1000;
const RECENT_LIMIT = 30;

const ACTION_LABELS: Record<OrderAction, string> = {
  call: '呼び出し',
  recall: '再呼び出し',
  uncall: '呼び出しの取消',
  handover: '受け渡し',
  undoHandover: '受け渡しの取消',
  cancel: '取消',
};

export interface Actor {
  deviceId: number | null;
  employeeId?: number | null;
}

/** 端末へ配る注文の形（OrderView）を組み立てる */
export function loadOrderViews(tx: Db, orderIds: number[]): OrderView[] {
  if (orderIds.length === 0) return [];
  const rows = tx
    .select({ order: orders, receiptNumber: transactions.receiptNumber })
    .from(orders)
    .innerJoin(transactions, eq(transactions.id, orders.transactionId))
    .where(inArray(orders.id, orderIds))
    .all();
  const stations = tx.select().from(orderStationStatus).where(inArray(orderStationStatus.orderId, orderIds)).all();
  const txIds = rows.map((r) => r.order.transactionId);
  const lines = tx
    .select()
    .from(transactionLines)
    .where(inArray(transactionLines.transactionId, txIds))
    .orderBy(asc(transactionLines.lineNo))
    .all();
  const lineOptions =
    lines.length === 0
      ? []
      : tx
          .select()
          .from(transactionLineOptions)
          .where(
            inArray(
              transactionLineOptions.lineId,
              lines.map((l) => l.id),
            ),
          )
          .orderBy(asc(transactionLineOptions.id))
          .all();

  const byId = new Map(
    rows.map(({ order: o, receiptNumber }) => {
      const st = (s: Station) => {
        const r = stations.find((x) => x.orderId === o.id && x.station === s);
        return { hasItems: r?.hasItems ?? false, completedAt: r?.completedAt ?? null };
      };
      const view: OrderView = {
        id: o.id,
        orderNumber: o.orderNumber,
        numberingMode: o.numberingMode,
        diningOption: o.diningOption,
        status: o.status,
        acceptedAt: o.acceptedAt,
        calledAt: o.calledAt,
        completedAt: o.completedAt,
        cancelledAt: o.cancelledAt,
        modifiedAt: o.modifiedAt,
        version: o.version,
        receiptNumber,
        stations: { food: st('food'), drink: st('drink') },
        items: lines
          .filter((l) => l.transactionId === o.transactionId)
          .map((l) => ({
            lineId: l.id,
            name: l.productName,
            kitchenName: l.kitchenName,
            quantity: l.quantity,
            station: l.station,
            options: lineOptions
              .filter((x) => x.lineId === l.id)
              .map((x) => ({ name: x.optionName, kitchenName: x.kitchenName, station: x.station, priceDelta: x.priceDelta })),
          })),
      };
      return [o.id, view] as const;
    }),
  );
  return orderIds.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
}

export class OrderService {
  constructor(private readonly db: Db) {}

  board(now = Date.now()): OrderBoard {
    const active = this.db
      .select({ id: orders.id })
      .from(orders)
      .where(inArray(orders.status, ['accepted', 'calling']))
      .orderBy(asc(orders.acceptedAt), asc(orders.id))
      .all()
      .map((r) => r.id);
    const since = now - RECENT_WINDOW_MS;
    const recent = this.db
      .select({ id: orders.id })
      .from(orders)
      .where(
        or(
          and(eq(orders.status, 'completed'), isNotNull(orders.completedAt), gte(orders.completedAt, since)),
          and(eq(orders.status, 'cancelled'), isNotNull(orders.cancelledAt), gte(orders.cancelledAt, since)),
        ),
      )
      .orderBy(desc(orders.completedAt), desc(orders.cancelledAt), desc(orders.id))
      .limit(RECENT_LIMIT)
      .all()
      .map((r) => r.id);
    return { active: loadOrderViews(this.db, active), recent: loadOrderViews(this.db, recent), serverTime: now };
  }

  get(id: number): OrderView {
    const [view] = loadOrderViews(this.db, [id]);
    if (!view) throw notFound('注文が見つかりません');
    return view;
  }

  /** 呼び出し・受け渡しなどの状態遷移。許されない遷移はサーバーで拒否する */
  transition(orderId: number, action: OrderAction, actor: Actor, now = Date.now()): OrderView {
    try {
      immediateTransaction(this.db, (tx) => {
        const order = tx.select().from(orders).where(eq(orders.id, orderId)).get();
        if (!order) throw notFound('注文が見つかりません');
        const to = nextStatus(order.status, action);
        if (to === null) {
          throw new AppError(
            409,
            'invalid_transition',
            `注文 ${formatOrderNumber(order.orderNumber)} は「${ORDER_STATUS_LABELS[order.status]}」のため${ACTION_LABELS[action]}できません`,
          );
        }

        const patch: Partial<typeof orders.$inferInsert> = { status: to, version: order.version + 1 };
        if (action === 'call') patch.calledAt = now;
        if (action === 'recall') patch.calledAt = now;
        if (action === 'uncall') patch.calledAt = null;
        if (action === 'handover') patch.completedAt = now;
        if (action === 'undoHandover') {
          const { handoverUndoSeconds } = tx
            .select({ handoverUndoSeconds: storeSettings.handoverUndoSeconds })
            .from(storeSettings)
            .where(eq(storeSettings.id, 1))
            .get()!;
          if (order.completedAt === null || now - order.completedAt > handoverUndoSeconds * 1000) {
            throw new AppError(409, 'undo_expired', '受け渡しから時間が経っているため戻せません');
          }
          if (activeOrderNumbers(tx).has(order.orderNumber)) {
            throw new AppError(
              409,
              'number_reused',
              `番号 ${formatOrderNumber(order.orderNumber)} は既に別の注文で使われているため戻せません`,
            );
          }
          patch.completedAt = null;
          patch.calledAt = order.calledAt ?? now;
        }
        if (action === 'cancel') patch.cancelledAt = now;

        tx.update(orders).set(patch).where(eq(orders.id, orderId)).run();
        tx.insert(orderEvents)
          .values({
            orderId,
            type: action,
            fromStatus: order.status,
            toStatus: to,
            deviceId: actor.deviceId,
            employeeId: actor.employeeId ?? null,
            createdAt: now,
          })
          .run();
      });
    } catch (err) {
      rethrowUnique(err, 'この番号は既に別の注文で使われているため戻せません');
    }
    return this.get(orderId);
  }

  /**
   * キッチンの調理完了（complete）と、その取消（reopen）。
   * 「すべて」表示の端末からは全ステーションをまとめて操作する。
   */
  setStationDone(orderId: number, view: KitchenView, done: boolean, actor: Actor, now = Date.now()): OrderView {
    immediateTransaction(this.db, (tx) => {
      const order = tx.select().from(orders).where(eq(orders.id, orderId)).get();
      if (!order) throw notFound('注文が見つかりません');
      if (order.status !== 'accepted' && order.status !== 'calling') {
        throw new AppError(
          409,
          'order_closed',
          `注文 ${formatOrderNumber(order.orderNumber)} は「${ORDER_STATUS_LABELS[order.status]}」のため操作できません`,
        );
      }
      const targets: Station[] = view === 'all' ? [...STATIONS] : [view];
      let changed = false;
      for (const station of targets) {
        const row = tx
          .select()
          .from(orderStationStatus)
          .where(and(eq(orderStationStatus.orderId, orderId), eq(orderStationStatus.station, station)))
          .get();
        if (!row?.hasItems) continue;
        if (done === (row.completedAt !== null)) continue; // 既にその状態（二重タップ等）
        tx.update(orderStationStatus)
          .set({ completedAt: done ? now : null })
          .where(and(eq(orderStationStatus.orderId, orderId), eq(orderStationStatus.station, station)))
          .run();
        tx.insert(orderEvents)
          .values({
            orderId,
            type: done ? 'station_completed' : 'station_reopened',
            station,
            deviceId: actor.deviceId,
            createdAt: now,
          })
          .run();
        changed = true;
      }
      if (changed) tx.update(orders).set({ version: order.version + 1 }).where(eq(orders.id, orderId)).run();
    });
    return this.get(orderId);
  }
}
