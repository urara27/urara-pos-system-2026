import { and, eq, gt, isNull } from 'drizzle-orm';
import type { DeviceInfo, DeviceRole, EmployeeInfo } from '@pos/shared';
import { immediateTransaction, type Db } from '../../db/client.js';
import { devices, employees, pairingCodes, staffSessions } from '../../db/schema.js';
import { randomDigits, randomToken, sha256, verifySecret } from '../../lib/crypto.js';
import { AppError, unauthorized } from '../../lib/errors.js';
import { writeAudit } from '../audit/service.js';

const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;
const STAFF_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const ADMIN_SESSION_TTL_MS = 8 * 60 * 60 * 1000;

export type SessionKind = 'staff' | 'admin';

export interface AuthenticatedSession {
  sessionId: number;
  kind: SessionKind;
  deviceId: number | null;
  employee: EmployeeInfo;
}

type EmployeeRow = typeof employees.$inferSelect;

export function toEmployeeInfo(e: EmployeeRow): EmployeeInfo {
  return {
    id: e.id,
    code: e.code,
    name: e.name,
    role: e.role,
    canManualDiscount: e.canManualDiscount,
  };
}

function toDeviceInfo(d: typeof devices.$inferSelect): DeviceInfo {
  return { id: d.id, name: d.name, role: d.role };
}

export class AuthService {
  constructor(private readonly db: Db) {}

  // ───────── 端末ペアリング ─────────

  createPairingCode(role: DeviceRole, createdByEmployeeId: number, now = Date.now()) {
    return immediateTransaction(this.db, (tx) => {
      // 有効なコード同士が重ならないように採番する
      let code: string;
      do {
        code = randomDigits(6);
      } while (this.findActivePairingCode(tx, code, now));
      const expiresAt = now + PAIRING_CODE_TTL_MS;
      tx.insert(pairingCodes).values({ code, role, expiresAt, createdByEmployeeId }).run();
      writeAudit(tx, {
        action: 'device.pairing_code_issued',
        employeeId: createdByEmployeeId,
        after: { role, expiresAt },
      });
      return { code, role, expiresAt };
    });
  }

  pairDevice(code: string, name: string, now = Date.now()) {
    return immediateTransaction(this.db, (tx) => {
      const pairing = this.findActivePairingCode(tx, code, now);
      if (!pairing) {
        throw new AppError(400, 'invalid_pairing_code', 'ペアリングコードが無効か、有効期限が切れています');
      }
      const token = randomToken();
      const device = tx
        .insert(devices)
        .values({ name, role: pairing.role, tokenHash: sha256(token), pairedAt: now })
        .returning()
        .get();
      tx.update(pairingCodes)
        .set({ usedAt: now, usedByDeviceId: device.id })
        .where(eq(pairingCodes.id, pairing.id))
        .run();
      writeAudit(tx, {
        action: 'device.paired',
        deviceId: device.id,
        targetType: 'device',
        targetId: device.id,
        after: { name, role: pairing.role },
      });
      return { token, device: toDeviceInfo(device) };
    });
  }

  private findActivePairingCode(tx: Db, code: string, now: number) {
    return tx
      .select()
      .from(pairingCodes)
      .where(
        and(eq(pairingCodes.code, code), isNull(pairingCodes.usedAt), gt(pairingCodes.expiresAt, now)),
      )
      .get();
  }

  /** 端末トークンから有効な端末を引く。無効化された端末は認証しない */
  authenticateDevice(token: string | undefined): DeviceInfo | null {
    if (!token) return null;
    const device = this.db.select().from(devices).where(eq(devices.tokenHash, sha256(token))).get();
    if (!device || !device.enabled) return null;
    return toDeviceInfo(device);
  }

  touchDevice(deviceId: number, now = Date.now()) {
    this.db.update(devices).set({ lastSeenAt: now }).where(eq(devices.id, deviceId)).run();
  }

  // ───────── 従業員・管理者ログイン ─────────

  /** レジ端末での従業員ログイン（従業員コード + PIN） */
  async staffLogin(deviceId: number, code: string, pin: string, now = Date.now()) {
    const employee = this.findEnabledEmployee(code);
    if (!employee || !(await verifySecret(employee.pinHash, pin))) {
      throw unauthorized('従業員コードまたはPINが正しくありません');
    }
    return this.createSession(employee, 'staff', deviceId, now + STAFF_SESSION_TTL_MS);
  }

  /** 管理画面ログイン（管理者のみ, 従業員コード + パスワード） */
  async adminLogin(code: string, password: string, now = Date.now()) {
    const employee = this.findEnabledEmployee(code);
    const ok =
      employee?.role === 'admin' &&
      employee.passwordHash !== null &&
      (await verifySecret(employee.passwordHash, password));
    if (!employee || !ok) {
      throw unauthorized('従業員コードまたはパスワードが正しくありません');
    }
    const session = this.createSession(employee, 'admin', null, now + ADMIN_SESSION_TTL_MS);
    writeAudit(this.db, { action: 'admin.login', employeeId: employee.id });
    return session;
  }

  private findEnabledEmployee(code: string) {
    const employee = this.db.select().from(employees).where(eq(employees.code, code)).get();
    return employee?.enabled ? employee : undefined;
  }

  private createSession(employee: EmployeeRow, kind: SessionKind, deviceId: number | null, expiresAt: number) {
    const token = randomToken();
    this.db
      .insert(staffSessions)
      .values({ tokenHash: sha256(token), employeeId: employee.id, deviceId, kind, expiresAt })
      .run();
    return { token, employee: toEmployeeInfo(employee), expiresAt };
  }

  authenticateSession(token: string | undefined, now = Date.now()): AuthenticatedSession | null {
    if (!token) return null;
    const row = this.db
      .select({ session: staffSessions, employee: employees })
      .from(staffSessions)
      .innerJoin(employees, eq(employees.id, staffSessions.employeeId))
      .where(eq(staffSessions.tokenHash, sha256(token)))
      .get();
    if (!row) return null;
    const { session, employee } = row;
    if (session.revokedAt !== null || session.expiresAt <= now || !employee.enabled) return null;
    if (session.kind === 'admin' && employee.role !== 'admin') return null;
    return {
      sessionId: session.id,
      kind: session.kind,
      deviceId: session.deviceId,
      employee: toEmployeeInfo(employee),
    };
  }

  revokeSession(sessionId: number, now = Date.now()) {
    this.db.update(staffSessions).set({ revokedAt: now }).where(eq(staffSessions.id, sessionId)).run();
  }

  /** 端末を無効化したときに、その端末でのログインもすべて失効させる */
  revokeDeviceSessions(deviceId: number, now = Date.now()) {
    this.db
      .update(staffSessions)
      .set({ revokedAt: now })
      .where(and(eq(staffSessions.deviceId, deviceId), isNull(staffSessions.revokedAt)))
      .run();
  }
}
