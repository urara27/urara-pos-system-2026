import type { Db } from '../../db/client.js';
import { auditLogs } from '../../db/schema.js';

export interface AuditEntry {
  action: string;
  employeeId?: number | null;
  deviceId?: number | null;
  targetType?: string;
  targetId?: string | number;
  before?: unknown;
  after?: unknown;
}

/** 返金・割引・価格変更・設定変更などの操作ログを記録する */
export function writeAudit(db: Db, entry: AuditEntry) {
  db.insert(auditLogs)
    .values({
      action: entry.action,
      employeeId: entry.employeeId ?? null,
      deviceId: entry.deviceId ?? null,
      targetType: entry.targetType ?? null,
      targetId: entry.targetId === undefined ? null : String(entry.targetId),
      before: entry.before ?? null,
      after: entry.after ?? null,
    })
    .run();
}
