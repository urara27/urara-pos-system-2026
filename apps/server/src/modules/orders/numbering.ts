import { eq, inArray } from 'drizzle-orm';
import { formatOrderNumber, type StoreSettings } from '@pos/shared';
import type { Db } from '../../db/client.js';
import { counters, orders } from '../../db/schema.js';
import { AppError } from '../../lib/errors.js';
import { compactDate } from '../business-day/service.js';

// 採番はすべて会計確定の immediateTransaction（BEGIN IMMEDIATE）の中で呼ぶ。
// 書き込みロックを先に取るので、複数レジが同時に会計しても番号は重複しない。
// さらに orders の部分一意インデックス（未完了の注文番号）で DB 側でも二重に防ぐ。

function readCounter(tx: Db, key: string): number | null {
  return tx.select({ value: counters.value }).from(counters).where(eq(counters.key, key)).get()?.value ?? null;
}

function writeCounter(tx: Db, key: string, value: number) {
  tx.insert(counters)
    .values({ key, value })
    .onConflictDoUpdate({ target: counters.key, set: { value, updatedAt: Date.now() } })
    .run();
}

/** 未完了（受付済み・呼び出し中）の注文が使っている番号 */
export function activeOrderNumbers(tx: Db): Set<number> {
  return new Set(
    tx
      .select({ n: orders.orderNumber })
      .from(orders)
      .where(inArray(orders.status, ['accepted', 'calling']))
      .all()
      .map((r) => r.n),
  );
}

type NumberSettings = Pick<
  StoreSettings,
  'autoNumberMin' | 'autoNumberMax' | 'autoNumberResetDaily' | 'ticketNumberMin' | 'ticketNumberMax'
>;

/**
 * 自動採番: 前回の次から順に、未完了の注文で使用中の番号を飛ばして採る。上限の次は下限に戻る。
 * 「営業日ごとに振り直す」設定なら、営業日ごとに別のカウンタを使う（＝その日は下限から始まる）。
 */
export function issueAutoNumber(tx: Db, settings: NumberSettings, businessDate: string): number {
  const { autoNumberMin: min, autoNumberMax: max } = settings;
  const key = settings.autoNumberResetDaily ? `auto_order:${businessDate}` : 'auto_order';
  const last = readCounter(tx, key);
  const used = activeOrderNumbers(tx);
  const size = max - min + 1;
  let candidate = last === null || last < min || last >= max ? min : last + 1;
  for (let i = 0; i < size; i++) {
    if (!used.has(candidate)) {
      writeCounter(tx, key, candidate);
      return candidate;
    }
    candidate = candidate >= max ? min : candidate + 1;
  }
  throw new AppError(409, 'no_order_number', '空いている注文番号がありません。受け渡し済みにしてください');
}

/** 番号札モード: レジで入力した番号を検証する */
export function validateTicketNumber(tx: Db, settings: NumberSettings, ticketNumber: number | undefined): number {
  if (ticketNumber === undefined) {
    throw new AppError(400, 'ticket_required', '番号札の番号を入力してください');
  }
  if (ticketNumber < settings.ticketNumberMin || ticketNumber > settings.ticketNumberMax) {
    throw new AppError(
      400,
      'ticket_out_of_range',
      `番号札は ${formatOrderNumber(settings.ticketNumberMin)}〜${formatOrderNumber(settings.ticketNumberMax)} です`,
    );
  }
  if (activeOrderNumbers(tx).has(ticketNumber)) {
    throw new AppError(
      409,
      'ticket_in_use',
      `番号札 ${formatOrderNumber(ticketNumber)} は未完了の注文で使用中です。別の番号札を渡してください`,
    );
  }
  return ticketNumber;
}

/** レシート番号: `営業日-レジ番号-連番`（例: 20261103-1-0001）。営業日をまたいでも一意 */
export function issueReceiptNumber(tx: Db, businessDate: string, registerNumber: number): string {
  const key = `receipt:${businessDate}:${registerNumber}`;
  const next = (readCounter(tx, key) ?? 0) + 1;
  writeCounter(tx, key, next);
  return `${compactDate(businessDate)}-${registerNumber}-${String(next).padStart(4, '0')}`;
}
