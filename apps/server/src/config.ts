import path from 'node:path';

export interface AppConfig {
  host: string;
  port: number;
  databasePath: string;
  migrationsDir: string;
  /** ビルド済み Web アプリのディレクトリ。未設定なら API のみ配信 */
  webDistDir: string | null;
  initialAdmin: { code: string; password: string; name: string } | null;
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
    initialAdmin:
      code && password ? { code, password, name: env.INITIAL_ADMIN_NAME ?? '管理者' } : null,
  };
}
