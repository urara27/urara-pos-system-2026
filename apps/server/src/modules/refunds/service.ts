import { and, asc, desc, eq, gte, inArray, like, lte, or, sql, type SQL } from 'drizzle-orm';
import {
  formatOrderNumber,
  priceOrder,
  refundTaxes,
  returnedLineAmount,
  STATIONS,
  sumTaxes,
  taxIncluded,
  type EmployeeInfo,
  type RefundQuote,
  type RefundResult,
  type RefundableLine,
  type ReturnedLineAmount,
  type TaxRate,
  type TaxSummary,
  type TransactionDetail,
  type TransactionSummary,
  type refundQuoteRequest,
  type refundRequest,
  type transactionSearchQuery,
} from '@pos/shared';
import type { z } from 'zod';
import { immediateTransaction, type Db } from '../../db/client.js';
import {
  businessDays,
  employees,
  orderEvents,
  orders,
  orderStationStatus,
  registers,
  storeSettings,
  transactionLineOptions,
  transactionLines,
  transactions,
  transactionTaxSummaries,
} from '../../db/schema.js';
import { verifySecret } from '../../lib/crypto.js';
import { AppError, notFound, unauthorized } from '../../lib/errors.js';
import { writeAudit } from '../audit/service.js';
import { businessDateOf, currentBusinessDay } from '../business-day/service.js';
import { invalidOrder, resolveLines, type ResolvedLine } from '../checkout/resolve-lines.js';
import { issueReceiptNumber } from '../orders/numbering.js';
import { loadOrderViews } from '../orders/service.js';
import type { RegisterService } from '../registers/service.js';

type QuoteData = z.output<typeof refundQuoteRequest>;
type RefundData = z.output<typeof refundRequest>;
type SearchQuery = z.output<typeof transactionSearchQuery>;
type TxRow = typeof transactions.$inferSelect;
type LineRow = typeof transactionLines.$inferSelect;

interface Plan {
  sale: TxRow;
  quote: RefundQuote;
  returned: { amount: ReturnedLineAmount; source: LineRow }[];
  additions: ResolvedLine[];
  additionPricing: ReturnType<typeof priceOrder>;
}

/**
 * 返金・商品変更（要件3.6）。
 * 対象は販売の取引。返金・変更は元の取引に紐付く新しい取引（kind = refund / exchange）として記録し、
 * 元の販売データは変更しない。返金は実施した営業日・実施したレジの売上（在高）として計上する。
 * 商品変更で追加した明細も、その後の返金の対象にできる。
 */
export class RefundService {
  constructor(
    private readonly db: Db,
    private readonly registers: RegisterService,
  ) {}

  // ───────── 検索・詳細 ─────────

  search(q: SearchQuery, now = Date.now()): TransactionSummary[] {
    const conds: SQL[] = [];
    if (q.receiptNumber) conds.push(like(transactions.receiptNumber, `%${q.receiptNumber}%`));
    if (q.from !== undefined) conds.push(gte(transactions.createdAt, q.from));
    if (q.to !== undefined) conds.push(lte(transactions.createdAt, q.to));
    if (q.amountMin !== undefined) conds.push(gte(transactions.total, q.amountMin));
    if (q.amountMax !== undefined) conds.push(lte(transactions.total, q.amountMax));
    if (q.employeeId !== undefined) conds.push(eq(transactions.employeeId, q.employeeId));
    // レシート番号・日時の指定が無ければ、今日の営業日に絞る（注文番号は毎日振り直すため）
    if (!q.receiptNumber && q.from === undefined && q.to === undefined) {
      const { businessDayCutoverMinutes } = this.db.select().from(storeSettings).where(eq(storeSettings.id, 1)).get()!;
      const day = this.db
        .select()
        .from(businessDays)
        .where(eq(businessDays.date, businessDateOf(now, businessDayCutoverMinutes)))
        .get();
      if (!day) return [];
      conds.push(eq(transactions.businessDayId, day.id));
    }
    if (q.orderNumber !== undefined) {
      const ids = this.db
        .select({ id: orders.transactionId })
        .from(orders)
        .where(eq(orders.orderNumber, q.orderNumber))
        .all()
        .map((r) => r.id);
      if (ids.length === 0) return [];
      conds.push(or(inArray(transactions.id, ids), inArray(transactions.originalTransactionId, ids))!);
    }
    const ids = this.db
      .select({ id: transactions.id })
      .from(transactions)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(transactions.createdAt), desc(transactions.id))
      .limit(q.limit)
      .all()
      .map((r) => r.id);
    return this.summaries(ids);
  }

  private summaries(ids: number[]): TransactionSummary[] {
    if (ids.length === 0) return [];
    const rows = this.db
      .select({ t: transactions, registerNumber: registers.number, employeeName: employees.name, date: businessDays.date })
      .from(transactions)
      .innerJoin(registers, eq(registers.id, transactions.registerId))
      .innerJoin(employees, eq(employees.id, transactions.employeeId))
      .innerJoin(businessDays, eq(businessDays.id, transactions.businessDayId))
      .where(inArray(transactions.id, ids))
      .all();
    const saleIds = rows.map((r) => r.t.originalTransactionId ?? r.t.id);
    const orderRows = this.db.select().from(orders).where(inArray(orders.transactionId, saleIds)).all();
    const refundableSales = new Set(
      rows.filter((r) => r.t.kind === 'sale' && this.refundableLines(this.db, r.t.id).some((l) => l.refundedQuantity < l.quantity)).map((r) => r.t.id),
    );
    const byId = new Map(
      rows.map(({ t, registerNumber, employeeName, date }) => {
        const order = orderRows.find((o) => o.transactionId === (t.originalTransactionId ?? t.id));
        const summary: TransactionSummary = {
          id: t.id,
          kind: t.kind,
          receiptNumber: t.receiptNumber,
          originalTransactionId: t.originalTransactionId,
          createdAt: t.createdAt,
          businessDate: date,
          registerNumber,
          employeeName,
          diningOption: t.diningOption,
          paymentMethod: t.paymentMethod,
          total: t.total,
          orderNumber: order?.orderNumber ?? null,
          orderStatus: order?.status ?? null,
          refundable: refundableSales.has(t.id),
        };
        return [t.id, summary] as const;
      }),
    );
    return ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
  }

  detail(id: number): TransactionDetail {
    const [summary] = this.summaries([id]);
    if (!summary) throw notFound('取引が見つかりません');
    const t = this.db.select().from(transactions).where(eq(transactions.id, id)).get()!;
    const approver = t.approvedByEmployeeId
      ? this.db.select({ name: employees.name }).from(employees).where(eq(employees.id, t.approvedByEmployeeId)).get()
      : undefined;
    const lines =
      t.kind === 'sale'
        ? this.refundableLines(this.db, id)
        : this.db.select().from(transactionLines).where(eq(transactionLines.transactionId, id)).orderBy(asc(transactionLines.lineNo)).all().map((l) => ({ ...this.toRefundable(l, 0), source: l }));
    const optionRows = lines.length
      ? this.db.select().from(transactionLineOptions).where(inArray(transactionLineOptions.lineId, lines.map((l) => l.lineId))).all()
      : [];
    const related = this.db
      .select({ id: transactions.id })
      .from(transactions)
      .where(eq(transactions.originalTransactionId, t.kind === 'sale' ? id : (t.originalTransactionId ?? id)))
      .orderBy(asc(transactions.createdAt))
      .all()
      .map((r) => r.id);
    return {
      ...summary,
      lines: lines.map((l) => ({
        lineId: l.lineId,
        name: l.source.productName,
        options: optionRows.filter((o) => o.lineId === l.lineId).map((o) => o.optionName),
        quantity: l.quantity,
        refundedQuantity: l.refundedQuantity,
        taxRate: l.taxRate,
        net: l.net,
      })),
      related: this.summaries(related),
      reason: t.reason,
      approvedByName: approver?.name ?? null,
    };
  }

  // ───────── 返金できる明細 ─────────

  private toRefundable(l: LineRow, refundedQuantity: number): RefundableLine {
    return {
      lineId: l.id,
      quantity: l.quantity,
      refundedQuantity,
      taxRate: l.taxRate as TaxRate,
      gross: l.grossAmount,
      lineDiscount: l.lineDiscountAmount,
      allocatedOrderDiscount: l.allocatedOrderDiscount,
      net: l.netAmount,
    };
  }

  /** 販売の明細と、商品変更で追加した明細。返金済みの数量つき */
  private refundableLines(tx: Db, saleId: number): (RefundableLine & { source: LineRow })[] {
    const relatedIds = tx
      .select({ id: transactions.id })
      .from(transactions)
      .where(eq(transactions.originalTransactionId, saleId))
      .all()
      .map((r) => r.id);
    const rows = tx
      .select()
      .from(transactionLines)
      .where(inArray(transactionLines.transactionId, [saleId, ...relatedIds]))
      .orderBy(asc(transactionLines.transactionId), asc(transactionLines.lineNo))
      .all();
    // 返品した明細（originalLineId あり）は数量を差し引く。追加した明細（金額が正で元明細なし）は対象に加える
    const refunded = new Map<number, number>();
    for (const r of rows) if (r.originalLineId !== null) refunded.set(r.originalLineId, (refunded.get(r.originalLineId) ?? 0) + r.quantity);
    return rows
      .filter((r) => r.originalLineId === null && r.netAmount >= 0 && r.quantity > 0)
      .map((r) => ({ ...this.toRefundable(r, refunded.get(r.id) ?? 0), source: r }));
  }

  /** 税率ごとの「返金できる分」の基準: 元の販売の税額 + 商品変更で追加した分の税額 */
  private baselineTaxes(tx: Db, saleId: number, lines: RefundableLine[], rounding: 'floor' | 'round' | 'ceil'): TaxSummary[] {
    const saleTaxes = tx.select().from(transactionTaxSummaries).where(eq(transactionTaxSummaries.transactionId, saleId)).all();
    const rates = [...new Set(lines.map((l) => l.taxRate))];
    return rates.map((rate) => {
      const taxableAmount = lines.filter((l) => l.taxRate === rate).reduce((s, l) => s + l.net, 0);
      const saleTaxable = saleTaxes.find((t) => t.taxRate === rate);
      // 販売分は記録した税額、商品変更で追加した分（差し引き）は同じ端数処理で計算する
      const saleTaxableAmount = saleTaxable?.taxableAmount ?? 0;
      const addedTaxable = taxableAmount - saleTaxableAmount;
      const taxAmount = (saleTaxable?.taxAmount ?? 0) + (addedTaxable > 0 ? taxIncluded(addedTaxable, rate, rounding) : 0);
      return { taxRate: rate, taxableAmount, taxAmount };
    });
  }

  // ───────── 試算 ─────────

  private plan(tx: Db, saleId: number, data: QuoteData): Plan {
    const sale = tx.select().from(transactions).where(eq(transactions.id, saleId)).get();
    if (!sale) throw notFound('取引が見つかりません');
    if (sale.kind !== 'sale') throw invalidOrder('返金・変更は販売の取引に対して行います（返金の取引は選べません）');
    const settings = tx.select().from(storeSettings).where(eq(storeSettings.id, 1)).get()!;

    const lines = this.refundableLines(tx, saleId);
    const seen = new Set<number>();
    const returned = data.returns.map((r) => {
      const line = lines.find((l) => l.lineId === r.lineId);
      if (!line) throw invalidOrder('この取引に無い明細が含まれています');
      if (seen.has(r.lineId)) throw invalidOrder('同じ明細が重複しています');
      seen.add(r.lineId);
      const remaining = line.quantity - line.refundedQuantity;
      if (r.quantity > remaining) {
        throw invalidOrder(`「${line.source.productName}」は残り ${remaining} 個までしか返金できません`);
      }
      return { amount: returnedLineAmount(line, r.quantity), source: line.source };
    });

    const additions = resolveLines(tx, data.additions, sale.diningOption);
    const additionPricing = priceOrder({
      lines: additions.map((l) => ({
        unitPrice: l.unitPrice,
        optionsDelta: l.chosen.reduce((s, c) => s + c.option.priceDelta, 0),
        quantity: l.quantity,
        reducedTaxEligible: l.product.reducedTaxEligible,
        discounts: [],
      })),
      orderDiscounts: [],
      diningOption: sale.diningOption,
      taxRounding: settings.taxRounding,
    });

    const refundedSoFar: TaxSummary[] = [...new Set(lines.map((l) => l.taxRate))].map((rate) => ({
      taxRate: rate,
      // 返金済みの対象額 = 各明細の返金済み数量ぶん（累積の按分なので記録と一致する）
      taxableAmount: lines
        .filter((l) => l.taxRate === rate && l.refundedQuantity > 0)
        .reduce((s, l) => s + returnedLineAmount({ ...l, refundedQuantity: 0 }, l.refundedQuantity).net, 0),
      taxAmount: 0,
    }));
    const returnTaxes = refundTaxes(
      this.baselineTaxes(tx, saleId, lines, settings.taxRounding),
      refundedSoFar,
      returned.map((r) => r.amount),
      settings.taxRounding,
    );
    const taxes = sumTaxes(
      returnTaxes.map((t) => ({ ...t, taxableAmount: -t.taxableAmount, taxAmount: -t.taxAmount })),
      additionPricing.taxes,
    );

    const returnAmount = returned.reduce((s, r) => s + r.amount.net, 0);
    const fullRefund =
      additions.length === 0 &&
      lines.every((l) => l.quantity - l.refundedQuantity === (data.returns.find((r) => r.lineId === l.lineId)?.quantity ?? 0));

    const optionNames = (lineId: number) =>
      tx.select().from(transactionLineOptions).where(eq(transactionLineOptions.lineId, lineId)).all().map((o) => o.optionName);

    return {
      sale,
      returned,
      additions,
      additionPricing,
      quote: {
        originalTransactionId: sale.id,
        paymentMethod: sale.paymentMethod,
        returns: returned.map((r) => ({
          lineId: r.source.id,
          name: [r.source.productName, ...optionNames(r.source.id)].join('・'),
          quantity: r.amount.quantity,
          amount: r.amount.net,
        })),
        additions: additions.map((a, i) => ({
          productId: a.product.id,
          name: a.product.name,
          options: a.chosen.map((c) => c.option.name),
          quantity: a.quantity,
          amount: additionPricing.lines[i]!.net,
        })),
        returnAmount,
        additionAmount: additionPricing.total,
        difference: additionPricing.total - returnAmount,
        fullRefund,
        taxes,
      },
    };
  }

  quote(saleId: number, data: QuoteData): RefundQuote {
    return this.plan(this.db, saleId, data).quote;
  }

  // ───────── 確定 ─────────

  /** 責任者（責任者・管理者）の PIN を確かめる */
  async verifyApprover(code: string, pin: string): Promise<EmployeeInfo & { id: number }> {
    const e = this.db.select().from(employees).where(eq(employees.code, code)).get();
    const ok = e && e.enabled && (e.role === 'manager' || e.role === 'admin') && (await verifySecret(e.pinHash, pin));
    if (!e || !ok) throw unauthorized('責任者の従業員コードまたは PIN が正しくありません（責任者・管理者のみ承認できます）');
    return { id: e.id, code: e.code, name: e.name, role: e.role, canManualDiscount: e.canManualDiscount };
  }

  execute(saleId: number, data: RefundData, ctx: { deviceId: number; employee: EmployeeInfo; approverId: number }, now = Date.now()) {
    return immediateTransaction(this.db, (tx) => {
      const replay = tx.select().from(transactions).where(eq(transactions.idempotencyKey, data.idempotencyKey)).get();
      if (replay) {
        if (replay.originalTransactionId !== saleId) throw new AppError(409, 'idempotency_conflict', '別の操作で使われたキーです');
        return { result: { ...this.resultOf(replay), replayed: true }, orderId: null };
      }

      const session = this.registers.requireOwnOpenSession(tx, data.registerSessionId, ctx.deviceId);
      const register = tx.select().from(registers).where(eq(registers.id, session.registerId)).get()!;
      const day = currentBusinessDay(tx, now);
      const { sale, quote, returned, additions, additionPricing } = this.plan(tx, saleId, data);

      if (quote.difference !== data.expectedDifference) {
        throw new AppError(409, 'total_mismatch', '金額が変わりました。もう一度内容を確認してください');
      }

      // 差額の精算は元の支払方法で行う（返金も、追加の支払も）
      let cashReceived: number | null = null;
      let change: number | null = null;
      if (quote.difference > 0 && sale.paymentMethod === 'cash') {
        if (data.cashReceived === undefined || data.cashReceived < quote.difference) {
          throw invalidOrder('差額のお預り金が足りません');
        }
        cashReceived = data.cashReceived;
        change = cashReceived - quote.difference;
      }

      const kind = additions.length > 0 ? 'exchange' : 'refund';
      const receiptNumber = issueReceiptNumber(tx, day.date, register.number);
      const returnedGross = returned.reduce((s, r) => s + r.amount.gross, 0);
      const returnedDiscount = returned.reduce((s, r) => s + r.amount.gross - r.amount.net, 0);
      const txRow = tx
        .insert(transactions)
        .values({
          receiptNumber,
          kind,
          originalTransactionId: sale.id,
          businessDayId: day.id,
          registerId: register.id,
          registerSessionId: session.id,
          employeeId: ctx.employee.id,
          approvedByEmployeeId: ctx.approverId,
          reason: data.reason,
          diningOption: sale.diningOption,
          paymentMethod: sale.paymentMethod,
          subtotal: additionPricing.subtotal - returnedGross,
          discountTotal: -returnedDiscount,
          total: quote.difference,
          cashReceived,
          change,
          idempotencyKey: data.idempotencyKey,
          createdAt: now,
        })
        .returning()
        .get();

      let lineNo = 0;
      for (const { amount, source } of returned) {
        const row = tx
          .insert(transactionLines)
          .values({
            transactionId: txRow.id,
            lineNo: ++lineNo,
            productId: source.productId,
            originalLineId: source.id,
            productName: source.productName,
            kitchenName: source.kitchenName,
            categoryName: source.categoryName,
            station: source.station,
            unitPrice: source.unitPrice,
            quantity: amount.quantity,
            taxRate: source.taxRate,
            grossAmount: -amount.gross,
            lineDiscountAmount: -amount.lineDiscount,
            allocatedOrderDiscount: -amount.allocatedOrderDiscount,
            netAmount: -amount.net,
          })
          .returning()
          .get();
        // 返品した明細のオプションも控えとして写す（レシート・キッチン表示用）
        for (const o of tx.select().from(transactionLineOptions).where(eq(transactionLineOptions.lineId, source.id)).all()) {
          const { id: _id, lineId: _l, ...rest } = o;
          tx.insert(transactionLineOptions).values({ ...rest, lineId: row.id }).run();
        }
      }
      additions.forEach((a, i) => {
        const priced = additionPricing.lines[i]!;
        const row = tx
          .insert(transactionLines)
          .values({
            transactionId: txRow.id,
            lineNo: ++lineNo,
            productId: a.product.id,
            productName: a.product.name,
            kitchenName: a.product.kitchenName,
            categoryName: a.categoryName,
            station: a.product.station,
            unitPrice: a.unitPrice,
            quantity: a.quantity,
            taxRate: priced.taxRate,
            grossAmount: priced.gross,
            netAmount: priced.net,
          })
          .returning()
          .get();
        for (const c of a.chosen) {
          tx.insert(transactionLineOptions)
            .values({
              lineId: row.id,
              optionId: c.option.id,
              groupName: c.group.name,
              optionName: c.option.name,
              kitchenName: c.option.kitchenName,
              station: c.option.station ?? a.product.station,
              priceDelta: c.option.priceDelta,
            })
            .run();
        }
      });
      for (const t of quote.taxes) {
        tx.insert(transactionTaxSummaries)
          .values({ transactionId: txRow.id, taxRate: t.taxRate, taxableAmount: t.taxableAmount, taxAmount: t.taxAmount })
          .run();
      }

      // ── 受け渡し前の注文に反映する ──
      const order = tx.select().from(orders).where(eq(orders.transactionId, sale.id)).get();
      let orderEffect: RefundResult['orderEffect'] = 'none';
      if (order && (order.status === 'accepted' || order.status === 'calling')) {
        if (quote.fullRefund) {
          tx.update(orders)
            .set({ status: 'cancelled', cancelledAt: now, modifiedAt: now, version: order.version + 1 })
            .where(eq(orders.id, order.id))
            .run();
          tx.insert(orderEvents)
            .values({ orderId: order.id, type: 'cancel', fromStatus: order.status, toStatus: 'cancelled', deviceId: ctx.deviceId, employeeId: ctx.employee.id, createdAt: now })
            .run();
          orderEffect = 'cancelled';
        } else {
          this.updateStations(tx, order.id, additions);
          tx.update(orders).set({ modifiedAt: now, version: order.version + 1 }).where(eq(orders.id, order.id)).run();
          tx.insert(orderEvents)
            .values({ orderId: order.id, type: 'modified', deviceId: ctx.deviceId, employeeId: ctx.employee.id, createdAt: now })
            .run();
          orderEffect = 'modified';
        }
      }

      writeAudit(tx, {
        action: kind === 'refund' ? 'refund.created' : 'exchange.created',
        employeeId: ctx.employee.id,
        deviceId: ctx.deviceId,
        targetType: 'transaction',
        targetId: txRow.id,
        after: {
          originalReceiptNumber: sale.receiptNumber,
          receiptNumber,
          approvedByEmployeeId: ctx.approverId,
          reason: data.reason,
          returnAmount: quote.returnAmount,
          additionAmount: quote.additionAmount,
          difference: quote.difference,
          paymentMethod: sale.paymentMethod,
          orderEffect,
          orderNumber: order ? formatOrderNumber(order.orderNumber) : null,
        },
      });

      const result: RefundResult = {
        transactionId: txRow.id,
        receiptNumber,
        kind,
        difference: quote.difference,
        paymentMethod: sale.paymentMethod,
        cashReceived,
        change,
        orderEffect,
        replayed: false,
      };
      return { result, orderId: orderEffect === 'none' ? null : order!.id };
    });
  }

  /**
   * 変更後の明細でステーションの状態を決め直す。
   * 明細が無くなったステーションは完了扱い、商品を追加したステーションは未完了に戻す。
   */
  private updateStations(tx: Db, orderId: number, additions: ResolvedLine[]) {
    const [view] = loadOrderViews(tx, [orderId]);
    if (!view) return;
    const added = new Set<string>();
    for (const a of additions) {
      added.add(a.product.station);
      for (const c of a.chosen) added.add(c.option.station ?? a.product.station);
    }
    for (const station of STATIONS) {
      const hasItems = view.items.some((i) => i.station === station || i.options.some((o) => o.station === station));
      const patch: Partial<typeof orderStationStatus.$inferInsert> = { hasItems };
      if (added.has(station)) patch.completedAt = null;
      tx.update(orderStationStatus)
        .set(patch)
        .where(and(eq(orderStationStatus.orderId, orderId), eq(orderStationStatus.station, station)))
        .run();
    }
  }

  private resultOf(t: TxRow): RefundResult {
    const order = this.db.select().from(orders).where(eq(orders.transactionId, t.originalTransactionId ?? 0)).get();
    return {
      transactionId: t.id,
      receiptNumber: t.receiptNumber,
      kind: t.kind === 'exchange' ? 'exchange' : 'refund',
      difference: t.total,
      paymentMethod: t.paymentMethod,
      cashReceived: t.cashReceived,
      change: t.change,
      orderEffect: order?.status === 'cancelled' ? 'cancelled' : 'none',
      replayed: false,
    };
  }

  /** 検索の担当者欄用 */
  employeesForSearch() {
    return this.db
      .select({ id: employees.id, name: employees.name })
      .from(employees)
      .where(sql`${employees.id} in (select distinct ${transactions.employeeId} from ${transactions})`)
      .orderBy(asc(employees.code))
      .all();
  }
}
