import { create } from 'zustand';
import type { OptionGroup, Product } from '@pos/shared';

export interface CartOption {
  groupId: number;
  groupName: string;
  optionId: number;
  name: string;
  priceDelta: number;
}

export interface CartLine {
  key: string;
  productId: number;
  name: string;
  /** 商品の税込単価（オプション加算前） */
  basePrice: number;
  options: CartOption[];
  quantity: number;
}

/** 明細の金額 = (単価 + オプション加算額) × 数量。税・割引はフェーズ3で shared の計算に移す */
export const lineUnitPrice = (line: Pick<CartLine, 'basePrice' | 'options'>) =>
  line.basePrice + line.options.reduce((sum, o) => sum + o.priceDelta, 0);
export const lineAmount = (line: CartLine) => lineUnitPrice(line) * line.quantity;

const MAX_QUANTITY = 99;

/** 同じ商品・同じオプションの明細はまとめる */
const signature = (productId: number, options: CartOption[]) =>
  `${productId}:${options
    .map((o) => o.optionId)
    .sort((a, b) => a - b)
    .join(',')}`;

interface CartState {
  lines: CartLine[];
  add: (product: Product, options: CartOption[], quantity: number) => void;
  setQuantity: (key: string, quantity: number) => void;
  remove: (key: string) => void;
  clear: () => void;
}

export const useCart = create<CartState>((set) => ({
  lines: [],
  add: (product, options, quantity) =>
    set((s) => {
      const key = signature(product.id, options);
      const existing = s.lines.find((l) => l.key === key);
      if (existing) {
        return {
          lines: s.lines.map((l) =>
            l.key === key ? { ...l, quantity: Math.min(MAX_QUANTITY, l.quantity + quantity) } : l,
          ),
        };
      }
      return {
        lines: [
          ...s.lines,
          { key, productId: product.id, name: product.name, basePrice: product.priceEatIn, options, quantity },
        ],
      };
    }),
  setQuantity: (key, quantity) =>
    set((s) => ({
      lines: s.lines.map((l) => (l.key === key ? { ...l, quantity: Math.max(1, Math.min(MAX_QUANTITY, quantity)) } : l)),
    })),
  remove: (key) => set((s) => ({ lines: s.lines.filter((l) => l.key !== key) })),
  clear: () => set({ lines: [] }),
}));

/** 商品に紐づくオプショングループ（商品の指定順） */
export function groupsOf(product: Product, groups: OptionGroup[]) {
  return product.optionGroupIds.flatMap((id) => groups.filter((g) => g.id === id));
}
