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
  const order = db.select().from(orders).where(eq(orders.transactionId, t.id)).get();
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

  return {
    kind: t.kind === 'refund' ? 'refund' : 'sale',
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
    lines: lines.map((l) => {
      const opts = options.filter((o) => o.lineId === l.id);
      return {
        name: l.productName,
        quantity: l.quantity,
        unitPrice: l.unitPrice + opts.reduce((s, o) => s + o.priceDelta, 0),
        taxRate: l.taxRate,
        gross: l.grossAmount,
        options: opts.map((o) => ({ name: o.optionName, priceDelta: o.priceDelta })),
        discounts: discounts.filter((d) => d.lineId === l.id).map((d) => ({ name: d.name, amount: d.amount })),
      };
    }),
    subtotal: t.subtotal,
    orderDiscounts: discounts.filter((d) => d.scope === 'order').map((d) => ({ name: d.name, amount: d.amount })),
    total: t.total,
    taxes: taxes
      .map((x) => ({ taxRate: x.taxRate as TaxRate, taxableAmount: x.taxableAmount, taxAmount: x.taxAmount }))
      .sort((a, b) => b.taxRate - a.taxRate),
    payment: { method: t.paymentMethod, cashReceived: t.cashReceived, change: t.change },
  };
}
