import { count, eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { AppConfig } from './config.js';
import type { Db } from './db/client.js';
import { employees, registers } from './db/schema.js';
import { hashSecret } from './lib/crypto.js';
import { writeAudit } from './modules/audit/service.js';

/**
 * 初回起動時の初期データ。従業員が1人もいなければ、環境変数の値で管理者を作る。
 * 管理者の PIN はパスワードとは別に後から管理画面で設定する想定で、仮に 0000 を入れる。
 */
export async function bootstrap(db: Db, config: AppConfig, log: FastifyBaseLogger) {
  const [{ n }] = db.select({ n: count() }).from(employees).all() as [{ n: number }];
  if (n === 0) {
    if (!config.initialAdmin) {
      log.warn('従業員が未登録です。INITIAL_ADMIN_CODE と INITIAL_ADMIN_PASSWORD を設定して再起動してください');
    } else {
      const { code, password, name } = config.initialAdmin;
      const admin = db
        .insert(employees)
        .values({
          code,
          name,
          role: 'admin',
          pinHash: await hashSecret('0000'),
          passwordHash: await hashSecret(password),
          canManualDiscount: true,
        })
        .returning()
        .get();
      writeAudit(db, { action: 'employee.bootstrap_admin', targetType: 'employee', targetId: admin.id });
      log.info({ code }, '初期管理者を作成しました');
    }
  } else if (config.adminPasswordReset) {
    await resetAdminPassword(db, config, log);
  }

  const [{ r }] = db.select({ r: count() }).from(registers).all() as [{ r: number }];
  if (r === 0) {
    db.insert(registers)
      .values([
        { number: 1, name: 'レジ1', numberingMode: 'auto' },
        { number: 2, name: 'レジ2', numberingMode: 'auto' },
      ])
      .run();
  }
}

/**
 * 管理者のパスワードを忘れたときの復旧（手順書「管理者パスワードを忘れたとき」）。
 * ADMIN_PASSWORD_RESET=1 と INITIAL_ADMIN_CODE / INITIAL_ADMIN_PASSWORD を設定して起動すると、
 * その従業員コードの管理者のパスワードを設定し直し、有効にする（いなければ管理者として作る）。
 * 起動のたびに上書きしないよう、使い終わったら ADMIN_PASSWORD_RESET を外す。
 */
async function resetAdminPassword(db: Db, config: AppConfig, log: FastifyBaseLogger) {
  if (!config.initialAdmin) {
    log.error('ADMIN_PASSWORD_RESET には INITIAL_ADMIN_CODE と INITIAL_ADMIN_PASSWORD が必要です');
    return;
  }
  const { code, password, name } = config.initialAdmin;
  const passwordHash = await hashSecret(password);
  const existing = db.select().from(employees).where(eq(employees.code, code)).get();
  if (existing) {
    db.update(employees)
      .set({ role: 'admin', enabled: true, passwordHash, updatedAt: Date.now() })
      .where(eq(employees.id, existing.id))
      .run();
    writeAudit(db, { action: 'employee.admin_password_reset', targetType: 'employee', targetId: existing.id });
  } else {
    const created = db
      .insert(employees)
      .values({ code, name, role: 'admin', pinHash: await hashSecret('0000'), passwordHash, canManualDiscount: true })
      .returning()
      .get();
    writeAudit(db, { action: 'employee.admin_password_reset', targetType: 'employee', targetId: created.id });
  }
  log.warn({ code }, '管理者のパスワードを設定し直しました。.env の ADMIN_PASSWORD_RESET を外して再起動してください');
}
