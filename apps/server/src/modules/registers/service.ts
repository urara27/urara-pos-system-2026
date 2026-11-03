import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { RegisterSessionSummary, RegisterStatus } from '@pos/shared';
import { immediateTransaction, type Db } from '../../db/client.js';
import { devices, employees, registerSessions, registers, transactions } from '../../db/schema.js';
import { AppError, notFound } from '../../lib/errors.js';
import { writeAudit } from '../audit/service.js';
import { currentBusinessDay } from '../business-day/service.js';

type SessionRow = typeof registerSessions.$inferSelect;

/**
 * レジの開設（釣銭準備金）・閉設（現金の実査と過不足）。
 * 同じレジを2台で同時に開設できない（register_sessions の部分一意インデックス）。
 */
export class RegisterService {
  constructor(private readonly db: Db) {}

  list(deviceId: number): RegisterStatus[] {
    const open = this.db
      .select({
        session: registerSessions,
        deviceName: devices.name,
        openedByName: employees.name,
      })
      .from(registerSessions)
      .innerJoin(devices, eq(devices.id, registerSessions.deviceId))
      .innerJoin(employees, eq(employees.id, registerSessions.openedByEmployeeId))
      .where(isNull(registerSessions.closedAt))
      .all();
    return this.db
      .select()
      .from(registers)
      .where(eq(registers.enabled, true))
      .orderBy(asc(registers.number))
      .all()
      .map((r) => {
        const s = open.find((o) => o.session.registerId === r.id);
        return {
          id: r.id,
          number: r.number,
          name: r.name,
          numberingMode: r.numberingMode,
          openSession: s
            ? {
                id: s.session.id,
                deviceId: s.session.deviceId,
                deviceName: s.deviceName,
                openedAt: s.session.openedAt,
                openedByName: s.openedByName,
                mine: s.session.deviceId === deviceId,
              }
            : null,
        };
      });
  }

  open(input: { registerId: number; openingCash: number }, deviceId: number, employeeId: number, now = Date.now()) {
    return immediateTransaction(this.db, (tx) => {
      const register = tx.select().from(registers).where(eq(registers.id, input.registerId)).get();
      if (!register || !register.enabled) throw notFound('レジが見つかりません');
      const current = tx
        .select()
        .from(registerSessions)
        .where(and(eq(registerSessions.registerId, register.id), isNull(registerSessions.closedAt)))
        .get();
      if (current) {
        if (current.deviceId === deviceId) return current; // 同じ端末なら開設済みのものを再開
        throw new AppError(409, 'register_in_use', `${register.name}は別の端末で開設中です`);
      }
      const day = currentBusinessDay(tx, now);
      const session = tx
        .insert(registerSessions)
        .values({
          registerId: register.id,
          deviceId,
          businessDayId: day.id,
          openedByEmployeeId: employeeId,
          openedAt: now,
          openingCash: input.openingCash,
        })
        .returning()
        .get();
      writeAudit(tx, {
        action: 'register.opened',
        employeeId,
        deviceId,
        targetType: 'register_session',
        targetId: session.id,
        after: { registerId: register.id, openingCash: input.openingCash },
      });
      return session;
    });
  }

  /** この端末で開設中のセッションを取り出す（会計・閉設の前提チェック） */
  requireOwnOpenSession(tx: Db, sessionId: number, deviceId: number): SessionRow {
    const session = tx.select().from(registerSessions).where(eq(registerSessions.id, sessionId)).get();
    if (!session || session.closedAt !== null) {
      throw new AppError(409, 'register_not_open', 'レジが開設されていません。開設してから会計してください');
    }
    if (session.deviceId !== deviceId) {
      throw new AppError(403, 'forbidden', 'このレジは別の端末で開設されています');
    }
    return session;
  }

  summary(sessionId: number): RegisterSessionSummary {
    const row = this.db
      .select({ session: registerSessions, register: registers })
      .from(registerSessions)
      .innerJoin(registers, eq(registers.id, registerSessions.registerId))
      .where(eq(registerSessions.id, sessionId))
      .get();
    if (!row) throw notFound('レジの開設記録が見つかりません');
    const { session, register } = row;
    const totals = this.db
      .select({
        cash: sql<number>`coalesce(sum(case when ${transactions.paymentMethod} = 'cash' then ${transactions.total} else 0 end), 0)`,
        paypay: sql<number>`coalesce(sum(case when ${transactions.paymentMethod} = 'paypay' then ${transactions.total} else 0 end), 0)`,
        count: sql<number>`count(*)`,
      })
      .from(transactions)
      .where(eq(transactions.registerSessionId, session.id))
      .get()!;
    const expectedCash = session.openingCash + totals.cash;
    return {
      sessionId: session.id,
      registerId: register.id,
      registerNumber: register.number,
      registerName: register.name,
      openedAt: session.openedAt,
      closedAt: session.closedAt,
      openingCash: session.openingCash,
      cashSales: totals.cash,
      paypaySales: totals.paypay,
      transactionCount: totals.count,
      expectedCash: session.expectedCash ?? expectedCash,
      countedCash: session.countedCash,
      cashDifference: session.cashDifference,
    };
  }

  close(sessionId: number, countedCash: number, deviceId: number, employeeId: number, now = Date.now()) {
    immediateTransaction(this.db, (tx) => {
      this.requireOwnOpenSession(tx, sessionId, deviceId);
      const { expectedCash } = this.summary(sessionId);
      const cashDifference = countedCash - expectedCash;
      tx.update(registerSessions)
        .set({ closedAt: now, closedByEmployeeId: employeeId, countedCash, expectedCash, cashDifference })
        .where(eq(registerSessions.id, sessionId))
        .run();
      writeAudit(tx, {
        action: 'register.closed',
        employeeId,
        deviceId,
        targetType: 'register_session',
        targetId: sessionId,
        after: { countedCash, expectedCash, cashDifference },
      });
    });
    return this.summary(sessionId);
  }
}
