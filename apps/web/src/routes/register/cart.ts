import { create } from 'zustand';
import {
  priceOrder,
  type Catalog,
  type CheckoutLine,
  type DiningOption,
  type DiscountRequest,
  type DiscountRule,
  type OptionGroup,
  type Product,
  type PricingResult,
  type TaxRoundingMode,
} from '@pos/shared';

/** 明細・会計に付けた割引。サーバーへはマスタの ID か手入力の値で送る */
export interface AppliedDiscount {
  key: string;
  request: DiscountRequest;
  label: string;
  rule: DiscountRule;
}

export interface CartLine {
  key: string;
  productId: number;
  optionIds: number[];
  quantity: number;
  discounts: AppliedDiscount[];
}

const MAX_QUANTITY = 99;
let seq = 0;
const newKey = () => `k${Date.now().toString(36)}${(++seq).toString(36)}`;

/** 同じ商品・同じオプションで割引の無い明細はまとめる */
const sameItem = (l: CartLine, productId: number, optionIds: number[]) =>
  l.productId === productId &&
  l.discounts.length === 0 &&
  [...l.optionIds].sort().join(',') === [...optionIds].sort().join(',');

interface CartState {
  lines: CartLine[];
  orderDiscounts: AppliedDiscount[];
  /** 店内／持ち帰りは会計ごとに必ず選ぶ（税率が変わるため既定値を置かない） */
  diningOption: DiningOption | null;
  add: (productId: number, optionIds: number[], quantity: number) => void;
  setQuantity: (key: string, quantity: number) => void;
  remove: (key: string) => void;
  addLineDiscount: (key: string, discount: Omit<AppliedDiscount, 'key'>) => void;
  removeLineDiscount: (lineKey: string, discountKey: string) => void;
  addOrderDiscount: (discount: Omit<AppliedDiscount, 'key'>) => void;
  removeOrderDiscount: (key: string) => void;
  setDiningOption: (d: DiningOption) => void;
  clear: () => void;
}

export const useCart = create<CartState>((set) => ({
  lines: [],
  orderDiscounts: [],
  diningOption: null,
  add: (productId, optionIds, quantity) =>
    set((s) => {
      const existing = s.lines.find((l) => sameItem(l, productId, optionIds));
      if (existing) {
        return {
          lines: s.lines.map((l) =>
            l === existing ? { ...l, quantity: Math.min(MAX_QUANTITY, l.quantity + quantity) } : l,
          ),
        };
      }
      return { lines: [...s.lines, { key: newKey(), productId, optionIds, quantity, discounts: [] }] };
    }),
  setQuantity: (key, quantity) =>
    set((s) => ({
      lines: s.lines.map((l) => (l.key === key ? { ...l, quantity: Math.max(1, Math.min(MAX_QUANTITY, quantity)) } : l)),
    })),
  remove: (key) => set((s) => ({ lines: s.lines.filter((l) => l.key !== key) })),
  addLineDiscount: (key, discount) =>
    set((s) => ({
      lines: s.lines.map((l) => (l.key === key ? { ...l, discounts: [...l.discounts, { ...discount, key: newKey() }] } : l)),
    })),
  removeLineDiscount: (lineKey, discountKey) =>
    set((s) => ({
      lines: s.lines.map((l) =>
        l.key === lineKey ? { ...l, discounts: l.discounts.filter((d) => d.key !== discountKey) } : l,
      ),
    })),
  addOrderDiscount: (discount) => set((s) => ({ orderDiscounts: [...s.orderDiscounts, { ...discount, key: newKey() }] })),
  removeOrderDiscount: (key) => set((s) => ({ orderDiscounts: s.orderDiscounts.filter((d) => d.key !== key) })),
  setDiningOption: (diningOption) => set({ diningOption }),
  clear: () => set({ lines: [], orderDiscounts: [], diningOption: null }),
}));

/** 商品に紐づくオプショングループ（商品の指定順） */
export function groupsOf(product: Product, groups: OptionGroup[]) {
  return product.optionGroupIds.flatMap((id) => groups.filter((g) => g.id === id));
}

export const priceFor = (product: Product, dining: DiningOption | null) =>
  dining === 'take_out' && product.priceTakeOut !== null ? product.priceTakeOut : product.priceEatIn;

export interface QuoteLine {
  line: CartLine;
  product: Product | null;
  options: { id: number; name: string; priceDelta: number }[];
  unitPrice: number;
  /** 売切・販売終了などで会計できない明細なら理由 */
  problem: string | null;
}

export interface Quote {
  lines: QuoteLine[];
  pricing: PricingResult;
  hasProblem: boolean;
}

/**
 * 現在のカタログで明細を評価し、金額を計算する（サーバーと同じ priceOrder）。
 * 店内／持ち帰りが未選択の間は店内価格・店内税率で仮に表示する。
 */
export function quote(
  catalog: Catalog,
  cart: Pick<CartState, 'lines' | 'orderDiscounts' | 'diningOption'>,
  taxRounding: TaxRoundingMode,
): Quote {
  const lines: QuoteLine[] = cart.lines.map((line) => {
    const product = catalog.products.find((p) => p.id === line.productId) ?? null;
    const allOptions = catalog.optionGroups.flatMap((g) => g.options);
    const options = line.optionIds.map((id) => {
      const o = allOptions.find((x) => x.id === id);
      return { id, name: o?.name ?? '（販売終了）', priceDelta: o?.priceDelta ?? 0, soldOut: o?.soldOut ?? true, missing: !o };
    });
    let problem: string | null = null;
    if (!product) problem = '販売終了の商品です';
    else if (product.soldOut) problem = '売切になりました';
    else if (options.some((o) => o.missing || o.soldOut)) problem = '選べないオプションがあります';
    return {
      line,
      product,
      options: options.map(({ id, name, priceDelta }) => ({ id, name, priceDelta })),
      unitPrice: product ? priceFor(product, cart.diningOption) : 0,
      problem,
    };
  });
  const pricing = priceOrder({
    lines: lines.map((l) => ({
      unitPrice: l.unitPrice,
      optionsDelta: l.options.reduce((s, o) => s + o.priceDelta, 0),
      quantity: l.line.quantity,
      reducedTaxEligible: l.product?.reducedTaxEligible ?? true,
      discounts: l.line.discounts.map((d) => d.rule),
    })),
    orderDiscounts: cart.orderDiscounts.map((d) => d.rule),
    diningOption: cart.diningOption ?? 'eat_in',
    taxRounding,
  });
  return { lines, pricing, hasProblem: lines.some((l) => l.problem !== null) };
}

/** サーバーへ送る明細 */
export function toCheckoutLines(lines: CartLine[]): CheckoutLine[] {
  return lines.map((l) => ({
    productId: l.productId,
    optionIds: l.optionIds,
    quantity: l.quantity,
    discounts: l.discounts.map((d) => d.request),
  }));
}
