import { z } from 'zod';
import type { DiningOption, PaymentMethod } from './domain.js';
import type { RegisterSessionSummary } from './orders.js';
import type { TaxSummary } from './pricing.js';

/**
 * 売上の集計（要件3.8）。定義は次のとおりで、テストで固定する。
 *
 * - 対象: 指定した営業日（範囲）に記録したすべての取引（販売・返金・商品変更）
 * - 金額: 割引を引いた後の税込金額。返金はマイナスで、**返金した営業日・レジ・時刻**に計上する
 * - 総売上 = 販売の合計 / 返金・変更 = 返金・変更の取引の合計（返金はマイナス）/ 純売上 = 総売上 + 返金・変更
 * - 客数 = 販売の件数 − そのうち全額返金された件数（確認事項 Q10: 人数入力なし・会計件数）
 * - 客単価 = 純売上 ÷ 客数（円未満切り捨て）
 * - 割引額 = 販売で適用した割引の合計 − 返金で戻した割引の合計
 * - 商品別・カテゴリ別の数量は、返品した数量を差し引く
 * 商品別・カテゴリ別・時間帯別・支払方法別・店内/持ち帰り別・レジ別の金額の合計は、すべて純売上と一致する。
 */

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日付は YYYY-MM-DD で指定してください');

export const reportQuery = z
  .object({ from: date, to: date.optional() })
  .transform((q) => ({ from: q.from, to: q.to ?? q.from }))
  .refine((q) => q.from <= q.to, { message: '開始日が終了日より後になっています' });
export type ReportQuery = z.input<typeof reportQuery>;

export interface SalesSummary {
  grossSales: number;
  refunds: number;
  netSales: number;
  saleCount: number;
  /** 全額返金された販売の件数 */
  cancelledCount: number;
  customerCount: number;
  averagePerCustomer: number;
  discountTotal: number;
  refundCount: number;
}

export interface AmountRow {
  amount: number;
  /** 件数（販売の件数） */
  count: number;
}

export interface SalesReport {
  storeCode: string;
  from: string;
  to: string;
  summary: SalesSummary;
  products: { productId: number | null; name: string; category: string; quantity: number; amount: number }[];
  categories: { name: string; quantity: number; amount: number }[];
  /** 営業日の切替時刻から順に並べた24時間 */
  hourly: ({ hour: number } & AmountRow)[];
  payments: ({ method: PaymentMethod } & AmountRow)[];
  dining: ({ diningOption: DiningOption } & AmountRow)[];
  taxes: TaxSummary[];
  discounts: { name: string; manual: boolean; count: number; amount: number }[];
  registers: ({ registerNumber: number; name: string; cash: number; paypay: number } & AmountRow)[];
  refunds: {
    id: number;
    kind: 'refund' | 'exchange';
    createdAt: number;
    receiptNumber: string;
    originalReceiptNumber: string | null;
    registerNumber: number;
    employeeName: string;
    approverName: string | null;
    reason: string | null;
    amount: number;
    paymentMethod: PaymentMethod;
  }[];
}

export interface RegisterSettlementRow extends RegisterSessionSummary {
  businessDate: string;
  deviceName: string;
  openedByName: string;
  closedByName: string | null;
}

// ───────── 操作ログ ─────────

export const AUDIT_CATEGORIES = {
  refund: '返金・変更',
  discount: '割引',
  price: '価格変更',
  master: 'マスタ・設定',
  register: 'レジ開設・閉設',
  device: '端末・ログイン',
  receipt: 'レシート',
} as const;
export type AuditCategory = keyof typeof AUDIT_CATEGORIES;

export const AUDIT_ACTION_LABELS: Record<string, string> = {
  'refund.created': '返金',
  'exchange.created': '商品変更',
  'discount.applied': '割引の適用',
  'product.price_changed': '価格変更',
  'product.created': '商品の追加',
  'product.updated': '商品の変更',
  'product.sold_out_changed': '売切の切替',
  'category.created': 'カテゴリの追加',
  'category.updated': 'カテゴリの変更',
  'option_group.created': 'オプションの追加',
  'option_group.updated': 'オプションの変更',
  'discount.created': '割引の追加',
  'discount.updated': '割引の変更',
  'employee.created': '従業員の追加',
  'employee.updated': '従業員の変更',
  'employee.bootstrap_admin': '初期管理者の作成',
  'register.created': 'レジの追加',
  'register.updated': 'レジの変更',
  'register.opened': 'レジの開設',
  'register.closed': 'レジの閉設',
  'settings.updated': '店舗・運用設定の変更',
  'device.pairing_code_issued': 'ペアリングコードの発行',
  'device.paired': '端末の登録',
  'device.updated': '端末の変更',
  'admin.login': '管理画面へのログイン',
  'receipt.reprinted': 'レシートの再発行',
};

/** 操作の分類（絞り込み用）。action の前方一致で決める */
export function auditCategoryOf(action: string): AuditCategory {
  if (action.startsWith('refund.') || action.startsWith('exchange.')) return 'refund';
  if (action === 'discount.applied') return 'discount';
  if (action === 'product.price_changed') return 'price';
  if (action === 'register.opened' || action === 'register.closed') return 'register';
  if (action.startsWith('device.') || action === 'admin.login') return 'device';
  if (action.startsWith('receipt.')) return 'receipt';
  return 'master';
}

export const auditLogQuery = z.object({
  from: z.coerce.number().int().optional(),
  to: z.coerce.number().int().optional(),
  category: z.enum(Object.keys(AUDIT_CATEGORIES) as [AuditCategory, ...AuditCategory[]]).optional(),
  /** これより古いものを取る（ページ送り） */
  beforeId: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type AuditLogQuery = z.input<typeof auditLogQuery>;

export interface AuditLogEntry {
  id: number;
  createdAt: number;
  action: string;
  actionLabel: string;
  category: AuditCategory;
  employeeName: string | null;
  deviceName: string | null;
  targetType: string | null;
  targetId: string | null;
  before: unknown;
  after: unknown;
}

/** CSV で出せる表 */
export const REPORT_CSV_KINDS = [
  'summary',
  'products',
  'categories',
  'hourly',
  'payments',
  'dining',
  'taxes',
  'discounts',
  'registers',
  'refunds',
  'transactions',
  'settlements',
] as const;
export type ReportCsvKind = (typeof REPORT_CSV_KINDS)[number];
