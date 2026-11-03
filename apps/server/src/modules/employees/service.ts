import { and, asc, eq, isNotNull } from 'drizzle-orm';
import type { Employee, employeeCreateInput, employeeUpdateInput } from '@pos/shared';
import type { z } from 'zod';
import { immediateTransaction, type Db } from '../../db/client.js';
import { employees, staffSessions } from '../../db/schema.js';
import { hashSecret } from '../../lib/crypto.js';
import { rethrowUnique } from '../../lib/db-errors.js';
import { AppError, notFound } from '../../lib/errors.js';
import { writeAudit } from '../audit/service.js';
import type { Actor } from '../masters/service.js';

type CreateData = z.output<typeof employeeCreateInput>;
type UpdateData = z.output<typeof employeeUpdateInput>;
type EmployeeRow = typeof employees.$inferSelect;

const toEmployee = (r: EmployeeRow): Employee => ({
  id: r.id,
  code: r.code,
  name: r.name,
  role: r.role,
  canManualDiscount: r.canManualDiscount,
  enabled: r.enabled,
  hasPassword: r.passwordHash !== null,
});

const DUPLICATE_CODE = 'この従業員コードは既に使われています';

/**
 * 従業員マスタ。PIN・パスワードはハッシュだけを保存し、画面には返さない。
 * 管理画面に入れなくならないよう、ログインできる管理者が0人になる変更は拒否する。
 */
export class EmployeeService {
  constructor(private readonly db: Db) {}

  list(): Employee[] {
    return this.db.select().from(employees).orderBy(asc(employees.code)).all().map(toEmployee);
  }

  async create(data: CreateData, actor: Actor): Promise<Employee> {
    if (data.role === 'admin' && !data.password) {
      throw new AppError(400, 'invalid_request', '管理者には管理画面用のパスワードが必要です');
    }
    const pinHash = await hashSecret(data.pin);
    const passwordHash = data.role === 'admin' && data.password ? await hashSecret(data.password) : null;
    const { pin: _pin, password: _password, ...values } = data;
    try {
      const row = this.db.insert(employees).values({ ...values, pinHash, passwordHash }).returning().get();
      writeAudit(this.db, {
        action: 'employee.created',
        employeeId: actor.employeeId,
        targetType: 'employee',
        targetId: row.id,
        after: toEmployee(row),
      });
      return toEmployee(row);
    } catch (err) {
      rethrowUnique(err, DUPLICATE_CODE);
    }
  }

  async update(id: number, data: UpdateData, actor: Actor): Promise<Employee> {
    // ハッシュ計算は重いのでトランザクションの外で済ませる
    const pinHash = data.pin ? await hashSecret(data.pin) : undefined;
    const newPasswordHash = data.password ? await hashSecret(data.password) : undefined;

    try {
      return immediateTransaction(this.db, (tx) => {
        const before = tx.select().from(employees).where(eq(employees.id, id)).get();
        if (!before) throw notFound('従業員が見つかりません');

        // 管理者以外にはパスワードを持たせない
        const passwordHash =
          data.role !== 'admin' ? null : newPasswordHash !== undefined ? newPasswordHash : before.passwordHash;
        if (data.role === 'admin' && passwordHash === null) {
          throw new AppError(400, 'invalid_request', '管理者には管理画面用のパスワードが必要です');
        }

        const { pin: _pin, password: _password, ...values } = data;
        const row = tx
          .update(employees)
          .set({ ...values, passwordHash, ...(pinHash ? { pinHash } : {}), updatedAt: Date.now() })
          .where(eq(employees.id, id))
          .returning()
          .get()!;

        const admins = tx
          .select({ id: employees.id })
          .from(employees)
          .where(and(eq(employees.role, 'admin'), eq(employees.enabled, true), isNotNull(employees.passwordHash)))
          .all();
        if (admins.length === 0) {
          throw new AppError(400, 'invalid_request', '管理画面にログインできる管理者が0人になるため変更できません');
        }

        // 無効化・権限変更・PIN/パスワード変更をしたら、既存のログインを切る
        const credentialsChanged = !!pinHash || newPasswordHash !== undefined;
        if (!row.enabled || row.role !== before.role || credentialsChanged) {
          tx.update(staffSessions).set({ revokedAt: Date.now() }).where(eq(staffSessions.employeeId, id)).run();
        }

        writeAudit(tx, {
          action: 'employee.updated',
          employeeId: actor.employeeId,
          targetType: 'employee',
          targetId: id,
          before: toEmployee(before),
          after: { ...toEmployee(row), pinChanged: !!pinHash, passwordChanged: newPasswordHash !== undefined },
        });
        return toEmployee(row);
      });
    } catch (err) {
      rethrowUnique(err, DUPLICATE_CODE);
    }
  }
}
