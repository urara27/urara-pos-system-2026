import type { FastifyInstance } from 'fastify';
import type { Guards } from '../auth/guards.js';
import type { OperationsService } from './service.js';

/** 営業日（閉店・再開）とバックアップ（管理者ログイン必須） */
export function operationsRoutes(app: FastifyInstance, ops: OperationsService, guards: Guards) {
  app.addHook('preHandler', guards.requireAdmin);

  app.get('/api/admin/operations', async () => ops.status());
  app.post('/api/admin/business-day/close', async (req) => ops.close(req.session!.employee.id));
  app.post('/api/admin/business-day/reopen', async (req) => ops.reopen(req.session!.employee.id));
  app.post('/api/admin/backups', async (req) => ops.backupNow(req.session!.employee.id));
}
