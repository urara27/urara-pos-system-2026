import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import {
  DEVICE_TOKEN_HEADER,
  STAFF_SESSION_HEADER,
  type DeviceInfo,
  type DeviceRole,
  type EmployeeRole,
} from '@pos/shared';
import { forbidden, unauthorized } from '../../lib/errors.js';
import type { AuthenticatedSession, AuthService } from './service.js';

declare module 'fastify' {
  interface FastifyRequest {
    device: DeviceInfo | null;
    session: AuthenticatedSession | null;
  }
}

function header(request: FastifyRequest, name: string) {
  const value = request.headers[name];
  return typeof value === 'string' ? value : undefined;
}

export function readDeviceToken(request: FastifyRequest) {
  return header(request, DEVICE_TOKEN_HEADER);
}

export function readSessionToken(request: FastifyRequest) {
  return header(request, STAFF_SESSION_HEADER);
}

/**
 * 各リクエストの端末・セッションを解決するガード群。
 * 端末（ペアリング済み）とログイン（従業員/管理者）は独立して検証する。
 */
export function createGuards(auth: AuthService) {
  const resolveDevice = (request: FastifyRequest) => {
    request.device ??= auth.authenticateDevice(readDeviceToken(request));
    return request.device;
  };
  const resolveSession = (request: FastifyRequest) => {
    request.session ??= auth.authenticateSession(readSessionToken(request));
    return request.session;
  };

  /** ペアリング済みの端末を要求する。roles を指定するとその役割に限る */
  const requireDevice =
    (...roles: DeviceRole[]): preHandlerHookHandler =>
    async (request: FastifyRequest, _reply: FastifyReply) => {
      const device = resolveDevice(request);
      if (!device) throw unauthorizedDevice();
      if (roles.length > 0 && !roles.includes(device.role)) {
        throw forbidden('この端末の役割では操作できません');
      }
    };

  /** レジ端末での従業員ログインを要求する（端末とセッションの組み合わせも検証） */
  const requireStaff =
    (...roles: EmployeeRole[]): preHandlerHookHandler =>
    async (request: FastifyRequest) => {
      const device = resolveDevice(request);
      if (!device) throw unauthorizedDevice();
      const session = resolveSession(request);
      if (!session || session.kind !== 'staff' || session.deviceId !== device.id) {
        throw unauthorized('ログインしてください');
      }
      if (roles.length > 0 && !roles.includes(session.employee.role)) {
        throw forbidden('権限がありません');
      }
    };

  /** 管理画面ログインを要求する */
  const requireAdmin: preHandlerHookHandler = async (request: FastifyRequest) => {
    const session = resolveSession(request);
    if (!session || session.kind !== 'admin') throw unauthorized('管理者ログインが必要です');
  };

  return { requireDevice, requireStaff, requireAdmin, resolveDevice, resolveSession };
}

function unauthorizedDevice() {
  return unauthorized('この端末は登録されていません。ペアリングしてください');
}

export type Guards = ReturnType<typeof createGuards>;
