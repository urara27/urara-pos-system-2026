import os from 'node:os';
import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

/**
 * E2E テスト。本番と同じく「ビルドした Web をサーバーが配信する」形で、
 * 毎回まっさらな一時 DB を使って起動する。
 */
const PORT = 3210;
const root = import.meta.dirname;
const dbPath = path.join(os.tmpdir(), `pos-e2e-${Date.now()}.sqlite`);
const backupDir = path.join(os.tmpdir(), `pos-e2e-backups-${Date.now()}`);

export const E2E_ADMIN = { code: '1', password: 'e2e-admin-password', pin: '0000' };

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    ...devices['Desktop Chrome'],
    // レジは iPad 横向きを想定
    viewport: { width: 1180, height: 820 },
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'corepack pnpm --filter @pos/web build && corepack pnpm --filter @pos/server exec tsx src/main.ts',
    url: `http://127.0.0.1:${PORT}/api/system/health`,
    timeout: 120_000,
    reuseExistingServer: false,
    env: {
      PORT: String(PORT),
      HOST: '127.0.0.1',
      DATABASE_PATH: dbPath,
      MIGRATIONS_DIR: path.join(root, 'apps/server/drizzle'),
      WEB_DIST_DIR: path.join(root, 'apps/web/dist'),
      BACKUP_DIR: backupDir,
      INITIAL_ADMIN_CODE: E2E_ADMIN.code,
      INITIAL_ADMIN_PASSWORD: E2E_ADMIN.password,
      LOG_LEVEL: 'warn',
      TZ: 'Asia/Tokyo',
    },
  },
});
