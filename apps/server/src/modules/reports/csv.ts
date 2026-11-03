import {
  DINING_OPTION_LABELS,
  PAYMENT_METHOD_LABELS,
  toCsv,
  type ReportCsvKind,
} from '@pos/shared';
import type { ReportService } from './service.js';

const KIND_LABELS = { sale: '販売', refund: '返金', exchange: '商品変更' } as const;

/** 日時は日本時間の「YYYY/MM/DD HH:mm:ss」 */
const dateTime = (ms: number) =>
  new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(ms);

type Cell = string | number | boolean | null | undefined;

/**
 * 売上の CSV（BOM 付き UTF-8・Excel で開ける）。
 * 多店舗で集めても見分けられるよう、すべての行の先頭に店舗コードと期間を入れる（要件4.1）。
 */
export function buildReportCsv(reports: ReportService, kind: ReportCsvKind, from: string, to: string): string {
  const report = reports.salesReport(from, to);
  const prefix = [report.storeCode, from, to];
  const table = (header: string[], rows: Cell[][]) => toCsv([['店舗コード', '開始日', '終了日', ...header], ...rows.map((r) => [...prefix, ...r])]);
  const s = report.summary;

  switch (kind) {
    case 'summary':
      return table(
        ['総売上', '返金・変更', '純売上', '販売件数', '全額返金件数', '客数', '客単価', '割引額', '返金・変更件数'],
        [[s.grossSales, s.refunds, s.netSales, s.saleCount, s.cancelledCount, s.customerCount, s.averagePerCustomer, s.discountTotal, s.refundCount]],
      );
    case 'products':
      return table(['商品ID', '商品名', 'カテゴリ', '数量', '金額'], report.products.map((p) => [p.productId, p.name, p.category, p.quantity, p.amount]));
    case 'categories':
      return table(['カテゴリ', '数量', '金額'], report.categories.map((c) => [c.name, c.quantity, c.amount]));
    case 'hourly':
      return table(['時', '金額', '販売件数'], report.hourly.map((h) => [h.hour, h.amount, h.count]));
    case 'payments':
      return table(['支払方法', '金額', '販売件数'], report.payments.map((p) => [PAYMENT_METHOD_LABELS[p.method], p.amount, p.count]));
    case 'dining':
      return table(['店内／持ち帰り', '金額', '販売件数'], report.dining.map((d) => [DINING_OPTION_LABELS[d.diningOption], d.amount, d.count]));
    case 'taxes':
      return table(['税率', '対象額（税込）', '消費税額'], report.taxes.map((t) => [`${t.taxRate}%`, t.taxableAmount, t.taxAmount]));
    case 'discounts':
      return table(['割引', '手入力', '件数', '割引額'], report.discounts.map((d) => [d.name, d.manual ? 1 : 0, d.count, d.amount]));
    case 'registers':
      return table(['レジ番号', 'レジ名', '金額', '販売件数', '現金', 'PayPay'], report.registers.map((r) => [r.registerNumber, r.name, r.amount, r.count, r.cash, r.paypay]));
    case 'refunds':
      return table(
        ['日時', '種別', 'レシート番号', '元のレシート番号', 'レジ番号', '担当', '承認者', '理由', '金額', '支払方法'],
        report.refunds.map((r) => [
          dateTime(r.createdAt),
          KIND_LABELS[r.kind],
          r.receiptNumber,
          r.originalReceiptNumber,
          r.registerNumber,
          r.employeeName,
          r.approverName,
          r.reason,
          r.amount,
          PAYMENT_METHOD_LABELS[r.paymentMethod],
        ]),
      );
    case 'transactions':
      return table(
        ['営業日', '日時', '種別', 'レシート番号', '元の取引ID', 'レジ番号', '担当', '店内／持ち帰り', '支払方法', '小計', '割引額', '合計', '預り金', '釣銭'],
        reports.transactionsIn(from, to).map(({ t, registerNumber, employeeName, date }) => [
          date,
          dateTime(t.createdAt),
          KIND_LABELS[t.kind],
          t.receiptNumber,
          t.originalTransactionId,
          registerNumber,
          employeeName,
          DINING_OPTION_LABELS[t.diningOption],
          PAYMENT_METHOD_LABELS[t.paymentMethod],
          t.subtotal,
          t.discountTotal,
          t.total,
          t.cashReceived,
          t.change,
        ]),
      );
    case 'settlements':
      return table(
        ['営業日', 'レジ番号', 'レジ名', '端末', '開設', '開設者', '閉設', '閉設者', '釣銭準備金', '現金売上', 'PayPay売上', '理論在高', '実査', '過不足'],
        reports.settlements(from, to).map((s) => [
          s.businessDate,
          s.registerNumber,
          s.registerName,
          s.deviceName,
          dateTime(s.openedAt),
          s.openedByName,
          s.closedAt ? dateTime(s.closedAt) : '',
          s.closedByName,
          s.openingCash,
          s.cashSales,
          s.paypaySales,
          s.expectedCash,
          s.countedCash,
          s.cashDifference,
        ]),
      );
  }
}

export const csvFileName = (storeCode: string, kind: ReportCsvKind, from: string, to: string) =>
  `${storeCode}-${kind}-${from}${from === to ? '' : `_${to}`}.csv`;
