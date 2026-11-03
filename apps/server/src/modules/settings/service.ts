import { asc, eq } from 'drizzle-orm';
import type { Register, registerInput, StoreSettings } from '@pos/shared';
import type { z } from 'zod';
import { immediateTransaction, type Db } from '../../db/client.js';
import { registers, storeSettings } from '../../db/schema.js';
import { rethrowUnique } from '../../lib/db-errors.js';
import { notFound } from '../../lib/errors.js';
import { writeAudit } from '../audit/service.js';
import type { Actor } from '../masters/service.js';

type RegisterData = z.output<typeof registerInput>;
type RegisterRow = typeof registers.$inferSelect;

const toRegister = (r: RegisterRow): Register => ({
  id: r.id,
  number: r.number,
  name: r.name,
  numberingMode: r.numberingMode,
  enabled: r.enabled,
});

/** 端末側（レジ・キッチン・カスタマー）が使う設定。店舗情報の一部と運用設定 */
export type DeviceSettings = Pick<
  StoreSettings,
  | 'storeName'
  | 'customerMessage'
  | 'kitchenWarnSeconds'
  | 'kitchenAlertSeconds'
  | 'ticketNumberMin'
  | 'ticketNumberMax'
  | 'autoNumberMin'
  | 'autoNumberMax'
>;

/** 店舗・運用設定（1行）とレジの設定 */
export class SettingsService {
  constructor(private readonly db: Db) {}

  getStoreSettings(): StoreSettings {
    const { id: _id, updatedAt: _u, ...settings } = this.db
      .select()
      .from(storeSettings)
      .where(eq(storeSettings.id, 1))
      .get()!;
    return settings;
  }

  getDeviceSettings(): DeviceSettings {
    const s = this.getStoreSettings();
    return {
      storeName: s.storeName,
      customerMessage: s.customerMessage,
      kitchenWarnSeconds: s.kitchenWarnSeconds,
      kitchenAlertSeconds: s.kitchenAlertSeconds,
      ticketNumberMin: s.ticketNumberMin,
      ticketNumberMax: s.ticketNumberMax,
      autoNumberMin: s.autoNumberMin,
      autoNumberMax: s.autoNumberMax,
    };
  }

  updateStoreSettings(data: StoreSettings, actor: Actor): StoreSettings {
    return immediateTransaction(this.db, (tx) => {
      const before = this.getStoreSettings();
      tx.update(storeSettings).set({ ...data, updatedAt: Date.now() }).where(eq(storeSettings.id, 1)).run();
      const after = this.getStoreSettings();
      // 変わった項目だけ記録する
      const changed = (Object.keys(after) as (keyof StoreSettings)[]).filter((k) => before[k] !== after[k]);
      if (changed.length > 0) {
        writeAudit(tx, {
          action: 'settings.updated',
          employeeId: actor.employeeId,
          targetType: 'store_settings',
          before: Object.fromEntries(changed.map((k) => [k, before[k]])),
          after: Object.fromEntries(changed.map((k) => [k, after[k]])),
        });
      }
      return after;
    });
  }

  listRegisters(): Register[] {
    return this.db.select().from(registers).orderBy(asc(registers.number)).all().map(toRegister);
  }

  createRegister(data: RegisterData, actor: Actor): Register {
    try {
      const row = this.db.insert(registers).values(data).returning().get();
      writeAudit(this.db, { action: 'register.created', employeeId: actor.employeeId, targetType: 'register', targetId: row.id, after: data });
      return toRegister(row);
    } catch (err) {
      rethrowUnique(err, 'このレジ番号は既に使われています');
    }
  }

  updateRegister(id: number, data: RegisterData, actor: Actor): Register {
    try {
      return immediateTransaction(this.db, (tx) => {
        const before = tx.select().from(registers).where(eq(registers.id, id)).get();
        if (!before) throw notFound('レジが見つかりません');
        const row = tx
          .update(registers)
          .set({ ...data, updatedAt: Date.now() })
          .where(eq(registers.id, id))
          .returning()
          .get()!;
        writeAudit(tx, {
          action: 'register.updated',
          employeeId: actor.employeeId,
          targetType: 'register',
          targetId: id,
          before: toRegister(before),
          after: toRegister(row),
        });
        return toRegister(row);
      });
    } catch (err) {
      rethrowUnique(err, 'このレジ番号は既に使われています');
    }
  }
}
