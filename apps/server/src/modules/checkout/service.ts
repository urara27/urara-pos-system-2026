import { and, eq } from 'drizzle-orm';
import {
  isDiscountActive,
  priceOrder,
  STATIONS,
  type CheckoutResult,
  type DiscountRequest,
  type DiscountRule,
  type EmployeeInfo,
  type checkoutRequest,
} from '@pos/shared';
import type { z } from 'zod';
import { immediateTransaction, type Db } from '../../db/client.js';
import {
  discounts,
  orderEvents,
  orders,
  orderStationStatus,
  registers,
  storeSettings,
  transactionDiscounts,
  transactionLineOptions,
  transactionLines,
  transactions,
  transactionTaxSummaries,
} from '../../db/schema.js';
import { AppError, forbidden } from '../../lib/errors.js';
import { invalidOrder as invalid, resolveLines } from './resolve-lines.js';
import { writeAudit } from '../audit/service.js';
import { currentBusinessDay } from '../business-day/service.js';
import { issueAutoNumber, issueReceiptNumber, validateTicketNumber } from '../orders/numbering.js';
import type { RegisterService } from '../registers/service.js';

type CheckoutData = z.output<typeof checkoutRequest>;

interface ResolvedDiscount extends DiscountRule {
  discountId: number | null;
  name: string;
  manual: boolean;
}

/**
 * 会計確定。注文・販売データ・注文番号・レシート番号を1つのトランザクションで記録する。
 * 金額は端末から送られた値を信用せず、現在のマスタからサーバーで計算し直す。
 * 冪等キーが既にあれば、何も登録せずに前回の結果を返す（通信の再送対策）。
 */
export class CheckoutService {
  constructor(
    private readonly db: Db,
    private readonly registers: RegisterService,
  ) {}

  checkout(data: CheckoutData, ctx: { deviceId: number; employee: EmployeeInfo }, now = Date.now()) {
    return immediateTransaction(this.db, (tx) => {
      const replay = this.findByIdempotencyKey(tx, data.idempotencyKey);
      if (replay) {
        if (replay.registerSessionId !== data.registerSessionId) {
          throw new AppError(409, 'idempotency_conflict', '別の会計で使われたキーです');
        }
        return { result: { ...this.resultOf(tx, replay.id), replayed: true }, orderId: null };
      }

      const session = this.registers.requireOwnOpenSession(tx, data.registerSessionId, ctx.deviceId);
      const register = tx.select().from(registers).where(eq(registers.id, session.registerId)).get()!;
      const settings = tx.select().from(storeSettings).where(eq(storeSettings.id, 1)).get()!;
      const day = currentBusinessDay(tx, now);

      // ── 明細をマスタで検証・解決する ──
      const resolvedLines = resolveLines(tx, data.lines, data.diningOption).map((l, i) => ({
        ...l,
        discounts: data.lines[i]!.discounts.map((d) => this.resolveDiscount(tx, d, 'line', ctx.employee, now)),
      }));
      const orderDiscounts = data.orderDiscounts.map((d) => this.resolveDiscount(tx, d, 'order', ctx.employee, now));

      // ── 金額計算（レジ表示と同じ関数） ──
      const pricing = priceOrder({
        lines: resolvedLines.map((l) => ({
          unitPrice: l.unitPrice,
          optionsDelta: l.chosen.reduce((s, c) => s + c.option.priceDelta, 0),
          quantity: l.quantity,
          reducedTaxEligible: l.product.reducedTaxEligible,
          discounts: l.discounts,
        })),
        orderDiscounts,
        diningOption: data.diningOption,
        taxRounding: settings.taxRounding,
      });
      if (pricing.total !== data.expectedTotal) {
        throw new AppError(
          409,
          'total_mismatch',
          `合計金額が変わりました（表示 ¥${data.expectedTotal.toLocaleString()} → 現在 ¥${pricing.total.toLocaleString()}）。商品の価格や割引を確認してください`,
        );
      }

      let cashReceived: number | null = null;
      let change: number | null = null;
      if (data.payment.method === 'cash') {
        cashReceived = data.payment.cashReceived;
        if (cashReceived < pricing.total) throw invalid('預り金が合計金額より少ないです');
        change = cashReceived - pricing.total;
      }

      // ── 採番 ──
      const orderNumber =
        register.numberingMode === 'auto'
          ? issueAutoNumber(tx, settings, day.date)
          : validateTicketNumber(tx, settings, data.ticketNumber);
      const receiptNumber = issueReceiptNumber(tx, day.date, register.number);

      // ── 記録 ──
      const txRow = tx
        .insert(transactions)
        .values({
          receiptNumber,
          kind: 'sale',
          businessDayId: day.id,
          registerId: register.id,
          registerSessionId: session.id,
          employeeId: ctx.employee.id,
          diningOption: data.diningOption,
          paymentMethod: data.payment.method,
          subtotal: pricing.subtotal,
          discountTotal: pricing.discountTotal,
          total: pricing.total,
          cashReceived,
          change,
          idempotencyKey: data.idempotencyKey,
          createdAt: now,
        })
        .returning()
        .get();

      let seq = 0;
      const stationHasItems = new Set<string>();
      resolvedLines.forEach((l, i) => {
        const priced = pricing.lines[i]!;
        const lineRow = tx
          .insert(transactionLines)
          .values({
            transactionId: txRow.id,
            lineNo: i + 1,
            productId: l.product.id,
            productName: l.product.name,
            kitchenName: l.product.kitchenName,
            categoryName: l.categoryName,
            station: l.product.station,
            unitPrice: l.unitPrice,
            quantity: l.quantity,
            taxRate: priced.taxRate,
            grossAmount: priced.gross,
            lineDiscountAmount: priced.lineDiscountTotal,
            allocatedOrderDiscount: priced.allocatedOrderDiscount,
            netAmount: priced.net,
          })
          .returning()
          .get();
        stationHasItems.add(l.product.station);
        for (const c of l.chosen) {
          const station = c.option.station ?? l.product.station;
          stationHasItems.add(station);
          tx.insert(transactionLineOptions)
            .values({
              lineId: lineRow.id,
              optionId: c.option.id,
              groupName: c.group.name,
              optionName: c.option.name,
              kitchenName: c.option.kitchenName,
              station,
              priceDelta: c.option.priceDelta,
            })
            .run();
        }
        l.discounts.forEach((d, k) => {
          tx.insert(transactionDiscounts)
            .values({
              transactionId: txRow.id,
              lineId: lineRow.id,
              discountId: d.discountId,
              name: d.name,
              kind: d.kind,
              value: d.value,
              scope: 'line',
              seq: ++seq,
              amount: priced.lineDiscountAmounts[k]!,
            })
            .run();
        });
      });
      orderDiscounts.forEach((d, k) => {
        tx.insert(transactionDiscounts)
          .values({
            transactionId: txRow.id,
            discountId: d.discountId,
            name: d.name,
            kind: d.kind,
            value: d.value,
            scope: 'order',
            seq: ++seq,
            amount: pricing.orderDiscountAmounts[k]!,
          })
          .run();
      });
      for (const t of pricing.taxes) {
        tx.insert(transactionTaxSummaries)
          .values({ transactionId: txRow.id, taxRate: t.taxRate, taxableAmount: t.taxableAmount, taxAmount: t.taxAmount })
          .run();
      }

      const order = tx
        .insert(orders)
        .values({
          transactionId: txRow.id,
          businessDayId: day.id,
          orderNumber,
          numberingMode: register.numberingMode,
          diningOption: data.diningOption,
          status: 'accepted',
          acceptedAt: now,
        })
        .returning()
        .get();
      for (const station of STATIONS) {
        tx.insert(orderStationStatus)
          .values({ orderId: order.id, station, hasItems: stationHasItems.has(station) })
          .run();
      }
      tx.insert(orderEvents)
        .values({ orderId: order.id, type: 'created', toStatus: 'accepted', deviceId: ctx.deviceId, employeeId: ctx.employee.id, createdAt: now })
        .run();

      const allDiscounts = [...resolvedLines.flatMap((l) => l.discounts), ...orderDiscounts];
      if (allDiscounts.length > 0) {
        writeAudit(tx, {
          action: 'discount.applied',
          employeeId: ctx.employee.id,
          deviceId: ctx.deviceId,
          targetType: 'transaction',
          targetId: txRow.id,
          after: {
            receiptNumber,
            discountTotal: pricing.discountTotal,
            discounts: allDiscounts.map((d) => ({ name: d.name, kind: d.kind, value: d.value, manual: d.manual })),
          },
        });
      }

      const result: CheckoutResult = {
        transactionId: txRow.id,
        receiptNumber,
        orderId: order.id,
        orderNumber,
        numberingMode: register.numberingMode,
        total: pricing.total,
        paymentMethod: data.payment.method,
        cashReceived,
        change,
        replayed: false,
      };
      return { result, orderId: order.id };
    });
  }

  private resolveDiscount(
    tx: Db,
    request: DiscountRequest,
    scope: 'line' | 'order',
    employee: EmployeeInfo,
    now: number,
  ): ResolvedDiscount {
    if ('manual' in request) {
      if (!employee.canManualDiscount) throw forbidden('手入力の値引きをする権限がありません');
      const { kind, value } = request.manual;
      if (kind === 'rate' && value > 100) throw invalid('割引率は100%以下にしてください');
      if (kind === 'amount' && value > 1_000_000) throw invalid('値引き額が大きすぎます');
      return { kind, value, discountId: null, name: kind === 'rate' ? `手入力 ${value}%引` : `手入力 ${value}円引`, manual: true };
    }
    const d = tx.select().from(discounts).where(eq(discounts.id, request.discountId)).get();
    if (!d || !isDiscountActive(d, now)) throw invalid('使えない割引が含まれています');
    if (d.scope !== scope) {
      throw invalid(`「${d.name}」は${d.scope === 'line' ? '明細' : '会計全体'}に使う割引です`);
    }
    return { kind: d.kind, value: d.value, discountId: d.id, name: d.name, manual: false };
  }

  private findByIdempotencyKey(tx: Db, key: string) {
    return tx.select().from(transactions).where(eq(transactions.idempotencyKey, key)).get();
  }

  private resultOf(tx: Db, transactionId: number): CheckoutResult {
    const row = tx
      .select({ t: transactions, o: orders })
      .from(transactions)
      .innerJoin(orders, and(eq(orders.transactionId, transactions.id)))
      .where(eq(transactions.id, transactionId))
      .get()!;
    return {
      transactionId: row.t.id,
      receiptNumber: row.t.receiptNumber,
      orderId: row.o.id,
      orderNumber: row.o.orderNumber,
      numberingMode: row.o.numberingMode,
      total: row.t.total,
      paymentMethod: row.t.paymentMethod,
      cashReceived: row.t.cashReceived,
      change: row.t.change,
      replayed: false,
    };
  }
}
