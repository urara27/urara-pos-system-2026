import fs from 'node:fs';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import type Database from 'better-sqlite3';
import Fastify, { type FastifyServerOptions } from 'fastify';
import type { Db } from './db/client.js';
import { registerErrorHandler } from './lib/errors.js';
import { createGuards } from './modules/auth/guards.js';
import { authRoutes } from './modules/auth/routes.js';
import { AuthService } from './modules/auth/service.js';
import { deviceAdminRoutes } from './modules/devices/routes.js';
import { EmployeeService } from './modules/employees/service.js';
import { deviceMasterRoutes, masterAdminRoutes } from './modules/masters/routes.js';
import { MasterService } from './modules/masters/service.js';
import { SettingsService } from './modules/settings/service.js';
import { CheckoutService } from './modules/checkout/service.js';
import { orderRoutes } from './modules/orders/routes.js';
import { OrderService } from './modules/orders/service.js';
import { RegisterService } from './modules/registers/service.js';
import { PrinterRegistry } from './modules/printing/driver.js';
import { printingRoutes } from './modules/printing/routes.js';
import { PrintingService } from './modules/printing/service.js';
import { refundRoutes } from './modules/refunds/routes.js';
import { RefundService } from './modules/refunds/service.js';
import { reportRoutes } from './modules/reports/routes.js';
import { ReportService } from './modules/reports/service.js';
import { BackupService, type BackupOptions } from './modules/operations/backup.js';
import { operationsRoutes } from './modules/operations/routes.js';
import { OperationsService, startAutoClose } from './modules/operations/service.js';
import { RealtimeHub } from './realtime/hub.js';

/** drizzle() が返す DB には元の better-sqlite3 接続が $client として付いている */
const sqliteOf = (db: Db) => (db as unknown as { $client: Database.Database }).$client;

export interface BuildAppOptions {
  db: Db;
  logger?: FastifyServerOptions['logger'];
  webDistDir?: string | null;
  /** 省略時は ./data/backups に30世代 */
  backup?: BackupOptions;
  /** 閉店し忘れた営業日を切替時刻に自動で閉じる見回りを動かす（本番のみ） */
  autoClose?: boolean;
}

export async function buildApp({
  db,
  logger = false,
  webDistDir = null,
  backup = { dir: path.resolve('./data/backups'), keep: 30 },
  autoClose = false,
}: BuildAppOptions) {
  const app = Fastify({ logger, trustProxy: true });
  registerErrorHandler(app);
  app.decorateRequest('device', null);
  app.decorateRequest('session', null);

  const auth = new AuthService(db);
  const guards = createGuards(auth);
  const hub = new RealtimeHub(app.server, auth);
  app.addHook('preClose', async () => hub.disconnectAll());

  const masters = new MasterService(db);
  const employees = new EmployeeService(db);
  const settings = new SettingsService(db);
  const registers = new RegisterService(db);
  const orders = new OrderService(db);
  const checkout = new CheckoutService(db, registers);
  const printing = new PrintingService(db, new PrinterRegistry(app.log));
  const refunds = new RefundService(db, registers);
  const reports = new ReportService(db, registers);
  const operations = new OperationsService(db, new BackupService(db, sqliteOf(db), backup, app.log), app.log);
  if (autoClose) {
    const stop = startAutoClose(operations, app.log);
    app.addHook('onClose', async () => stop());
  }

  app.get('/api/system/health', async () => ({ ok: true, bootId: hub.bootId, serverTime: Date.now() }));
  authRoutes(app, auth, guards);
  deviceMasterRoutes(app, { masters, settings, guards });
  orderRoutes(app, { orders, checkout, registers, printing, hub, guards });
  printingRoutes(app, printing, guards);
  refundRoutes(app, { refunds, orders, hub, guards });
  // 管理 API は管理者ログイン必須のフックを持つので、スコープを分けて登録する
  await app.register(async (scope) => deviceAdminRoutes(scope, db, auth, hub, guards));
  await app.register(async (scope) => masterAdminRoutes(scope, { db, masters, employees, settings, hub, guards }));
  await app.register(async (scope) => reportRoutes(scope, reports, guards));
  await app.register(async (scope) => operationsRoutes(scope, operations, guards));

  if (webDistDir && fs.existsSync(path.join(webDistDir, 'index.html'))) {
    await app.register(fastifyStatic, { root: webDistDir, wildcard: false });
    // SPA: API 以外の未知のパスは index.html を返す
    app.setNotFoundHandler((request, reply) => {
      if (request.method === 'GET' && !request.url.startsWith('/api/')) {
        return reply.sendFile('index.html');
      }
      return reply.status(404).send({ error: { code: 'not_found', message: '見つかりません' } });
    });
  }

  return { app, hub, auth, printing, operations };
}
