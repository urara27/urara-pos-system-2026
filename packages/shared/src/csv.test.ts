import { describe, expect, it } from 'vitest';
import { parseCsv, toCsv } from './csv.js';

describe('CSV', () => {
  it('BOM 付き・CRLF で出力し、カンマ・改行・引用符をエスケープする', () => {
    const csv = toCsv([
      ['名前', '備考'],
      ['ハンバーガー', 'a,b'],
      ['ポテト', '"L"サイズ\n大盛り'],
      [1, null],
    ]);
    expect(csv).toBe('﻿名前,備考\r\nハンバーガー,"a,b"\r\nポテト,"""L""サイズ\n大盛り"\r\n1,\r\n');
  });

  it('出力したものを読み戻すと元に戻る', () => {
    const rows = [
      ['id', 'name', 'note'],
      ['1', 'チーズ, バーガー', 'line1\r\nline2'],
      ['', '"quoted"', ''],
    ];
    expect(parseCsv(toCsv(rows))).toEqual(rows);
  });

  it('BOM なし・LF・末尾改行なし・空行を受け付ける', () => {
    expect(parseCsv('a,b\n\n1,2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('閉じていない引用符はエラー', () => {
    expect(() => parseCsv('a,"b\n1,2')).toThrow();
  });
});
