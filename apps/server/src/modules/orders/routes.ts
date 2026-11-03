import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  checkoutRequest,
  closeRegisterRequest,
  KITCHEN_VIEWS,
  openRegisterRequest,
  rooms,
  type OrderAction,
  type OrderChange,
  type OrderView,
} from '@pos/shared';
import { parse } from '../../lib/errors.js';
import type { RealtimeHub } from '../../realtime/hub.js';
import type { Guards } from '../auth/guards.js';
import type { CheckoutService } from '../checkout/service.js';
import type { RegisterService } from '../registers/service.js';
import type { OrderService } from './service.js';

const idParams = z.object({ id: z.coerce.number().int().positive() });
const stationParams = idParams.extend({ view: z.enum(KITCHEN_VIEWS) });

/** URL の操作名 → 状態遷移の操作と、端末へ知らせる変化 */
const PICKUP_ACTIONS: Record<string, { action: OrderAction; change: OrderChange }> = {
  call: { action: 'call', change: 'called' },
  recall: { action: 'recall', change: 'recalled' },
  uncall: { action: 'uncall', change: 'uncalled' },
  handover: { action: 'handover', change: 'handed_over' },
  'undo-handover': { action: 'undoHandover', change: 'handover_undone' },
};

export interface OrderDeps {
  orders: OrderService;
  checkout: CheckoutService;
  registers: RegisterService;
  hub: RealtimeHub;
  guards: Guards;
}

export function orderRoutes(app: FastifyInstance, deps: OrderDeps) {
  const { orders, checkout, registers, hub, guards } = deps;
  const notify = (order: OrderView, change: OrderChange) => {
    hub.emit(rooms.all, 'order.updated', { order, change });
    return order;
  };

  // ───────── レジ: 開設・閉設 ─────────

  // レジ番号の選択はログイン前に行うので、端末の認証だけで一覧を返す
  app.get('/api/register/registers', { preHandler: guards.requireDevice('register') }, async (req) => ({
    registers: registers.list(req.device!.id),
  }));

  app.post('/api/register/sessions', { preHandler: guards.requireStaff() }, async (req) => {
    const body = parse(openRegisterRequest, req.body);
    const session = registers.open(body, req.device!.id, req.session!.employee.id);
    return registers.summary(session.id);
  });

  app.get('/api/register/sessions/:id', { preHandler: guards.requireStaff() }, async (req) =>
    registers.summary(parse(idParams, req.params).id),
  );

  app.post('/api/register/sessions/:id/close', { preHandler: guards.requireStaff() }, async (req) => {
    const { id } = parse(idParams, req.params);
    const { countedCash } = parse(closeRegisterRequest, req.body);
    return registers.close(id, countedCash, req.device!.id, req.session!.employee.id);
  });

  // ───────── レジ: 会計確定 ─────────

  app.post('/api/transactions', { preHandler: guards.requireStaff() }, async (req) => {
    const body = parse(checkoutRequest, req.body);
    const { result, orderId } = checkout.checkout(body, { deviceId: req.device!.id, employee: req.session!.employee });
    // 再送（replayed）のときは既に通知済み
    if (orderId !== null) notify(orders.get(orderId), 'created');
    return result;
  });

  // ───────── 各端末: 注文の一覧 ─────────

  app.get('/api/orders/board', { preHandler: guards.requireDevice() }, async () => orders.board());

  // ───────── キッチン: 調理完了・取消 ─────────

  app.post('/api/orders/:id/stations/:view/complete', { preHandler: guards.requireDevice('kitchen') }, async (req) => {
    const { id, view } = parse(stationParams, req.params);
    return notify(orders.setStationDone(id, view, true, { deviceId: req.device!.id }), 'station_completed');
  });

  app.post('/api/orders/:id/stations/:view/reopen', { preHandler: guards.requireDevice('kitchen') }, async (req) => {
    const { id, view } = parse(stationParams, req.params);
    return notify(orders.setStationDone(id, view, false, { deviceId: req.device!.id }), 'station_reopened');
  });

  // ───────── ピックアップ: 呼び出し・受け渡し ─────────

  app.post('/api/orders/:id/:action', { preHandler: guards.requireDevice('pickup') }, async (req, reply) => {
    const { id } = parse(idParams, req.params);
    const op = PICKUP_ACTIONS[(req.params as { action: string }).action];
    if (!op) return reply.status(404).send({ error: { code: 'not_found', message: '見つかりません' } });
    return notify(orders.transition(id, op.action, { deviceId: req.device!.id }), op.change);
  });
}
