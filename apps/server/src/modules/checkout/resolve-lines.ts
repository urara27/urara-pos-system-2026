import { asc, eq, inArray } from 'drizzle-orm';
import type { DiningOption } from '@pos/shared';
import type { Db } from '../../db/client.js';
import { categories, optionGroups, options, productOptionGroups, products } from '../../db/schema.js';
import { AppError } from '../../lib/errors.js';

export const invalidOrder = (message: string) => new AppError(400, 'invalid_order', message);

export interface LineRequest {
  productId: number;
  optionIds: number[];
  quantity: number;
}

export interface ResolvedLine {
  product: typeof products.$inferSelect;
  categoryName: string;
  chosen: { option: typeof options.$inferSelect; group: typeof optionGroups.$inferSelect }[];
  /** 店内／持ち帰りで選んだ税込単価（オプション加算前） */
  unitPrice: number;
  quantity: number;
}

/**
 * 端末から送られた明細を、現在のマスタで検証して解決する（会計・商品変更で共通）。
 * 販売していない・売切・選べないオプション・必須グループ未選択はすべて拒否する。
 */
export function resolveLines(tx: Db, lines: LineRequest[], diningOption: DiningOption): ResolvedLine[] {
  if (lines.length === 0) return [];
  const productIds = [...new Set(lines.map((l) => l.productId))];
  const productRows = tx
    .select({ product: products, categoryName: categories.name, categoryEnabled: categories.enabled })
    .from(products)
    .innerJoin(categories, eq(categories.id, products.categoryId))
    .where(inArray(products.id, productIds))
    .all();
  const links = tx.select().from(productOptionGroups).where(inArray(productOptionGroups.productId, productIds)).all();
  const groupIds = [...new Set(links.map((l) => l.groupId))];
  const groupRows = groupIds.length ? tx.select().from(optionGroups).where(inArray(optionGroups.id, groupIds)).all() : [];
  const optionRows = groupIds.length
    ? tx.select().from(options).where(inArray(options.groupId, groupIds)).orderBy(asc(options.sortOrder), asc(options.id)).all()
    : [];

  return lines.map((line) => {
    const row = productRows.find((r) => r.product.id === line.productId);
    if (!row || !row.product.enabled || !row.categoryEnabled) throw invalidOrder('販売していない商品が含まれています');
    const p = row.product;
    if (p.soldOut) throw invalidOrder(`「${p.name}」は売切です`);

    const myGroups = links
      .filter((l) => l.productId === p.id)
      .map((l) => groupRows.find((g) => g.id === l.groupId)!)
      .filter((g) => g.enabled);
    if (new Set(line.optionIds).size !== line.optionIds.length) throw invalidOrder('同じオプションが重複しています');
    const chosen = line.optionIds.map((id) => {
      const o = optionRows.find((x) => x.id === id);
      const g = o && myGroups.find((x) => x.id === o.groupId);
      if (!o || !g || !o.enabled) throw invalidOrder(`「${p.name}」に選べないオプションが含まれています`);
      if (o.soldOut) throw invalidOrder(`オプション「${o.name}」は売切です`);
      return { option: o, group: g };
    });
    for (const g of myGroups.filter((x) => x.selection === 'single')) {
      const n = chosen.filter((c) => c.group.id === g.id).length;
      // 有効な選択肢が無いグループはレジにも出ないので必須にしない
      const selectable = optionRows.some((o) => o.groupId === g.id && o.enabled);
      if (selectable && n !== 1) throw invalidOrder(`「${p.name}」の「${g.name}」を1つ選んでください`);
    }

    const unitPrice = diningOption === 'take_out' && p.priceTakeOut !== null ? p.priceTakeOut : p.priceEatIn;
    return { product: p, categoryName: row.categoryName, chosen, unitPrice, quantity: line.quantity };
  });
}
