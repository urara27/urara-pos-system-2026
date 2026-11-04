import { and, desc, eq, isNull, lt } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../../db/client.js';
import { businessDays, devices, employees, registers, registerSessions, storeSettings } from '../../db/schema.js';
import { AppError } from '../../lib/errors.js';
import { writeAudit } from '../audit/service.js';
import { businessDateOf } from '../business-day/service.js';
import type { BackupFile, BackupService } from './backup.js';

export interface BusinessDayRow {
  date: string;
  status: 'open' | 'closed';
  openedAt: number;
  closedAt: number | null;
  closedBy: 'manual' | 'auto' | null;
  closedByName: string | null;
}

export interface OperationsStatus {
  /** 今の時刻で決まる営業日 */
  currentDate: string;
  /** その営業日の記録（取引もレジ開設もまだ無ければ null） */
  current: BusinessDayRow | null;
  openRegisters: { registerName: string; deviceName: string; openedAt: number; openedByName: string }[];
  recentDays: BusinessDayRow[];
  backups: BackupFile[];
  backupDir: string;
}

/**
 * 営業日の終了（閉店操作）とバックアップ（確認事項 Q9・要件4.5）。
 * - 閉店操作: 全レジが閉設済みであることを確かめて営業日を閉じ、バックアップを取る
 * - 閉店を忘れたとき: 営業日の切替時刻を過ぎたら前の営業日を自動で閉じ、バックアップを取る
 * - 自動採番は営業日ごとのカウンタなので、営業日が変われば自動的に開始番号から振り直される
 */
export class OperationsService {
  constructor(
    private readonly db: Db,
    private readonly backups: BackupService,
    private readonly log: FastifyBaseLogger,
  ) {}

  private currentDate(now: number) {
    const { businessDayCutoverMinutes } = this.db.select().from(storeSettings).where(eq(storeSettings.id, 1)).get()!;
    return businessDateOf(now, businessDayCutoverMinutes);
  }

  private toRow(d: typeof businessDays.$inferSelect, closedByName: string | null): BusinessDayRow {
    return { date: d.date, status: d.status, openedAt: d.openedAt, closedAt: d.closedAt, closedBy: d.closedBy, closedByName };
  }

  private openRegisters() {
    return this.db
      .select({ registerName: registers.name, deviceName: devices.name, openedAt: registerSessions.openedAt, openedByName: employees.name })
      .from(registerSessions)
      .innerJoin(registers, eq(registers.id, registerSessions.registerId))
      .innerJoin(devices, eq(devices.id, registerSessions.deviceId))
      .innerJoin(employees, eq(employees.id, registerSessions.openedByEmployeeId))
      .where(isNull(registerSessions.closedAt))
      .all();
  }

  status(now = Date.now()): OperationsStatus {
    const currentDate = this.currentDate(now);
    const days = this.db
      .select({ d: businessDays, closedByName: employees.name })
      .from(businessDays)
      .leftJoin(employees, eq(employees.id, businessDays.closedByEmployeeId))
      .orderBy(desc(businessDays.date))
      .limit(14)
      .all()
      .map((r) => this.toRow(r.d, r.closedByName));
    return {
      currentDate,
      current: days.find((d) => d.date === currentDate) ?? null,
      openRegisters: this.openRegisters(),
      recentDays: days,
      backups: this.backups.list(),
      backupDir: this.backups.dir,
    };
  }

  /** 閉店操作。開設中のレジがあれば閉じない */
  async close(employeeId: number, now = Date.now()) {
    const date = this.currentDate(now);
    const open = this.openRegisters();
    if (open.length > 0) {
      throw new AppError(409, 'registers_open', `開設中のレジがあります（${open.map((r) => r.registerName).join('・')}）。すべて閉設してから閉店してください`);
    }
    const day = this.db.select().from(businessDays).where(eq(businessDays.date, date)).get();
    if (day?.status === 'closed') throw new AppError(409, 'already_closed', `${date} は既に閉店しています`);
    if (day) {
      this.db
        .update(businessDays)
        .set({ status: 'closed', closedAt: now, closedBy: 'manual', closedByEmployeeId: employeeId })
        .where(eq(businessDays.id, day.id))
        .run();
    } else {
      // 取引の無い日に閉店した場合も記録を残す
      this.db.insert(businessDays).values({ date, status: 'closed', openedAt: now, closedAt: now, closedBy: 'manual', closedByEmployeeId: employeeId }).run();
    }
    writeAudit(this.db, { action: 'business_day.closed', employeeId, targetType: 'business_day', targetId: date, after: { closedBy: 'manual' } });
    const backup = await this.backupAfterClose(date, employeeId, now);
    return { date, backup };
  }

  /** 誤って閉店したときに再開する（同じ営業日のうちだけ） */
  reopen(employeeId: number, now = Date.now()) {
    const date = this.currentDate(now);
    const day = this.db.select().from(businessDays).where(eq(businessDays.date, date)).get();
    if (!day || day.status !== 'closed') throw new AppError(409, 'not_closed', `${date} は閉店していません`);
    this.db
      .update(businessDays)
      .set({ status: 'open', closedAt: null, closedBy: null, closedByEmployeeId: null })
      .where(eq(businessDays.id, day.id))
      .run();
    writeAudit(this.db, { action: 'business_day.reopened', employeeId, targetType: 'business_day', targetId: date });
    return { date };
  }

  /** 閉店を忘れた営業日を自動で閉じる（切替時刻を過ぎたもの）。起動時と1分ごとに呼ぶ */
  async autoClose(now = Date.now()): Promise<string[]> {
    const date = this.currentDate(now);
    const stale = this.db
      .select()
      .from(businessDays)
      .where(and(eq(businessDays.status, 'open'), lt(businessDays.date, date)))
      .all();
    const closed: string[] = [];
    for (const day of stale) {
      this.db.update(businessDays).set({ status: 'closed', closedAt: now, closedBy: 'auto' }).where(eq(businessDays.id, day.id)).run();
      writeAudit(this.db, { action: 'business_day.closed', targetType: 'business_day', targetId: day.date, after: { closedBy: 'auto' } });
      const open = this.openRegisters();
      if (open.length > 0) {
        this.log.warn({ date: day.date, registers: open.map((r) => r.registerName) }, '閉設していないレジがあるまま営業日を自動で閉じました');
      }
      await this.backupAfterClose(day.date, null, now);
      closed.push(day.date);
    }
    return closed;
  }

  /** 手動のバックアップ */
  async backupNow(employeeId: number, now = Date.now()) {
    const file = await this.backups.run(`${this.currentDate(now)}-manual`, now);
    writeAudit(this.db, { action: 'backup.created', employeeId, after: { file: file.name, trigger: 'manual' } });
    return file;
  }

  /** 閉店時のバックアップ。失敗しても閉店は取り消さない（ログと操作ログに残す） */
  private async backupAfterClose(date: string, employeeId: number | null, now: number): Promise<BackupFile | null> {
    try {
      const file = await this.backups.run(date, now);
      writeAudit(this.db, { action: 'backup.created', employeeId, after: { file: file.name, trigger: 'close' } });
      return file;
    } catch (err) {
      this.log.error({ err, date }, 'バックアップに失敗しました');
      writeAudit(this.db, { action: 'backup.failed', employeeId, after: { date, message: (err as Error).message } });
      return null;
    }
  }
}

/** 自動閉店の見回り。1分ごと（起動直後にも1回） */
export function startAutoClose(ops: OperationsService, log: FastifyBaseLogger) {
  const tick = () => {
    ops
      .autoClose()
      .then((dates) => dates.length > 0 && log.info({ dates }, '閉店していなかった営業日を自動で閉じました'))
      .catch((err: unknown) => log.error({ err }, '自動閉店に失敗しました'));
  };
  tick();
  const timer = setInterval(tick, 60_000);
  timer.unref();
  return () => clearInterval(timer);
}
