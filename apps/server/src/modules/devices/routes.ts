import { desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { broadcastPingRequest, createPairingCodeRequest, rooms, type AdminDeviceRow } from '@pos/shared';
import type { Db } from '../../db/client.js';
import { devices } from '../../db/schema.js';
import { notFound, parse } from '../../lib/errors.js';
import type { RealtimeHub } from '../../realtime/hub.js';
import { writeAudit } from '../audit/service.js';
import type { Guards } from '../auth/guards.js';
import type { AuthService } from '../auth/service.js';

const updateDeviceRequest = z.object({
  name: z.string().trim().min(1).max(40).optional(),
  enabled: z.boolean().optional(),
});
const idParams = z.object({ id: z.coerce.number().int().positive() });

/** 管理画面の端末管理（ペアリングコード発行・一覧・無効化）と疎通確認 */
export function deviceAdminRoutes(
  app: FastifyInstance,
  db: Db,
  auth: AuthService,
  hub: RealtimeHub,
  guards: Guards,
) {
  app.addHook('preHandler', guards.requireAdmin);

  app.get('/api/admin/devices', async (): Promise<{ devices: AdminDeviceRow[] }> => {
    const rows = db.select().from(devices).orderBy(desc(devices.id)).all();
    return {
      devices: rows.map((d) => ({
        id: d.id,
        name: d.name,
        role: d.role,
        enabled: d.enabled,
        pairedAt: d.pairedAt,
        lastSeenAt: d.lastSeenAt,
        online: hub.isOnline(d.id),
      })),
    };
  });

  app.post('/api/admin/pairing-codes', async (request) => {
    const body = parse(createPairingCodeRequest, request.body);
    return auth.createPairingCode(body.role, request.session!.employee.id);
  });

  app.patch('/api/admin/devices/:id', async (request) => {
    const { id } = parse(idParams, request.params);
    const body = parse(updateDeviceRequest, request.body);
    const before = db.select().from(devices).where(eq(devices.id, id)).get();
    if (!before) throw notFound('端末が見つかりません');
    const after = db.update(devices).set(body).where(eq(devices.id, id)).returning().get()!;
    writeAudit(db, {
      action: 'device.updated',
      employeeId: request.session!.employee.id,
      targetType: 'device',
      targetId: id,
      before: { name: before.name, enabled: before.enabled },
      after: { name: after.name, enabled: after.enabled },
    });
    if (before.enabled && !after.enabled) {
      auth.revokeDeviceSessions(id);
      hub.disconnectDevice(id);
    }
    return { ok: true };
  });

  /** 全端末へテスト通知を送る（リアルタイム配信の疎通確認） */
  app.post('/api/admin/broadcast-ping', async (request) => {
    const body = parse(broadcastPingRequest, request.body);
    hub.emit(rooms.all, 'system.ping', { message: body.message, from: request.session!.employee.name });
    return { ok: true };
  });
}
