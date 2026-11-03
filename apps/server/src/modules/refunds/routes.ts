import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { refundQuoteRequest, refundRequest, rooms, transactionSearchQuery } from '@pos/shared';
import { AppError, parse } from '../../lib/errors.js';
import { FailureLimiter } from '../../lib/rate-limit.js';
import type { RealtimeHub } from '../../realtime/hub.js';
import type { Guards } from '../auth/guards.js';
import type { OrderService } from '../orders/service.js';
import type { RefundService } from './service.js';

const idParams = z.object({ id: z.coerce.number().int().positive() });

export function refundRoutes(
  app: FastifyInstance,
  deps: { refunds: RefundService; orders: OrderService; hub: RealtimeHub; guards: Guards },
) {
  const { refunds, orders, hub, guards } = deps;
  const approverLimiter = new FailureLimiter(5, 5 * 60 * 1000);

  // ───────── 取引の検索・詳細（レジのスタッフ・管理者） ─────────

  app.get('/api/transactions', { preHandler: guards.requireStaffOrAdmin }, async (req) => ({
    transactions: refunds.search(parse(transactionSearchQuery, req.query)),
  }));

  app.get('/api/transactions/employees', { preHandler: guards.requireStaffOrAdmin }, async () => ({
    employees: refunds.employeesForSearch(),
  }));

  app.get('/api/transactions/:id/detail', { preHandler: guards.requireStaffOrAdmin }, async (req) =>
    refunds.detail(parse(idParams, req.params).id),
  );

  // ───────── 返金・商品変更（レジ） ─────────

  app.post('/api/transactions/:id/refund-quote', { preHandler: guards.requireStaff() }, async (req) =>
    refunds.quote(parse(idParams, req.params).id, parse(refundQuoteRequest, req.body)),
  );

  app.post('/api/transactions/:id/refund', { preHandler: guards.requireStaff() }, async (req) => {
    const { id } = parse(idParams, req.params);
    const body = parse(refundRequest, req.body);

    // 責任者 PIN の総当たりを防ぐ
    const key = `approver:${req.device!.id}`;
    approverLimiter.assertAllowed(key);
    let approver;
    try {
      approver = await refunds.verifyApprover(body.approver.code, body.approver.pin);
      approverLimiter.reset(key);
    } catch (err) {
      if (err instanceof AppError && err.statusCode === 401) approverLimiter.recordFailure(key);
      throw err;
    }

    const { result, orderId } = refunds.execute(id, body, {
      deviceId: req.device!.id,
      employee: req.session!.employee,
      approverId: approver.id,
    });
    // 受け渡し前の注文の変更・取消をキッチン・カスタマー・ピックアップへ即時に知らせる
    if (orderId !== null) {
      hub.emit(rooms.all, 'order.updated', {
        order: orders.get(orderId),
        change: result.orderEffect === 'cancelled' ? 'cancelled' : 'modified',
      });
    }
    return result;
  });
}
