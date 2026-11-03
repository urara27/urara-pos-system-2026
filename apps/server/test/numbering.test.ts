import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type DatabaseHandle } from '../src/db/client.js';
import { businessDateOf } from '../src/modules/business-day/service.js';
import { issueAutoNumber, issueReceiptNumber } from '../src/modules/orders/numbering.js';

let h: DatabaseHandle;
beforeEach(() => {
  h = openDatabase(':memory:', path.resolve(import.meta.dirname, '../drizzle'));
});
afterEach(() => h.close());

const range = { autoNumberMin: 100, autoNumberMax: 999, ticketNumberMin: 1, ticketNumberMax: 99 };

describe('営業日', () => {
  const at = (iso: string) => new Date(iso).getTime();
  it('切替時刻より前は前日の営業日', () => {
    // 4時切替（240分）
    expect(businessDateOf(at('2026-11-04T03:59:00'), 240)).toBe('2026-11-03');
    expect(businessDateOf(at('2026-11-04T04:00:00'), 240)).toBe('2026-11-04');
    expect(businessDateOf(at('2026-11-04T23:30:00'), 240)).toBe('2026-11-04');
  });
  it('0時切替なら暦日どおり', () => {
    expect(businessDateOf(at('2026-11-04T00:00:00'), 0)).toBe('2026-11-04');
  });
});

describe('自動採番の振り直し', () => {
  it('営業日ごとに振り直す設定では、営業日が変わると下限から始まる', () => {
    const s = { ...range, autoNumberResetDaily: true };
    expect(issueAutoNumber(h.db, s, '2026-11-03')).toBe(100);
    expect(issueAutoNumber(h.db, s, '2026-11-03')).toBe(101);
    expect(issueAutoNumber(h.db, s, '2026-11-04')).toBe(100);
  });

  it('振り直さない設定では、前日の続きから採番する', () => {
    const s = { ...range, autoNumberResetDaily: false };
    expect(issueAutoNumber(h.db, s, '2026-11-03')).toBe(100);
    expect(issueAutoNumber(h.db, s, '2026-11-03')).toBe(101);
    expect(issueAutoNumber(h.db, s, '2026-11-04')).toBe(102);
  });

  it('範囲を変えて前回の番号が範囲外になったら下限から', () => {
    const s = { ...range, autoNumberResetDaily: false };
    issueAutoNumber(h.db, s, '2026-11-03');
    expect(issueAutoNumber(h.db, { ...s, autoNumberMin: 500, autoNumberMax: 599 }, '2026-11-03')).toBe(500);
  });
});

describe('レシート番号', () => {
  it('営業日×レジごとの連番で、営業日をまたいでも一意', () => {
    expect(issueReceiptNumber(h.db, '2026-11-03', 1)).toBe('20261103-1-0001');
    expect(issueReceiptNumber(h.db, '2026-11-03', 1)).toBe('20261103-1-0002');
    expect(issueReceiptNumber(h.db, '2026-11-03', 2)).toBe('20261103-2-0001');
    expect(issueReceiptNumber(h.db, '2026-11-04', 1)).toBe('20261104-1-0001');
  });
});
