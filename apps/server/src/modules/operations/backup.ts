import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import type Database from 'better-sqlite3';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../../db/client.js';
import { storeSettings } from '../../db/schema.js';

export interface BackupOptions {
  /** バックアップを置くディレクトリ（Docker では /backups をホストにマウントする） */
  dir: string;
  /** 残す世代数。古いものから消す */
  keep: number;
}

export interface BackupFile {
  name: string;
  size: number;
  createdAt: number;
}

const PREFIX = 'pos-';
const SUFFIX = '.sqlite';

const stamp = (ms: number) => {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
};

/**
 * DB のバックアップ（要件4.5）。SQLite のオンラインバックアップを使うので、営業中（WAL で書き込み中）でも
 * 一貫した状態のファイルが作れる。ファイル名は `pos-<店舗コード>-<営業日>-<日時>.sqlite`。
 * 復元手順は docs/setup-guide.md の「バックアップと復元」。
 */
export class BackupService {
  constructor(
    private readonly db: Db,
    /** オンラインバックアップに使う生の SQLite 接続 */
    private readonly sqlite: Database.Database,
    private readonly options: BackupOptions,
    private readonly log: FastifyBaseLogger,
  ) {}

  get dir() {
    return this.options.dir;
  }

  async run(label: string, now = Date.now()): Promise<BackupFile> {
    fs.mkdirSync(this.options.dir, { recursive: true });
    const { storeCode } = this.db.select({ storeCode: storeSettings.storeCode }).from(storeSettings).where(eq(storeSettings.id, 1)).get()!;
    const safeLabel = label.replace(/[^0-9A-Za-z-]/g, '');
    const name = `${PREFIX}${storeCode}-${safeLabel}-${stamp(now)}${SUFFIX}`;
    const dest = path.join(this.options.dir, name);
    // 書き込み途中のファイルを完成品と取り違えないよう、一時名で作ってから名前を変える
    const tmp = `${dest}.part`;
    await this.sqlite.backup(tmp);
    fs.renameSync(tmp, dest);
    const removed = this.prune();
    this.log.info({ file: name, removed }, 'バックアップを作成しました');
    const stat = fs.statSync(dest);
    return { name, size: stat.size, createdAt: stat.mtimeMs };
  }

  /** 世代管理: 新しいものから keep 個を残して消す */
  private prune(): string[] {
    const files = this.list();
    const old = files.slice(this.options.keep);
    for (const f of old) fs.rmSync(path.join(this.options.dir, f.name), { force: true });
    return old.map((f) => f.name);
  }

  /** 新しい順 */
  list(): BackupFile[] {
    if (!fs.existsSync(this.options.dir)) return [];
    return fs
      .readdirSync(this.options.dir)
      .filter((n) => n.startsWith(PREFIX) && n.endsWith(SUFFIX))
      .map((name) => {
        const stat = fs.statSync(path.join(this.options.dir, name));
        return { name, size: stat.size, createdAt: stat.mtimeMs };
      })
      .sort((a, b) => b.createdAt - a.createdAt || b.name.localeCompare(a.name));
  }
}
