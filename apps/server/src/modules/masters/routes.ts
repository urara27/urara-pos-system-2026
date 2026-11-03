import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  categoryInput,
  discountInput,
  employeeCreateInput,
  employeeUpdateInput,
  optionGroupInput,
  productInput,
  registerInput,
  rooms,
  storeSettingsInput,
  type CatalogUpdatedPayload,
} from '@pos/shared';
import type { Db } from '../../db/client.js';
import { parse } from '../../lib/errors.js';
import type { RealtimeHub } from '../../realtime/hub.js';
import type { Guards } from '../auth/guards.js';
import type { EmployeeService } from '../employees/service.js';
import type { SettingsService } from '../settings/service.js';
import { exportProductsCsv, importProductsCsv } from './product-csv.js';
import type { Actor, MasterService } from './service.js';

const idParams = z.object({ id: z.coerce.number().int().positive() });
const soldOutBody = z.object({ soldOut: z.boolean() });
const csvBody = z.object({ csv: z.string().max(2_000_000) });

export interface MasterDeps {
  db: Db;
  masters: MasterService;
  employees: EmployeeService;
  settings: SettingsService;
  hub: RealtimeHub;
  guards: Guards;
}

const actorOf = (request: FastifyRequest): Actor => ({ employeeId: request.session!.employee.id });
const idOf = (request: FastifyRequest) => parse(idParams, request.params).id;

/** 管理画面のマスタ・設定 API（管理者ログイン必須） */
export function masterAdminRoutes(app: FastifyInstance, deps: MasterDeps) {
  const { db, masters, employees, settings, hub, guards } = deps;
  app.addHook('preHandler', guards.requireAdmin);

  /** レジに出る内容が変わったら全端末へ知らせる。レジはカタログを取り直す */
  const catalogChanged = <T>(reason: CatalogUpdatedPayload['reason'], result: T): T => {
    hub.emit(rooms.all, 'catalog.updated', { reason });
    return result;
  };

  // カテゴリ
  app.get('/api/admin/categories', async () => ({ categories: masters.listCategories() }));
  app.post('/api/admin/categories', async (req) =>
    catalogChanged('categories', masters.createCategory(parse(categoryInput, req.body), actorOf(req))),
  );
  app.put('/api/admin/categories/:id', async (req) =>
    catalogChanged('categories', masters.updateCategory(idOf(req), parse(categoryInput, req.body), actorOf(req))),
  );

  // 商品
  app.get('/api/admin/products', async () => ({ products: masters.listProducts() }));
  app.post('/api/admin/products', async (req) =>
    catalogChanged('products', masters.createProduct(parse(productInput, req.body), actorOf(req))),
  );
  app.put('/api/admin/products/:id', async (req) =>
    catalogChanged('products', masters.updateProduct(idOf(req), parse(productInput, req.body), actorOf(req))),
  );
  app.post('/api/admin/products/:id/sold-out', async (req) => {
    masters.setSoldOut(idOf(req), parse(soldOutBody, req.body).soldOut, actorOf(req));
    return catalogChanged('products', { ok: true });
  });
  app.get('/api/admin/products/export', async (_req, reply) => {
    const { storeCode } = settings.getStoreSettings();
    const date = new Date().toISOString().slice(0, 10);
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="products-${storeCode}-${date}.csv"`)
      .send(exportProductsCsv(masters));
  });
  app.post('/api/admin/products/import', { bodyLimit: 4 * 1024 * 1024 }, async (req) => {
    const result = importProductsCsv(db, masters, parse(csvBody, req.body).csv, actorOf(req));
    return catalogChanged('products', result);
  });

  // オプショングループ
  app.get('/api/admin/option-groups', async () => ({ optionGroups: masters.listOptionGroups() }));
  app.post('/api/admin/option-groups', async (req) =>
    catalogChanged('optionGroups', masters.createOptionGroup(parse(optionGroupInput, req.body), actorOf(req))),
  );
  app.put('/api/admin/option-groups/:id', async (req) =>
    catalogChanged(
      'optionGroups',
      masters.updateOptionGroup(idOf(req), parse(optionGroupInput, req.body), actorOf(req)),
    ),
  );

  // 割引・クーポン
  app.get('/api/admin/discounts', async () => ({ discounts: masters.listDiscounts() }));
  app.post('/api/admin/discounts', async (req) =>
    catalogChanged('discounts', masters.createDiscount(parse(discountInput, req.body), actorOf(req))),
  );
  app.put('/api/admin/discounts/:id', async (req) =>
    catalogChanged('discounts', masters.updateDiscount(idOf(req), parse(discountInput, req.body), actorOf(req))),
  );

  // 従業員
  app.get('/api/admin/employees', async () => ({ employees: employees.list() }));
  app.post('/api/admin/employees', async (req) => employees.create(parse(employeeCreateInput, req.body), actorOf(req)));
  app.put('/api/admin/employees/:id', async (req) =>
    employees.update(idOf(req), parse(employeeUpdateInput, req.body), actorOf(req)),
  );

  // レジ
  app.get('/api/admin/registers', async () => ({ registers: settings.listRegisters() }));
  app.post('/api/admin/registers', async (req) => settings.createRegister(parse(registerInput, req.body), actorOf(req)));
  app.put('/api/admin/registers/:id', async (req) =>
    settings.updateRegister(idOf(req), parse(registerInput, req.body), actorOf(req)),
  );

  // 店舗・運用設定
  app.get('/api/admin/settings', async () => ({ settings: settings.getStoreSettings() }));
  app.put('/api/admin/settings', async (req) => {
    const result = settings.updateStoreSettings(parse(storeSettingsInput, req.body), actorOf(req));
    hub.emit(rooms.all, 'settings.updated', {});
    return { settings: result };
  });
}

/** 端末向けの読み取り API */
export function deviceMasterRoutes(app: FastifyInstance, deps: Pick<MasterDeps, 'masters' | 'settings' | 'guards'>) {
  const { masters, settings, guards } = deps;
  app.get('/api/catalog', { preHandler: guards.requireDevice('register') }, async () => masters.catalog());
  app.get('/api/device-settings', { preHandler: guards.requireDevice() }, async () => ({
    settings: settings.getDeviceSettings(),
  }));
}
