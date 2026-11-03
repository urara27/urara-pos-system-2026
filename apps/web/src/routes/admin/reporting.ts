import { useEffect, useState } from 'react';
import { STAFF_SESSION_HEADER, type ReportCsvKind, type StoreSettings } from '@pos/shared';
import { keys, session } from '../../lib/storage';
import { adminApi } from './common';

const pad = (n: number) => String(n).padStart(2, '0');
export const isoDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** 営業日（切替時刻より前は前日）。サーバーと同じ考え方 */
export function businessDate(now: number, cutoverMinutes: number) {
  return isoDate(new Date(now - cutoverMinutes * 60_000));
}

export function shiftDate(date: string, days: number) {
  const d = new Date(`${date}T12:00:00`);
  d.setDate(d.getDate() + days);
  return isoDate(d);
}

/** 今日の営業日（設定の切替時刻を使う） */
export function useBusinessToday() {
  const [today, setToday] = useState<string | null>(null);
  useEffect(() => {
    adminApi<{ settings: StoreSettings }>('/api/admin/settings')
      .then((res) => setToday(businessDate(Date.now(), res.settings.businessDayCutoverMinutes)))
      .catch(() => setToday(businessDate(Date.now(), 240)));
  }, []);
  return today;
}

/** 売上の CSV を保存する（認証ヘッダーが要るので fetch してから保存） */
export async function downloadReportCsv(kind: ReportCsvKind, from: string, to: string) {
  const res = await fetch(`/api/admin/reports/${kind}.csv?from=${from}&to=${to}`, {
    headers: { [STAFF_SESSION_HEADER]: session.get(keys.adminSession) ?? '' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const name = /filename="(.+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? `${kind}.csv`;
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
