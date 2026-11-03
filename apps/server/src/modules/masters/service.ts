import { and, asc, eq, inArray, ne } from 'drizzle-orm';
import {
  isDiscountActive,
  type Catalog,
  type Category,
  type Discount,
  type OptionGroup,
  type Product,
  type categoryInput,
  type discountInput,
  type optionGroupInput,
  type productInput,
} from '@pos/shared';
import type { z } from 'zod';
import { immediateTransaction, type Db } from '../../db/client.js';
import {
  categories,
  discounts,
  optionGroups,
  options,
  productOptionGroups,
  products,
} from '../../db/schema.js';
import { AppError, notFound } from '../../lib/errors.js';
import { writeAudit } from '../audit/service.js';

type CategoryData = z.output<typeof categoryInput>;
type ProductData = z.output<typeof productInput>;
type OptionGroupData = z.output<typeof optionGroupInput>;
type DiscountData = z.output<typeof discountInput>;

/** 操作した管理者（操作ログ用） */
export interface Actor {
  employeeId: number;
}

type CategoryRow = typeof categories.$inferSelect;
type ProductRow = typeof products.$inferSelect;
type DiscountRow = typeof discounts.$inferSelect;

const toCategory = (r: CategoryRow): Category => ({
  id: r.id,
  name: r.name,
  sortOrder: r.sortOrder,
  enabled: r.enabled,
});

const toDiscount = (r: DiscountRow): Discount => ({
  id: r.id,
  name: r.name,
  kind: r.kind,
  value: r.value,
  scope: r.scope,
  validFrom: r.validFrom,
  validTo: r.validTo,
  sortOrder: r.sortOrder,
  enabled: r.enabled,
});

/**
 * 商品・カテゴリ・オプション・割引のマスタ。物理削除はせず、有効/無効で管理する。
 * 変更はすべて操作ログに記録する（価格変更は別の action でも記録して検索しやすくする）。
 */
export class MasterService {
  constructor(private readonly db: Db) {}

  // ───────── カテゴリ ─────────

  listCategories(): Category[] {
    return this.db
      .select()
      .from(categories)
      .orderBy(asc(categories.sortOrder), asc(categories.id))
      .all()
      .map(toCategory);
  }

  createCategory(data: CategoryData, actor: Actor): Category {
    return immediateTransaction(this.db, (tx) => {
      this.assertUniqueName(tx, categories, data.name);
      const row = tx.insert(categories).values(data).returning().get();
      writeAudit(tx, { action: 'category.created', employeeId: actor.employeeId, targetType: 'category', targetId: row.id, after: data });
      return toCategory(row);
    });
  }

  updateCategory(id: number, data: CategoryData, actor: Actor): Category {
    return immediateTransaction(this.db, (tx) => {
      const before = tx.select().from(categories).where(eq(categories.id, id)).get();
      if (!before) throw notFound('カテゴリが見つかりません');
      this.assertUniqueName(tx, categories, data.name, id);
      const row = tx
        .update(categories)
        .set({ ...data, updatedAt: Date.now() })
        .where(eq(categories.id, id))
        .returning()
        .get()!;
      writeAudit(tx, {
        action: 'category.updated',
        employeeId: actor.employeeId,
        targetType: 'category',
        targetId: id,
        before: toCategory(before),
        after: toCategory(row),
      });
      return toCategory(row);
    });
  }

  // ───────── 商品 ─────────

  listProducts(): Product[] {
    const rows = this.db.select().from(products).orderBy(asc(products.sortOrder), asc(products.id)).all();
    const links = this.db
      .select()
      .from(productOptionGroups)
      .orderBy(asc(productOptionGroups.sortOrder))
      .all();
    return rows.map((r) =>
      this.toProduct(
        r,
        links.filter((l) => l.productId === r.id).map((l) => l.groupId),
      ),
    );
  }

  getProduct(id: number): Product {
    const row = this.db.select().from(products).where(eq(products.id, id)).get();
    if (!row) throw notFound('商品が見つかりません');
    return this.toProduct(row, this.productGroupIds(this.db, id));
  }

  private toProduct(r: ProductRow, optionGroupIds: number[]): Product {
    return {
      id: r.id,
      name: r.name,
      kitchenName: r.kitchenName,
      priceEatIn: r.priceEatIn,
      priceTakeOut: r.priceTakeOut,
      reducedTaxEligible: r.reducedTaxEligible,
      categoryId: r.categoryId,
      station: r.station,
      optionGroupIds,
      sortOrder: r.sortOrder,
      buttonColor: r.buttonColor,
      soldOut: r.soldOut,
      enabled: r.enabled,
    };
  }

  private productGroupIds(tx: Db, productId: number) {
    return tx
      .select({ groupId: productOptionGroups.groupId })
      .from(productOptionGroups)
      .where(eq(productOptionGroups.productId, productId))
      .orderBy(asc(productOptionGroups.sortOrder))
      .all()
      .map((r) => r.groupId);
  }

  private assertProductRefs(tx: Db, data: ProductData) {
    if (!tx.select({ id: categories.id }).from(categories).where(eq(categories.id, data.categoryId)).get()) {
      throw new AppError(400, 'invalid_request', 'カテゴリが存在しません');
    }
    const ids = [...new Set(data.optionGroupIds)];
    if (ids.length !== data.optionGroupIds.length) {
      throw new AppError(400, 'invalid_request', 'オプショングループが重複しています');
    }
    if (ids.length > 0) {
      const found = tx.select({ id: optionGroups.id }).from(optionGroups).where(inArray(optionGroups.id, ids)).all();
      if (found.length !== ids.length) throw new AppError(400, 'invalid_request', 'オプショングループが存在しません');
    }
  }

  private writeProductGroups(tx: Db, productId: number, groupIds: number[]) {
    tx.delete(productOptionGroups).where(eq(productOptionGroups.productId, productId)).run();
    if (groupIds.length > 0) {
      tx.insert(productOptionGroups)
        .values(groupIds.map((groupId, i) => ({ productId, groupId, sortOrder: i })))
        .run();
    }
  }

  /** トランザクション内で使う版（CSV 取り込みから呼ぶ） */
  createProductIn(tx: Db, data: ProductData, actor: Actor): Product {
    this.assertProductRefs(tx, data);
    const { optionGroupIds, ...values } = data;
    const row = tx.insert(products).values(values).returning().get();
    this.writeProductGroups(tx, row.id, optionGroupIds);
    const product = this.toProduct(row, optionGroupIds);
    writeAudit(tx, { action: 'product.created', employeeId: actor.employeeId, targetType: 'product', targetId: row.id, after: product });
    return product;
  }

  updateProductIn(tx: Db, id: number, data: ProductData, actor: Actor): Product {
    const beforeRow = tx.select().from(products).where(eq(products.id, id)).get();
    if (!beforeRow) throw notFound('商品が見つかりません');
    const before = this.toProduct(beforeRow, this.productGroupIds(tx, id));
    this.assertProductRefs(tx, data);
    const { optionGroupIds, ...values } = data;
    const row = tx
      .update(products)
      .set({ ...values, updatedAt: Date.now() })
      .where(eq(products.id, id))
      .returning()
      .get()!;
    this.writeProductGroups(tx, id, optionGroupIds);
    const after = this.toProduct(row, optionGroupIds);
    writeAudit(tx, { action: 'product.updated', employeeId: actor.employeeId, targetType: 'product', targetId: id, before, after });
    if (before.priceEatIn !== after.priceEatIn || before.priceTakeOut !== after.priceTakeOut) {
      writeAudit(tx, {
        action: 'product.price_changed',
        employeeId: actor.employeeId,
        targetType: 'product',
        targetId: id,
        before: { priceEatIn: before.priceEatIn, priceTakeOut: before.priceTakeOut },
        after: { priceEatIn: after.priceEatIn, priceTakeOut: after.priceTakeOut },
      });
    }
    return after;
  }

  createProduct(data: ProductData, actor: Actor) {
    return immediateTransaction(this.db, (tx) => this.createProductIn(tx, data, actor));
  }

  updateProduct(id: number, data: ProductData, actor: Actor) {
    return immediateTransaction(this.db, (tx) => this.updateProductIn(tx, id, data, actor));
  }

  /** 売切の切替（管理画面の一覧から素早く切り替える用） */
  setSoldOut(id: number, soldOut: boolean, actor: Actor) {
    return immediateTransaction(this.db, (tx) => {
      const before = tx.select().from(products).where(eq(products.id, id)).get();
      if (!before) throw notFound('商品が見つかりません');
      tx.update(products).set({ soldOut, updatedAt: Date.now() }).where(eq(products.id, id)).run();
      writeAudit(tx, {
        action: 'product.sold_out_changed',
        employeeId: actor.employeeId,
        targetType: 'product',
        targetId: id,
        before: { soldOut: before.soldOut },
        after: { soldOut },
      });
    });
  }

  // ───────── オプショングループ ─────────

  listOptionGroups(): OptionGroup[] {
    const groups = this.db.select().from(optionGroups).orderBy(asc(optionGroups.sortOrder), asc(optionGroups.id)).all();
    const opts = this.db.select().from(options).orderBy(asc(options.sortOrder), asc(options.id)).all();
    return groups.map((g) => ({
      id: g.id,
      name: g.name,
      selection: g.selection,
      sortOrder: g.sortOrder,
      enabled: g.enabled,
      options: opts
        .filter((o) => o.groupId === g.id)
        .map((o) => ({
          id: o.id,
          name: o.name,
          kitchenName: o.kitchenName,
          priceDelta: o.priceDelta,
          isDefault: o.isDefault,
          station: o.station,
          sortOrder: o.sortOrder,
          soldOut: o.soldOut,
          enabled: o.enabled,
        })),
    }));
  }

  private getOptionGroup(id: number) {
    const group = this.listOptionGroups().find((g) => g.id === id);
    if (!group) throw notFound('オプショングループが見つかりません');
    return group;
  }

  createOptionGroup(data: OptionGroupData, actor: Actor): OptionGroup {
    if (data.options.some((o) => o.id !== undefined)) {
      throw new AppError(400, 'invalid_request', '新しいグループの選択肢に id は指定できません');
    }
    const id = immediateTransaction(this.db, (tx) => {
      this.assertUniqueName(tx, optionGroups, data.name);
      const { options: opts, ...group } = data;
      const row = tx.insert(optionGroups).values(group).returning().get();
      tx.insert(options)
        .values(opts.map(({ id: _id, ...o }) => ({ ...o, groupId: row.id })))
        .run();
      writeAudit(tx, { action: 'option_group.created', employeeId: actor.employeeId, targetType: 'option_group', targetId: row.id, after: data });
      return row.id;
    });
    return this.getOptionGroup(id);
  }

  /**
   * 選択肢は id 付きなら更新、無ければ追加。既存の選択肢を省くことはできない
   * （過去の販売データが参照するため。不要なら無効にする）。
   */
  updateOptionGroup(id: number, data: OptionGroupData, actor: Actor): OptionGroup {
    const before = this.getOptionGroup(id);
    immediateTransaction(this.db, (tx) => {
      this.assertUniqueName(tx, optionGroups, data.name, id);
      const existingIds = new Set(before.options.map((o) => o.id));
      const sentIds = new Set(data.options.flatMap((o) => (o.id ? [o.id] : [])));
      for (const sent of sentIds) {
        if (!existingIds.has(sent)) throw new AppError(400, 'invalid_request', '別のグループの選択肢は指定できません');
      }
      for (const existing of existingIds) {
        if (!sentIds.has(existing)) {
          throw new AppError(400, 'invalid_request', '選択肢は削除できません。不要な選択肢は無効にしてください');
        }
      }
      const { options: opts, ...group } = data;
      tx.update(optionGroups).set({ ...group, updatedAt: Date.now() }).where(eq(optionGroups.id, id)).run();
      for (const { id: optionId, ...o } of opts) {
        if (optionId) {
          tx.update(options)
            .set({ ...o, updatedAt: Date.now() })
            .where(and(eq(options.id, optionId), eq(options.groupId, id)))
            .run();
        } else {
          tx.insert(options).values({ ...o, groupId: id }).run();
        }
      }
    });
    const after = this.getOptionGroup(id);
    writeAudit(this.db, { action: 'option_group.updated', employeeId: actor.employeeId, targetType: 'option_group', targetId: id, before, after });
    return after;
  }

  // ───────── 割引・クーポン ─────────

  listDiscounts(): Discount[] {
    return this.db
      .select()
      .from(discounts)
      .orderBy(asc(discounts.sortOrder), asc(discounts.id))
      .all()
      .map(toDiscount);
  }

  createDiscount(data: DiscountData, actor: Actor): Discount {
    const row = this.db.insert(discounts).values(data).returning().get();
    writeAudit(this.db, { action: 'discount.created', employeeId: actor.employeeId, targetType: 'discount', targetId: row.id, after: data });
    return toDiscount(row);
  }

  updateDiscount(id: number, data: DiscountData, actor: Actor): Discount {
    return immediateTransaction(this.db, (tx) => {
      const before = tx.select().from(discounts).where(eq(discounts.id, id)).get();
      if (!before) throw notFound('割引が見つかりません');
      const row = tx
        .update(discounts)
        .set({ ...data, updatedAt: Date.now() })
        .where(eq(discounts.id, id))
        .returning()
        .get()!;
      writeAudit(tx, {
        action: 'discount.updated',
        employeeId: actor.employeeId,
        targetType: 'discount',
        targetId: id,
        before: toDiscount(before),
        after: toDiscount(row),
      });
      return toDiscount(row);
    });
  }

  // ───────── レジ向けカタログ ─────────

  /**
   * レジに出すもの: 有効なカテゴリ・商品・オプションと、現在有効な割引。
   * 売切は「選べない状態で表示」するので含める。無効なカテゴリの商品は出さない。
   */
  catalog(now = Date.now()): Catalog {
    const cats = this.listCategories().filter((c) => c.enabled);
    const catIds = new Set(cats.map((c) => c.id));
    const groups = this.listOptionGroups()
      .filter((g) => g.enabled)
      .map((g) => ({ ...g, options: g.options.filter((o) => o.enabled) }))
      .filter((g) => g.options.length > 0);
    const groupIds = new Set(groups.map((g) => g.id));
    const prods = this.listProducts()
      .filter((p) => p.enabled && catIds.has(p.categoryId))
      .map((p) => ({ ...p, optionGroupIds: p.optionGroupIds.filter((id) => groupIds.has(id)) }));
    return {
      categories: cats,
      products: prods,
      optionGroups: groups,
      discounts: this.listDiscounts().filter((d) => isDiscountActive(d, now)),
    };
  }

  /** CSV 取り込み用: 名前→ID の解決表 */
  lookupTables(tx: Db = this.db) {
    const cats = tx.select({ id: categories.id, name: categories.name }).from(categories).all();
    const groups = tx.select({ id: optionGroups.id, name: optionGroups.name }).from(optionGroups).all();
    return { cats, groups };
  }

  productExists(tx: Db, id: number) {
    return tx.select({ id: products.id }).from(products).where(eq(products.id, id)).get() !== undefined;
  }

  /** カテゴリ名・オプショングループ名は CSV で名前から引くので重複させない */
  private assertUniqueName(tx: Db, table: typeof categories | typeof optionGroups, name: string, exceptId?: number) {
    const cond = exceptId ? and(eq(table.name, name), ne(table.id, exceptId)) : eq(table.name, name);
    if (tx.select({ id: table.id }).from(table).where(cond).get()) {
      throw new AppError(409, 'conflict', `「${name}」は既に登録されています`);
    }
  }
}
