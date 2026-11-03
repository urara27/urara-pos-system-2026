import type { FastifyInstance } from 'fastify';
import { adminLoginRequest, pairDeviceRequest, staffLoginRequest } from '@pos/shared';
import { AppError, parse } from '../../lib/errors.js';
import { FailureLimiter } from '../../lib/rate-limit.js';
import type { Guards } from './guards.js';
import type { AuthService } from './service.js';

export function authRoutes(app: FastifyInstance, auth: AuthService, guards: Guards) {
  const pairingLimiter = new FailureLimiter(10, 10 * 60 * 1000);
  const loginLimiter = new FailureLimiter(5, 5 * 60 * 1000);

  /** 失敗を数えて総当たりを防ぐ */
  async function limited<T>(limiter: FailureLimiter, key: string, fn: () => Promise<T> | T): Promise<T> {
    limiter.assertAllowed(key);
    try {
      const result = await fn();
      limiter.reset(key);
      return result;
    } catch (err) {
      if (err instanceof AppError && (err.statusCode === 400 || err.statusCode === 401)) {
        limiter.recordFailure(key);
      }
      throw err;
    }
  }

  // ───────── 端末 ─────────

  app.post('/api/devices/pair', async (request) => {
    const body = parse(pairDeviceRequest, request.body);
    return limited(pairingLimiter, request.ip, () => auth.pairDevice(body.code, body.name));
  });

  app.get('/api/devices/me', { preHandler: guards.requireDevice() }, async (request) => {
    return { device: request.device };
  });

  // ───────── 従業員ログイン（レジ） ─────────

  app.post('/api/auth/login', { preHandler: guards.requireDevice('register') }, async (request) => {
    const body = parse(staffLoginRequest, request.body);
    const deviceId = request.device!.id;
    return limited(loginLimiter, `staff:${deviceId}:${request.ip}`, () =>
      auth.staffLogin(deviceId, body.code, body.pin),
    );
  });

  app.get('/api/auth/session', { preHandler: guards.requireStaff() }, async (request) => {
    return { employee: request.session!.employee };
  });

  app.post('/api/auth/logout', { preHandler: guards.requireStaff() }, async (request) => {
    auth.revokeSession(request.session!.sessionId);
    return { ok: true };
  });

  // ───────── 管理画面ログイン ─────────

  app.post('/api/admin/login', async (request) => {
    const body = parse(adminLoginRequest, request.body);
    return limited(loginLimiter, `admin:${request.ip}`, () => auth.adminLogin(body.code, body.password));
  });

  app.get('/api/admin/me', { preHandler: guards.requireAdmin }, async (request) => {
    return { employee: request.session!.employee };
  });

  app.post('/api/admin/logout', { preHandler: guards.requireAdmin }, async (request) => {
    auth.revokeSession(request.session!.sessionId);
    return { ok: true };
  });
}
