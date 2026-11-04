import path from 'node:path';

export interface AppConfig {
  host: string;
  port: number;
  databasePath: string;
  migrationsDir: string;
  /** ビルド済み Web アプリのディレクトリ。未設定なら API のみ配信 */
  webDistDir: string | null;
  /** バックアップの置き場所と残す世代数 */
  backup: { dir: string; keep: number };
  initialAdmin: { code: string; password: string; name: string } | null;
  /** 管理者パスワードの復旧（INITIAL_ADMIN_* の値で設定し直す） */
  adminPasswordReset: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const code = env.INITIAL_ADMIN_CODE?.trim();
  const password = env.INITIAL_ADMIN_PASSWORD;
  return {
    host: env.HOST ?? '0.0.0.0',
    port: Number(env.PORT ?? 3000),
    databasePath: path.resolve(env.DATABASE_PATH ?? './data/pos.sqlite'),
    migrationsDir: path.resolve(env.MIGRATIONS_DIR ?? './drizzle'),
    webDistDir: env.WEB_DIST_DIR ? path.resolve(env.WEB_DIST_DIR) : null,
    backup: { dir: path.resolve(env.BACKUP_DIR ?? './data/backups'), keep: Math.max(1, Number(env.BACKUP_KEEP ?? 30)) },
    initialAdmin:
      code && password ? { code, password, name: env.INITIAL_ADMIN_NAME ?? '管理者' } : null,
    adminPasswordReset: env.ADMIN_PASSWORD_RESET === '1',
  };
}
