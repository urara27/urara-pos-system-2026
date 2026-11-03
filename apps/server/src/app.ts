import fs from 'node:fs';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
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
import { RealtimeHub } from './realtime/hub.js';

export interface BuildAppOptions {
  db: Db;
  logger?: FastifyServerOptions['logger'];
  webDistDir?: string | null;
}

export async function buildApp({ db, logger = false, webDistDir = null }: BuildAppOptions) {
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

  app.get('/api/system/health', async () => ({ ok: true, bootId: hub.bootId, serverTime: Date.now() }));
  authRoutes(app, auth, guards);
  deviceMasterRoutes(app, { masters, settings, guards });
  orderRoutes(app, { orders, checkout, registers, printing, hub, guards });
  printingRoutes(app, printing, guards);
  // 管理 API は管理者ログイン必須のフックを持つので、スコープを分けて登録する
  await app.register(async (scope) => deviceAdminRoutes(scope, db, auth, hub, guards));
  await app.register(async (scope) => masterAdminRoutes(scope, { db, masters, employees, settings, hub, guards }));

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

  return { app, hub, auth, printing };
}
