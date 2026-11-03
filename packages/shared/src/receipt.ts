import type { DiningOption, NumberingMode, PaymentMethod } from './domain.js';
import { DINING_OPTION_LABELS, formatOrderNumber } from './orders.js';
import type { TaxSummary } from './pricing.js';

/**
 * レシート（適格簡易請求書）。
 * サーバーが取引から ReceiptDocument を作り、buildReceiptLayout で「行」に並べる。
 * 画面プレビュー・PDF・（将来の）ESC/POS 印刷はすべて同じ行から描くので、内容がずれない。
 *
 * 適格簡易請求書の記載事項（インボイス制度）
 * 1. 適格請求書発行事業者の氏名又は名称及び登録番号 → 店舗名・登録番号
 * 2. 取引年月日 → 日時
 * 3. 取引内容（軽減税率の対象品目である旨） → 明細と「※」印
 * 4. 税率ごとに区分した対価の額（税込）の合計額 → 「10%対象」「8%対象」
 * 5. 税率ごとの消費税額等又は適用税率 → 「内消費税」（両方を載せる）
 */

export interface ReceiptLine {
  name: string;
  quantity: number;
  /** オプション加算込みの1個あたりの税込単価 */
  unitPrice: number;
  taxRate: number;
  /** 割引前の金額 */
  gross: number;
  options: { name: string; priceDelta: number }[];
  discounts: { name: string; amount: number }[];
}

export interface ReceiptDocument {
  kind: 'sale' | 'refund';
  /** 再発行なら「再発行」と明記する */
  reprint: boolean;
  store: {
    code: string;
    name: string;
    address: string;
    phone: string;
    registrationNumber: string;
    header: string;
    footer: string;
  };
  issuedAt: number;
  register: { number: number; name: string };
  staffName: string;
  receiptNumber: string;
  diningOption: DiningOption;
  order: { number: number; numberingMode: NumberingMode } | null;
  lines: ReceiptLine[];
  subtotal: number;
  orderDiscounts: { name: string; amount: number }[];
  total: number;
  /** 税率の高い順 */
  taxes: TaxSummary[];
  payment: { method: PaymentMethod; cashReceived: number | null; change: number | null };
}

// ───────── 行 ─────────

export type ReceiptSize = 'normal' | 'large' | 'xlarge';

export type ReceiptRow =
  | { type: 'text'; text: string; align?: 'left' | 'center' | 'right'; size?: ReceiptSize; bold?: boolean; indent?: number }
  | { type: 'pair'; left: string; right: string; size?: ReceiptSize; bold?: boolean; indent?: number }
  | { type: 'rule'; style?: 'solid' | 'double' }
  | { type: 'space' };

export const yenText = (n: number) => `${n < 0 ? '-' : ''}¥${Math.abs(n).toLocaleString('ja-JP')}`;

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = { cash: '現金', paypay: 'PayPay' };

/** 日時は店舗の所在地（日本）の時刻で印字する */
export function formatReceiptDate(ms: number) {
  const parts = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(ms);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}年${get('month')}月${get('day')}日 ${get('hour')}:${get('minute')}`;
}

/** 軽減税率の対象を示す印 */
export const REDUCED_MARK = '※';

export function buildReceiptLayout(doc: ReceiptDocument): ReceiptRow[] {
  const rows: ReceiptRow[] = [];
  const text = (t: string, opts: Omit<Extract<ReceiptRow, { type: 'text' }>, 'type' | 'text'> = {}) =>
    rows.push({ type: 'text', text: t, ...opts });
  const pair = (left: string, right: string, opts: Omit<Extract<ReceiptRow, { type: 'pair' }>, 'type' | 'left' | 'right'> = {}) =>
    rows.push({ type: 'pair', left, right, ...opts });
  const multiline = (s: string, align: 'left' | 'center' = 'center') =>
    s
      .split(/\r?\n/)
      .filter((l) => l.trim() !== '')
      .forEach((l) => text(l, { align }));

  if (doc.reprint) text('【再発行】', { align: 'center', size: 'large', bold: true });
  if (doc.kind === 'refund') text('【返金】', { align: 'center', size: 'large', bold: true });
  multiline(doc.store.header);
  text(doc.store.name || '（店舗名未設定）', { align: 'center', size: 'large', bold: true });
  if (doc.store.address) text(doc.store.address, { align: 'center' });
  if (doc.store.phone) text(`TEL ${doc.store.phone}`, { align: 'center' });
  text(`登録番号 ${doc.store.registrationNumber || '（未設定）'}`, { align: 'center' });
  rows.push({ type: 'rule' });

  text(formatReceiptDate(doc.issuedAt));
  pair(`レジ ${doc.register.number}（${doc.register.name}）`, `担当 ${doc.staffName}`);
  pair('レシート番号', doc.receiptNumber);
  pair('ご利用', DINING_OPTION_LABELS[doc.diningOption]);
  rows.push({ type: 'rule' });

  for (const line of doc.lines) {
    const mark = line.taxRate === 8 ? REDUCED_MARK : '';
    pair(`${line.name}${mark}`, yenText(line.gross));
    for (const o of line.options) {
      text(o.priceDelta > 0 ? `・${o.name}（+${yenText(o.priceDelta)}）` : `・${o.name}`, { indent: 1 });
    }
    if (line.quantity > 1) text(`${yenText(line.unitPrice)} × ${line.quantity}`, { indent: 1 });
    for (const d of line.discounts) pair(`割引 ${d.name}`, yenText(-d.amount), { indent: 1 });
  }
  rows.push({ type: 'rule' });

  const lineDiscounts = doc.lines.reduce((s, l) => s + l.discounts.reduce((a, d) => a + d.amount, 0), 0);
  pair(`小計（${doc.lines.reduce((s, l) => s + l.quantity, 0)}点）`, yenText(doc.subtotal - lineDiscounts));
  for (const d of doc.orderDiscounts) pair(`割引 ${d.name}`, yenText(-d.amount));
  pair('合計', yenText(doc.total), { size: 'large', bold: true });
  // 税率ごとの対象額（税込）と消費税額
  for (const t of doc.taxes) {
    pair(`${t.taxRate}%対象`, yenText(t.taxableAmount), { indent: 1 });
    pair(`内消費税(${t.taxRate}%)`, yenText(t.taxAmount), { indent: 2 });
  }
  rows.push({ type: 'rule' });

  pair('お支払', PAYMENT_METHOD_LABELS[doc.payment.method]);
  if (doc.payment.method === 'cash') {
    pair('お預り', yenText(doc.payment.cashReceived ?? 0));
    pair('お釣り', yenText(doc.payment.change ?? 0));
  }
  if (doc.lines.some((l) => l.taxRate === 8)) {
    rows.push({ type: 'space' });
    text(`${REDUCED_MARK}は軽減税率（8%）対象商品です`);
  }

  if (doc.order) {
    rows.push({ type: 'rule', style: 'double' });
    text('注文番号', { align: 'center' });
    // 自動採番ではこの番号でお呼び出しするので大きく
    text(formatOrderNumber(doc.order.number), {
      align: 'center',
      size: doc.order.numberingMode === 'auto' ? 'xlarge' : 'large',
      bold: true,
    });
    rows.push({ type: 'rule', style: 'double' });
  }

  if (doc.store.footer) {
    rows.push({ type: 'space' });
    multiline(doc.store.footer);
  }
  if (doc.reprint) {
    rows.push({ type: 'space' });
    text('※この控えは再発行したものです', { align: 'center' });
  }
  return rows;
}

// ───────── テキスト出力（等幅・ESC/POS の土台） ─────────

/** 等幅表示での幅。全角は2、半角は1 */
export function displayWidth(s: string) {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    const half = c <= 0x7e || (c >= 0xff61 && c <= 0xff9f) || c === 0xa5;
    w += half ? 1 : 2;
  }
  return w;
}

/** 幅に収まるよう末尾を切る */
function truncate(s: string, width: number) {
  let out = '';
  let w = 0;
  for (const ch of s) {
    const cw = displayWidth(ch);
    if (w + cw > width) break;
    out += ch;
    w += cw;
  }
  return out;
}

/**
 * 等幅のテキストにする。80mm 用紙は半角48桁。large / xlarge は倍角（幅2倍）として扱う。
 * 将来の ESC/POS ドライバーはこの考え方で倍角コマンドを出す。
 */
export function renderReceiptText(rows: ReceiptRow[], columns = 48): string {
  const out: string[] = [];
  for (const row of rows) {
    if (row.type === 'space') {
      out.push('');
      continue;
    }
    if (row.type === 'rule') {
      out.push((row.style === 'double' ? '=' : '-').repeat(columns));
      continue;
    }
    const scale = row.size && row.size !== 'normal' ? 2 : 1;
    const cols = Math.floor(columns / scale);
    const indent = ' '.repeat((row.indent ?? 0) * 2);
    if (row.type === 'pair') {
      const right = row.right;
      const leftMax = cols - displayWidth(right) - 1;
      const left = truncate(indent + row.left, Math.max(0, leftMax));
      const gap = cols - displayWidth(left) - displayWidth(right);
      out.push(left + ' '.repeat(Math.max(1, gap)) + right);
      continue;
    }
    const t = truncate(indent + row.text, cols);
    const pad = cols - displayWidth(t);
    if (row.align === 'center') out.push(' '.repeat(Math.floor(pad / 2)) + t);
    else if (row.align === 'right') out.push(' '.repeat(pad) + t);
    else out.push(t);
  }
  return out.join('\n');
}
