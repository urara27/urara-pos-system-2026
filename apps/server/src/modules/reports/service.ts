import { and, asc, desc, eq, gte, inArray, lt, lte, type SQL } from 'drizzle-orm';
import {
  AUDIT_ACTION_LABELS,
  auditCategoryOf,
  DINING_OPTIONS,
  PAYMENT_METHODS,
  type AuditLogEntry,
  type auditLogQuery,
  type RegisterSettlementRow,
  type SalesReport,
  type TaxRate,
} from '@pos/shared';
import type { z } from 'zod';
import type { Db } from '../../db/client.js';
import {
  auditLogs,
  businessDays,
  devices,
  employees,
  registers,
  registerSessions,
  storeSettings,
  transactionDiscounts,
  transactionLines,
  transactions,
  transactionTaxSummaries,
} from '../../db/schema.js';
import type { RegisterService } from '../registers/service.js';

type AuditQuery = z.output<typeof auditLogQuery>;
type TxRow = typeof transactions.$inferSelect;

/** グループごとに足し上げる小さな道具 */
function groupSum<K, V>(items: V[], key: (v: V) => K, init: () => Record<string, number>, add: (acc: Record<string, number>, v: V) => void) {
  const map = new Map<K, Record<string, number>>();
  for (const v of items) {
    const k = key(v);
    const acc = map.get(k) ?? init();
    add(acc, v);
    map.set(k, acc);
  }
  return map;
}

/** 時刻の「時」（サーバーのローカル時刻 = TZ Asia/Tokyo） */
const hourOf = (ms: number) => new Date(ms).getHours();

/**
 * 売上確認・レジ精算・操作ログ（要件3.8）。集計の定義は packages/shared/src/reports.ts の冒頭を参照。
 */
export class ReportService {
  constructor(
    private readonly db: Db,
    private readonly registersService: RegisterService,
  ) {}

  private daysBetween(from: string, to: string) {
    return this.db
      .select()
      .from(businessDays)
      .where(and(gte(businessDays.date, from), lte(businessDays.date, to)))
      .orderBy(asc(businessDays.date))
      .all();
  }

  private storeSettings() {
    return this.db.select().from(storeSettings).where(eq(storeSettings.id, 1)).get()!;
  }

  /** 範囲内の取引（担当者・レジ・営業日つき） */
  transactionsIn(from: string, to: string) {
    const dayIds = this.daysBetween(from, to).map((d) => d.id);
    if (dayIds.length === 0) return [];
    return this.db
      .select({ t: transactions, registerNumber: registers.number, registerName: registers.name, employeeName: employees.name, date: businessDays.date })
      .from(transactions)
      .innerJoin(registers, eq(registers.id, transactions.registerId))
      .innerJoin(employees, eq(employees.id, transactions.employeeId))
      .innerJoin(businessDays, eq(businessDays.id, transactions.businessDayId))
      .where(inArray(transactions.businessDayId, dayIds))
      .orderBy(asc(transactions.createdAt), asc(transactions.id))
      .all();
  }

  /** 販売のうち、返金（いつ行ったかを問わない）で全数量が戻ったもの */
  private fullyRefundedSaleIds(sales: TxRow[]): Set<number> {
    const saleIds = sales.map((s) => s.id);
    if (saleIds.length === 0) return new Set();
    const related = this.db
      .select({ id: transactions.id, originalId: transactions.originalTransactionId })
      .from(transactions)
      .where(inArray(transactions.originalTransactionId, saleIds))
      .all();
    if (related.length === 0) return new Set();
    const saleOf = new Map<number, number>([...saleIds.map((id) => [id, id] as const), ...related.map((r) => [r.id, r.originalId!] as const)]);
    const lines = this.db.select().from(transactionLines).where(inArray(transactionLines.transactionId, [...saleOf.keys()])).all();
    const remaining = new Map<number, number>();
    for (const l of lines) {
      const sale = saleOf.get(l.transactionId)!;
      const delta = l.originalLineId !== null ? -l.quantity : l.netAmount >= 0 ? l.quantity : 0;
      remaining.set(sale, (remaining.get(sale) ?? 0) + delta);
    }
    return new Set([...new Set(related.map((r) => r.originalId!))].filter((id) => (remaining.get(id) ?? 0) <= 0));
  }

  salesReport(from: string, to: string): SalesReport {
    const settings = this.storeSettings();
    const rows = this.transactionsIn(from, to);
    const txs = rows.map((r) => r.t);
    const sales = txs.filter((t) => t.kind === 'sale');
    const others = txs.filter((t) => t.kind !== 'sale');
    const txIds = txs.map((t) => t.id);
    const lines = txIds.length ? this.db.select().from(transactionLines).where(inArray(transactionLines.transactionId, txIds)).all() : [];
    const discounts = txIds.length ? this.db.select().from(transactionDiscounts).where(inArray(transactionDiscounts.transactionId, txIds)).all() : [];
    const taxes = txIds.length ? this.db.select().from(transactionTaxSummaries).where(inArray(transactionTaxSummaries.transactionId, txIds)).all() : [];

    const grossSales = sales.reduce((s, t) => s + t.total, 0);
    const refunds = others.reduce((s, t) => s + t.total, 0);
    const netSales = grossSales + refunds;
    const cancelled = this.fullyRefundedSaleIds(sales);
    const customerCount = sales.length - cancelled.size;
    const isSale = new Set(sales.map((s) => s.id));

    // 商品別・カテゴリ別（返品した数量は差し引く）
    const qtyOf = (l: (typeof lines)[number]) => (l.originalLineId !== null ? -l.quantity : l.quantity);
    const products = [
      ...groupSum(
        lines,
        (l) => `${l.productId ?? ''}\u0000${l.productName}\u0000${l.categoryName}`,
        () => ({ quantity: 0, amount: 0 }),
        (acc, l) => {
          acc.quantity! += qtyOf(l);
          acc.amount! += l.netAmount;
        },
      ),
    ]
      .map(([k, v]) => {
        const [id, name, category] = k.split('\u0000');
        return { productId: id ? Number(id) : null, name: name!, category: category!, quantity: v.quantity!, amount: v.amount! };
      })
      .sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name, 'ja'));
    const categories = [
      ...groupSum(
        products,
        (p) => p.category,
        () => ({ quantity: 0, amount: 0 }),
        (acc, p) => {
          acc.quantity! += p.quantity;
          acc.amount! += p.amount;
        },
      ),
    ]
      .map(([name, v]) => ({ name, quantity: v.quantity!, amount: v.amount! }))
      .sort((a, b) => b.amount - a.amount);

    // 時間帯別: 営業日の切替時刻の時から24時間を順に
    const startHour = Math.floor(settings.businessDayCutoverMinutes / 60);
    const byHour = groupSum(txs, (t) => hourOf(t.createdAt), () => ({ amount: 0, count: 0 }), (acc, t) => {
      acc.amount! += t.total;
      if (t.kind === 'sale') acc.count! += 1;
    });
    const hourly = Array.from({ length: 24 }, (_, i) => {
      const hour = (startHour + i) % 24;
      const v = byHour.get(hour);
      return { hour, amount: v?.amount ?? 0, count: v?.count ?? 0 };
    });

    const byKey = <K extends string>(keys: readonly K[], keyOf: (t: TxRow) => K) =>
      keys.map((k) => ({
        key: k,
        amount: txs.filter((t) => keyOf(t) === k).reduce((s, t) => s + t.total, 0),
        count: sales.filter((t) => keyOf(t) === k).length,
      }));

    const registerRows = groupSum(rows, (r) => r.registerNumber, () => ({ amount: 0, count: 0, cash: 0, paypay: 0 }), (acc, r) => {
      acc.amount! += r.t.total;
      if (r.t.kind === 'sale') acc.count! += 1;
      acc[r.t.paymentMethod]! += r.t.total;
    });

    // 割引: 販売で適用した割引（名称・手入力ごと）。返金で戻した割引は合計からだけ差し引く
    const discountRows = [
      ...groupSum(
        discounts.filter((d) => isSale.has(d.transactionId)),
        (d) => `${d.discountId === null ? 'manual' : 'master'}\u0000${d.name}`,
        () => ({ count: 0, amount: 0 }),
        (acc, d) => {
          acc.count! += 1;
          acc.amount! += d.amount;
        },
      ),
    ]
      .map(([k, v]) => {
        const [kind, name] = k.split('\u0000');
        return { name: name!, manual: kind === 'manual', count: v.count!, amount: v.amount! };
      })
      .sort((a, b) => b.amount - a.amount);

    const taxRows = [
      ...groupSum(taxes, (t) => t.taxRate, () => ({ taxableAmount: 0, taxAmount: 0 }), (acc, t) => {
        acc.taxableAmount! += t.taxableAmount;
        acc.taxAmount! += t.taxAmount;
      }),
    ]
      .map(([rate, v]) => ({ taxRate: rate as TaxRate, taxableAmount: v.taxableAmount!, taxAmount: v.taxAmount! }))
      .sort((a, b) => b.taxRate - a.taxRate);

    const approverIds = [...new Set(others.flatMap((t) => (t.approvedByEmployeeId ? [t.approvedByEmployeeId] : [])))];
    const approvers = approverIds.length ? this.db.select().from(employees).where(inArray(employees.id, approverIds)).all() : [];
    const originalIds = [...new Set(others.flatMap((t) => (t.originalTransactionId ? [t.originalTransactionId] : [])))];
    const originals = originalIds.length
      ? this.db.select({ id: transactions.id, receiptNumber: transactions.receiptNumber }).from(transactions).where(inArray(transactions.id, originalIds)).all()
      : [];

    return {
      storeCode: settings.storeCode,
      from,
      to,
      summary: {
        grossSales,
        refunds,
        netSales,
        saleCount: sales.length,
        cancelledCount: cancelled.size,
        customerCount,
        averagePerCustomer: customerCount > 0 ? Math.floor(netSales / customerCount) : 0,
        discountTotal: txs.reduce((s, t) => s + t.discountTotal, 0),
        refundCount: others.length,
      },
      products,
      categories,
      hourly,
      payments: byKey(PAYMENT_METHODS, (t) => t.paymentMethod).map(({ key, ...v }) => ({ method: key, ...v })),
      dining: byKey(DINING_OPTIONS, (t) => t.diningOption).map(({ key, ...v }) => ({ diningOption: key, ...v })),
      taxes: taxRows,
      discounts: discountRows,
      registers: [...registerRows]
        .map(([registerNumber, v]) => ({
          registerNumber,
          name: rows.find((r) => r.registerNumber === registerNumber)!.registerName,
          amount: v.amount!,
          count: v.count!,
          cash: v.cash!,
          paypay: v.paypay!,
        }))
        .sort((a, b) => a.registerNumber - b.registerNumber),
      refunds: rows
        .filter((r) => r.t.kind !== 'sale')
        .map((r) => ({
          id: r.t.id,
          kind: r.t.kind as 'refund' | 'exchange',
          createdAt: r.t.createdAt,
          receiptNumber: r.t.receiptNumber,
          originalReceiptNumber: originals.find((o) => o.id === r.t.originalTransactionId)?.receiptNumber ?? null,
          registerNumber: r.registerNumber,
          employeeName: r.employeeName,
          approverName: approvers.find((a) => a.id === r.t.approvedByEmployeeId)?.name ?? null,
          reason: r.t.reason,
          amount: r.t.total,
          paymentMethod: r.t.paymentMethod,
        })),
    };
  }

  /** レジ点検・精算: 範囲内のレジの開設記録ごとの現金過不足と PayPay 売上 */
  settlements(from: string, to: string): RegisterSettlementRow[] {
    const days = this.daysBetween(from, to);
    if (days.length === 0) return [];
    const rows = this.db
      .select({ s: registerSessions, deviceName: devices.name, openedByName: employees.name, date: businessDays.date })
      .from(registerSessions)
      .innerJoin(devices, eq(devices.id, registerSessions.deviceId))
      .innerJoin(employees, eq(employees.id, registerSessions.openedByEmployeeId))
      .innerJoin(businessDays, eq(businessDays.id, registerSessions.businessDayId))
      .where(inArray(registerSessions.businessDayId, days.map((d) => d.id)))
      .orderBy(asc(registerSessions.openedAt))
      .all();
    const closerIds = [...new Set(rows.flatMap((r) => (r.s.closedByEmployeeId ? [r.s.closedByEmployeeId] : [])))];
    const closers = closerIds.length ? this.db.select().from(employees).where(inArray(employees.id, closerIds)).all() : [];
    return rows.map((r) => ({
      ...this.registersService.summary(r.s.id),
      businessDate: r.date,
      deviceName: r.deviceName,
      openedByName: r.openedByName,
      closedByName: closers.find((c) => c.id === r.s.closedByEmployeeId)?.name ?? null,
    }));
  }

  auditLogs(q: AuditQuery): { logs: AuditLogEntry[]; nextBeforeId: number | null } {
    const conds: SQL[] = [];
    if (q.from !== undefined) conds.push(gte(auditLogs.createdAt, q.from));
    if (q.to !== undefined) conds.push(lte(auditLogs.createdAt, q.to));
    if (q.beforeId !== undefined) conds.push(lt(auditLogs.id, q.beforeId));
    // 分類は action から決めるので、少し多めに読んで絞り込む（1店舗の操作量なら十分）
    const raw = this.db
      .select({ log: auditLogs, employeeName: employees.name, deviceName: devices.name })
      .from(auditLogs)
      .leftJoin(employees, eq(employees.id, auditLogs.employeeId))
      .leftJoin(devices, eq(devices.id, auditLogs.deviceId))
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(auditLogs.id))
      .limit(q.category ? 2000 : q.limit + 1)
      .all()
      .filter((r) => !q.category || auditCategoryOf(r.log.action) === q.category);
    const page = raw.slice(0, q.limit);
    return {
      logs: page.map(({ log, employeeName, deviceName }) => ({
        id: log.id,
        createdAt: log.createdAt,
        action: log.action,
        actionLabel: AUDIT_ACTION_LABELS[log.action] ?? log.action,
        category: auditCategoryOf(log.action),
        employeeName,
        deviceName,
        targetType: log.targetType,
        targetId: log.targetId,
        before: log.before,
        after: log.after,
      })),
      nextBeforeId: raw.length > q.limit ? page.at(-1)!.log.id : null,
    };
  }
}
