import { eq } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { businessDays, storeSettings } from '../../db/schema.js';
import { AppError } from '../../lib/errors.js';

/**
 * 営業日（YYYY-MM-DD）。切替時刻より前の時刻は前日の営業日とする（例: 4時切替なら 2時は前日）。
 * 時刻はサーバーのローカル時刻（コンテナの TZ=Asia/Tokyo）で判定する。
 */
export function businessDateOf(now: number, cutoverMinutes: number): string {
  const d = new Date(now - cutoverMinutes * 60_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** レシート番号などに使う YYYYMMDD */
export const compactDate = (date: string) => date.replaceAll('-', '');

export type BusinessDayRow = typeof businessDays.$inferSelect;

/** 現在の営業日を返す。まだ無ければ開始する（トランザクション内で呼ぶ） */
export function currentBusinessDay(tx: Db, now = Date.now()): BusinessDayRow {
  const { businessDayCutoverMinutes } = tx
    .select({ businessDayCutoverMinutes: storeSettings.businessDayCutoverMinutes })
    .from(storeSettings)
    .where(eq(storeSettings.id, 1))
    .get()!;
  const date = businessDateOf(now, businessDayCutoverMinutes);
  const existing = tx.select().from(businessDays).where(eq(businessDays.date, date)).get();
  if (existing) {
    if (existing.status === 'closed') {
      throw new AppError(409, 'business_day_closed', `${date} の営業は終了（閉店）しています`);
    }
    return existing;
  }
  return tx.insert(businessDays).values({ date, openedAt: now }).returning().get();
}
