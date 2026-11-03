import { z } from 'zod';
import {
  DINING_OPTIONS,
  STATIONS,
  type DiningOption,
  type KitchenView,
  type NumberingMode,
  type OrderStatus,
  type PaymentMethod,
  type Station,
} from './domain.js';

// ───────── 状態遷移 ─────────

/**
 * 注文の操作と、許される遷移元 → 遷移先（要件2.3）。サーバーはこの表で検証する。
 * 取消（cancel）は返金処理（フェーズ5）から使う。
 */
export const ORDER_ACTIONS = {
  call: { from: ['accepted'], to: 'calling' },
  /** 再呼び出し（チャイムをもう一度鳴らす）。状態は変わらない */
  recall: { from: ['calling'], to: 'calling' },
  uncall: { from: ['calling'], to: 'accepted' },
  handover: { from: ['accepted', 'calling'], to: 'completed' },
  /** 受け渡し済みを呼び出し中に戻す（時間制限・番号の再利用チェックは別途） */
  undoHandover: { from: ['completed'], to: 'calling' },
  cancel: { from: ['accepted', 'calling'], to: 'cancelled' },
} as const satisfies Record<string, { from: readonly OrderStatus[]; to: OrderStatus }>;

export type OrderAction = keyof typeof ORDER_ACTIONS;

export function nextStatus(current: OrderStatus, action: OrderAction): OrderStatus | null {
  const rule = ORDER_ACTIONS[action];
  return (rule.from as readonly OrderStatus[]).includes(current) ? rule.to : null;
}

export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  accepted: 'おつくり中',
  calling: 'お呼び出し中',
  completed: '受け渡し済み',
  cancelled: '取消',
};

export const DINING_OPTION_LABELS: Record<DiningOption, string> = { eat_in: '店内', take_out: '持ち帰り' };

/** 注文番号は3桁ゼロ埋めで表示する */
export const formatOrderNumber = (n: number) => String(n).padStart(3, '0');

// ───────── 端末に配る注文 ─────────

export interface OrderItemOption {
  name: string;
  kitchenName: string;
  station: Station;
  priceDelta: number;
}

export interface OrderItem {
  lineId: number;
  name: string;
  kitchenName: string;
  quantity: number;
  station: Station;
  options: OrderItemOption[];
}

export interface StationStatus {
  /** そのステーションの明細があるか。無ければ最初から完了扱い */
  hasItems: boolean;
  completedAt: number | null;
}

export interface OrderView {
  id: number;
  orderNumber: number;
  numberingMode: NumberingMode;
  diningOption: DiningOption;
  status: OrderStatus;
  acceptedAt: number;
  calledAt: number | null;
  completedAt: number | null;
  cancelledAt: number | null;
  modifiedAt: number | null;
  version: number;
  receiptNumber: string;
  stations: Record<Station, StationStatus>;
  items: OrderItem[];
}

export interface OrderBoard {
  /** 受付済み・呼び出し中（受付順） */
  active: OrderView[];
  /** 直近に受け渡し済み・取消になった注文（新しい順） */
  recent: OrderView[];
  serverTime: number;
}

export function isStationDone(order: Pick<OrderView, 'stations'>, station: Station) {
  const s = order.stations[station];
  return !s.hasItems || s.completedAt !== null;
}

/** キッチンでの調理がすべて済んだか */
export function isKitchenDone(order: Pick<OrderView, 'stations'>) {
  return STATIONS.every((s) => isStationDone(order, s));
}

/** 調理が済んだ時刻（未完了なら null） */
export function kitchenDoneAt(order: Pick<OrderView, 'stations' | 'acceptedAt'>) {
  if (!isKitchenDone(order)) return null;
  const times = STATIONS.map((s) => order.stations[s]).filter((s) => s.hasItems).map((s) => s.completedAt!);
  return times.length > 0 ? Math.max(...times) : order.acceptedAt;
}

export interface KitchenItem {
  key: string;
  name: string;
  quantity: number;
  options: string[];
  /** 別ステーションの商品に付いたオプション（セットのドリンク等）なら、その親商品名 */
  parentName?: string;
}

/**
 * キッチンモニターに出す明細。商品はそのステーションに、オプションは自分のステーションに出る。
 * 例: チーズバーガーセット（フード）+ コーラ（ドリンク） → フードにバーガー、ドリンクにコーラ。
 * 「すべて」表示ではオプションも商品の下にまとめて出す。
 */
export function kitchenItems(order: Pick<OrderView, 'items'>, view: KitchenView): KitchenItem[] {
  const label = (x: { name: string; kitchenName: string }) => x.kitchenName || x.name;
  return order.items.flatMap((item) => {
    if (view === 'all') {
      return [{ key: `${item.lineId}`, name: label(item), quantity: item.quantity, options: item.options.map(label) }];
    }
    const result: KitchenItem[] = [];
    if (item.station === view) {
      result.push({
        key: `${item.lineId}`,
        name: label(item),
        quantity: item.quantity,
        options: item.options.filter((o) => o.station === view).map(label),
      });
    }
    item.options
      .filter((o) => o.station === view && item.station !== view)
      .forEach((o, i) =>
        result.push({ key: `${item.lineId}-o${i}`, name: label(o), quantity: item.quantity, options: [], parentName: label(item) }),
      );
    return result;
  });
}

// ───────── 会計（レジ → サーバー） ─────────

export const discountRequest = z.union([
  z.object({ discountId: z.number().int().positive() }),
  z.object({
    manual: z.object({
      kind: z.enum(['amount', 'rate']),
      value: z.number().int().min(1),
    }),
  }),
]);
export type DiscountRequest = z.infer<typeof discountRequest>;

export const checkoutLine = z.object({
  productId: z.number().int().positive(),
  optionIds: z.array(z.number().int().positive()).max(50).default([]),
  quantity: z.number().int().min(1).max(99),
  discounts: z.array(discountRequest).max(10).default([]),
});
export type CheckoutLine = z.infer<typeof checkoutLine>;

export const checkoutRequest = z.object({
  /** 端末で生成する冪等キー。再送しても1回分しか登録されない */
  idempotencyKey: z.string().min(8).max(100),
  registerSessionId: z.number().int().positive(),
  diningOption: z.enum(DINING_OPTIONS),
  lines: z.array(checkoutLine).min(1, '商品を選んでください').max(100),
  orderDiscounts: z.array(discountRequest).max(10).default([]),
  payment: z.discriminatedUnion('method', [
    z.object({ method: z.literal('cash'), cashReceived: z.number().int().min(0).max(10_000_000) }),
    z.object({ method: z.literal('paypay') }),
  ]),
  /** 番号札モードのレジでは必須 */
  ticketNumber: z.number().int().min(1).max(999).optional(),
  /** レジが表示していた合計。サーバーの計算と違えば（価格変更など）確定しない */
  expectedTotal: z.number().int().min(0),
});
export type CheckoutRequest = z.input<typeof checkoutRequest>;

export interface CheckoutResult {
  transactionId: number;
  receiptNumber: string;
  orderId: number;
  orderNumber: number;
  numberingMode: NumberingMode;
  total: number;
  paymentMethod: PaymentMethod;
  cashReceived: number | null;
  change: number | null;
  /** 冪等キーが既に使われていた（再送）なら true */
  replayed: boolean;
}

// ───────── レジの開設・閉設 ─────────

export interface RegisterStatus {
  id: number;
  number: number;
  name: string;
  numberingMode: NumberingMode;
  /** 開設中のセッション */
  openSession: {
    id: number;
    deviceId: number;
    deviceName: string;
    openedAt: number;
    openedByName: string;
    /** この端末で開設したものか */
    mine: boolean;
  } | null;
}

export const openRegisterRequest = z.object({
  registerId: z.number().int().positive(),
  openingCash: z.number().int().min(0, '釣銭準備金は0円以上です').max(10_000_000),
});

export const closeRegisterRequest = z.object({
  countedCash: z.number().int().min(0).max(10_000_000),
});

export interface RegisterSessionSummary {
  sessionId: number;
  registerId: number;
  registerNumber: number;
  registerName: string;
  openedAt: number;
  closedAt: number | null;
  openingCash: number;
  /** 現金売上（返金はマイナス） */
  cashSales: number;
  paypaySales: number;
  transactionCount: number;
  /** 理論上の現金在高 = 釣銭準備金 + 現金売上 */
  expectedCash: number;
  countedCash: number | null;
  /** 過不足 = 実査 - 理論（マイナスは不足） */
  cashDifference: number | null;
}
