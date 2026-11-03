/**
 * RFC 4180 形式の CSV。Excel で開けるよう出力は BOM 付き UTF-8・CRLF。
 * 入力は BOM の有無・LF/CRLF どちらも受け付ける。
 */

const BOM = '﻿';

export function toCsv(rows: readonly (readonly (string | number | boolean | null | undefined)[])[]): string {
  const escape = (value: string | number | boolean | null | undefined) => {
    const s = value === null || value === undefined ? '' : String(value);
    return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  return BOM + rows.map((row) => row.map(escape).join(',')).join('\r\n') + '\r\n';
}

export function parseCsv(text: string): string[][] {
  const src = text.startsWith(BOM) ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"' && field === '') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  if (inQuotes) throw new Error('CSV の引用符（"）が閉じられていません');
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // 空行は無視する
  return rows.filter((r) => r.some((v) => v.trim() !== ''));
}
