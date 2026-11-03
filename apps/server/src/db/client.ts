import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema.js';

export type Db = BetterSQLite3Database<typeof schema>;

export interface DatabaseHandle {
  db: Db;
  sqlite: Database.Database;
  close: () => void;
}

/**
 * DB を開き、マイグレーションを適用する。`:memory:` はテスト用。
 * WAL・外部キー・ロック待ちを有効にする。
 */
export function openDatabase(databasePath: string, migrationsDir: string): DatabaseHandle {
  if (databasePath !== ':memory:') {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  }
  const sqlite = new Database(databasePath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  sqlite.pragma('synchronous = NORMAL');

  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: migrationsDir });
  db.insert(schema.storeSettings).values({ id: 1 }).onConflictDoNothing().run();

  return { db, sqlite, close: () => sqlite.close() };
}

/**
 * 書き込みロックを先に取る（BEGIN IMMEDIATE）トランザクション。
 * 採番など、読んでから書く処理は必ずこれを使う。
 */
export function immediateTransaction<T>(db: Db, fn: (tx: Db) => T): T {
  return db.transaction((tx) => fn(tx as unknown as Db), { behavior: 'immediate' });
}
