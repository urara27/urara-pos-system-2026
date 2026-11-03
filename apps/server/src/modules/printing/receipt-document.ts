import { asc, eq, inArray } from 'drizzle-orm';
import type { ReceiptDocument, TaxRate } from '@pos/shared';
import type { Db } from '../../db/client.js';
import {
  employees,
  orders,
  registers,
  storeSettings,
  transactionDiscounts,
  transactionLineOptions,
  transactionLines,
  transactions,
  transactionTaxSummaries,
} from '../../db/schema.js';
import { notFound } from '../../lib/errors.js';

/**
 * 取引からレシートの内容を組み立てる。明細・金額・税額は会計確定時に保存した値（スナップショット）を使う。
 * 店舗名・登録番号などの店舗情報は、出力時点の設定を使う。
 */
export function buildReceiptDocument(db: Db, transactionId: number, opts: { reprint: boolean }): ReceiptDocument {
  const row = db
    .select({ t: transactions, register: registers, staffName: employees.name })
    .from(transactions)
    .innerJoin(registers, eq(registers.id, transactions.registerId))
    .innerJoin(employees, eq(employees.id, transactions.employeeId))
    .where(eq(transactions.id, transactionId))
    .get();
  if (!row) throw notFound('取引が見つかりません');
  const { t } = row;

  const store = db.select().from(storeSettings).where(eq(storeSettings.id, 1)).get()!;
  // 返金・変更のレシートには元の販売の注文番号とレシート番号を載せる
  const saleId = t.originalTransactionId ?? t.id;
  const order = db.select().from(orders).where(eq(orders.transactionId, saleId)).get();
  const original =
    t.originalTransactionId === null
      ? undefined
      : db.select({ receiptNumber: transactions.receiptNumber }).from(transactions).where(eq(transactions.id, t.originalTransactionId)).get();
  const isSale = t.kind === 'sale';
  const lines = db
    .select()
    .from(transactionLines)
    .where(eq(transactionLines.transactionId, t.id))
    .orderBy(asc(transactionLines.lineNo))
    .all();
  const lineIds = lines.map((l) => l.id);
  const options = lineIds.length
    ? db.select().from(transactionLineOptions).where(inArray(transactionLineOptions.lineId, lineIds)).orderBy(asc(transactionLineOptions.id)).all()
    : [];
  const discounts = db
    .select()
    .from(transactionDiscounts)
    .where(eq(transactionDiscounts.transactionId, t.id))
    .orderBy(asc(transactionDiscounts.seq))
    .all();
  const taxes = db.select().from(transactionTaxSummaries).where(eq(transactionTaxSummaries.transactionId, t.id)).all();

  const docLines = lines.map((l) => {
    const opts = options.filter((o) => o.lineId === l.id);
    return {
      name: l.productName,
      quantity: l.quantity,
      unitPrice: l.unitPrice + opts.reduce((s, o) => s + o.priceDelta, 0),
      taxRate: l.taxRate,
      // 返金・変更では、返品した明細を「お支払いいただいた額」（割引の按分後）で載せる
      gross: isSale ? l.grossAmount : l.netAmount,
      options: opts.map((o) => ({ name: o.optionName, priceDelta: o.priceDelta })),
      discounts: isSale ? discounts.filter((d) => d.lineId === l.id).map((d) => ({ name: d.name, amount: d.amount })) : [],
    };
  });

  return {
    kind: t.kind,
    originalReceiptNumber: original?.receiptNumber ?? null,
    reprint: opts.reprint,
    store: {
      code: store.storeCode,
      name: store.storeName,
      address: store.address,
      phone: store.phone,
      registrationNumber: store.invoiceRegistrationNumber,
      header: store.receiptHeader,
      footer: store.receiptFooter,
    },
    issuedAt: t.createdAt,
    register: { number: row.register.number, name: row.register.name },
    staffName: row.staffName,
    receiptNumber: t.receiptNumber,
    diningOption: t.diningOption,
    order: order ? { number: order.orderNumber, numberingMode: order.numberingMode } : null,
    lines: docLines,
    subtotal: isSale ? t.subtotal : docLines.reduce((s, l) => s + l.gross, 0),
    orderDiscounts: isSale ? discounts.filter((d) => d.scope === 'order').map((d) => ({ name: d.name, amount: d.amount })) : [],
    total: t.total,
    taxes: taxes
      .map((x) => ({ taxRate: x.taxRate as TaxRate, taxableAmount: x.taxableAmount, taxAmount: x.taxAmount }))
      .sort((a, b) => b.taxRate - a.taxRate),
    payment: { method: t.paymentMethod, cashReceived: t.cashReceived, change: t.change },
  };
}
