import { z } from 'zod';
import { EMPLOYEE_ROLES, NUMBERING_MODES, STATIONS, TAX_ROUNDING_MODES } from './domain.js';
import { employeeCodeSchema, pinSchema } from './api.js';

// マスタは物理削除しない（過去の販売データが参照するため）。不要になったら「無効」にする。

const id = z.number().int().positive();
const name = (max = 60) => z.string().trim().min(1, '名称を入力してください').max(max, `名称は${max}文字以内です`);
const sortOrder = z.number().int().min(0).max(9999).default(0);
/** 税込価格（円） */
const yen = z.number().int('金額は整数（円）で入力してください').min(0, '金額は0円以上です').max(1_000_000);

// ───────── カテゴリ ─────────

export const categoryInput = z.object({
  name: name(30),
  sortOrder,
  enabled: z.boolean().default(true),
});
export type CategoryInput = z.input<typeof categoryInput>;
export interface Category extends z.output<typeof categoryInput> {
  id: number;
}

// ───────── 商品 ─────────

export const buttonColorSchema = z
  .string()
  .regex(/^(#[0-9a-fA-F]{6})?$/, 'ボタン色は #RRGGBB 形式で入力してください')
  .default('');

export const productInput = z.object({
  name: name(),
  /** キッチン用の略称（空なら商品名を使う） */
  kitchenName: z.string().trim().max(30).default(''),
  priceEatIn: yen,
  /** 持ち帰り価格。null なら店内と共通（既定） */
  priceTakeOut: yen.nullable().default(null),
  reducedTaxEligible: z.boolean().default(true),
  categoryId: id,
  station: z.enum(STATIONS),
  optionGroupIds: z.array(id).default([]),
  sortOrder,
  buttonColor: buttonColorSchema,
  soldOut: z.boolean().default(false),
  enabled: z.boolean().default(true),
});
export type ProductInput = z.input<typeof productInput>;
export interface Product extends z.output<typeof productInput> {
  id: number;
}

// ───────── オプショングループ ─────────

export const optionInput = z.object({
  /** 既存の選択肢を更新するときに指定。無ければ追加 */
  id: id.optional(),
  name: name(30),
  kitchenName: z.string().trim().max(30).default(''),
  /** 加算額（0円可） */
  priceDelta: yen,
  isDefault: z.boolean().default(false),
  /** null なら商品のステーションに従う。セットのドリンク選択などで指定する */
  station: z.enum(STATIONS).nullable().default(null),
  sortOrder,
  soldOut: z.boolean().default(false),
  enabled: z.boolean().default(true),
});

export const OPTION_SELECTIONS = ['single', 'multiple'] as const;
export type OptionSelection = (typeof OPTION_SELECTIONS)[number];
export const OPTION_SELECTION_LABELS: Record<OptionSelection, string> = {
  single: '1つを必ず選ぶ',
  multiple: '複数選べる',
};

export const optionGroupInput = z
  .object({
    name: name(30),
    selection: z.enum(OPTION_SELECTIONS),
    sortOrder,
    enabled: z.boolean().default(true),
    options: z.array(optionInput).min(1, '選択肢を1つ以上登録してください'),
  })
  .superRefine((g, ctx) => {
    const defaults = g.options.filter((o) => o.enabled && o.isDefault).length;
    if (g.selection === 'single' && defaults > 1) {
      ctx.addIssue({ code: 'custom', message: '「1つを必ず選ぶ」グループの既定の選択肢は1つまでです', path: ['options'] });
    }
    if (g.selection === 'single' && !g.options.some((o) => o.enabled)) {
      ctx.addIssue({ code: 'custom', message: '有効な選択肢が1つ以上必要です', path: ['options'] });
    }
    const ids = g.options.flatMap((o) => (o.id ? [o.id] : []));
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: 'custom', message: '選択肢が重複しています', path: ['options'] });
    }
  });
export type OptionGroupInput = z.input<typeof optionGroupInput>;
export interface OptionItem extends Omit<z.output<typeof optionInput>, 'id'> {
  id: number;
}
export interface OptionGroup extends Omit<z.output<typeof optionGroupInput>, 'options'> {
  id: number;
  options: OptionItem[];
}

// ───────── 割引・クーポン ─────────

export const DISCOUNT_KINDS = ['amount', 'rate'] as const;
export type DiscountKind = (typeof DISCOUNT_KINDS)[number];
export const DISCOUNT_KIND_LABELS: Record<DiscountKind, string> = { amount: '金額（円）', rate: '率（%）' };
export const DISCOUNT_SCOPES = ['line', 'order'] as const;
export type DiscountScope = (typeof DISCOUNT_SCOPES)[number];
export const DISCOUNT_SCOPE_LABELS: Record<DiscountScope, string> = { line: '明細', order: '会計全体' };

export const discountInput = z
  .object({
    name: name(30),
    kind: z.enum(DISCOUNT_KINDS),
    /** amount: 円 / rate: % */
    value: z.number().int('整数で入力してください').min(1, '1以上を入力してください'),
    scope: z.enum(DISCOUNT_SCOPES),
    /** 有効期間（epoch ms）。null は無期限 */
    validFrom: z.number().int().nullable().default(null),
    validTo: z.number().int().nullable().default(null),
    sortOrder,
    enabled: z.boolean().default(true),
  })
  .superRefine((d, ctx) => {
    if (d.kind === 'rate' && d.value > 100) {
      ctx.addIssue({ code: 'custom', message: '率は100%以下で入力してください', path: ['value'] });
    }
    if (d.kind === 'amount' && d.value > 1_000_000) {
      ctx.addIssue({ code: 'custom', message: '金額が大きすぎます', path: ['value'] });
    }
    if (d.validFrom !== null && d.validTo !== null && d.validFrom > d.validTo) {
      ctx.addIssue({ code: 'custom', message: '有効期間の開始が終了より後になっています', path: ['validTo'] });
    }
  });
export type DiscountInput = z.input<typeof discountInput>;
export interface Discount extends z.output<typeof discountInput> {
  id: number;
}

export function isDiscountActive(d: Pick<Discount, 'enabled' | 'validFrom' | 'validTo'>, now: number) {
  return d.enabled && (d.validFrom === null || d.validFrom <= now) && (d.validTo === null || now <= d.validTo);
}

// ───────── 従業員 ─────────

const optionalSecret = (schema: z.ZodString) =>
  z.preprocess((v) => (v === '' || v === null ? undefined : v), schema.optional());

const employeeBase = {
  code: employeeCodeSchema,
  name: name(30),
  role: z.enum(EMPLOYEE_ROLES),
  canManualDiscount: z.boolean().default(false),
  enabled: z.boolean().default(true),
  /** 管理画面ログイン用。管理者のみ */
  password: optionalSecret(z.string().min(8, 'パスワードは8文字以上です').max(128)),
};

export const employeeCreateInput = z.object({ ...employeeBase, pin: pinSchema });
/** 更新時、PIN・パスワードは空なら変更しない */
export const employeeUpdateInput = z.object({ ...employeeBase, pin: optionalSecret(pinSchema) });
export type EmployeeCreateInput = z.input<typeof employeeCreateInput>;
export type EmployeeUpdateInput = z.input<typeof employeeUpdateInput>;
export interface Employee {
  id: number;
  code: string;
  name: string;
  role: z.output<typeof employeeBase.role>;
  canManualDiscount: boolean;
  enabled: boolean;
  hasPassword: boolean;
}

// ───────── レジ ─────────

export const NUMBERING_MODE_LABELS = { ticket: '番号札', auto: '自動採番' } as const;

export const registerInput = z.object({
  number: z.number().int().min(1, 'レジ番号は1〜99です').max(99, 'レジ番号は1〜99です'),
  name: name(30),
  numberingMode: z.enum(NUMBERING_MODES),
  enabled: z.boolean().default(true),
});
export type RegisterInput = z.input<typeof registerInput>;
export interface Register extends z.output<typeof registerInput> {
  id: number;
}

// ───────── 店舗・運用設定 ─────────

/** 注文番号は3桁表示なので 1〜999 */
const orderNumber = z.number().int().min(1, '注文番号は1〜999です').max(999, '注文番号は1〜999です');

export interface NumberRange {
  min: number;
  max: number;
}

export function rangesOverlap(a: NumberRange, b: NumberRange) {
  return a.min <= b.max && b.min <= a.max;
}

export const storeSettingsInput = z
  .object({
    storeCode: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_-]{1,20}$/, '店舗コードは英数字・-・_ の20文字以内です'),
    storeName: z.string().trim().max(60),
    address: z.string().trim().max(120),
    phone: z.string().trim().max(20),
    invoiceRegistrationNumber: z
      .string()
      .trim()
      .regex(/^(T\d{13})?$/, '登録番号は T + 13桁の数字です'),
    receiptHeader: z.string().max(200),
    receiptFooter: z.string().max(200),
    taxRounding: z.enum(TAX_ROUNDING_MODES),
    businessDayCutoverMinutes: z.number().int().min(0).max(23 * 60 + 59),
    ticketNumberMin: orderNumber,
    ticketNumberMax: orderNumber,
    autoNumberMin: orderNumber,
    autoNumberMax: orderNumber,
    autoNumberResetDaily: z.boolean(),
    kitchenWarnSeconds: z.number().int().min(30).max(3600),
    kitchenAlertSeconds: z.number().int().min(30).max(7200),
    handoverUndoSeconds: z.number().int().min(0).max(3600),
    customerMessage: z.string().max(200),
  })
  .superRefine((s, ctx) => {
    if (s.ticketNumberMin > s.ticketNumberMax) {
      ctx.addIssue({ code: 'custom', message: '番号札の範囲の下限が上限を超えています', path: ['ticketNumberMax'] });
    }
    if (s.autoNumberMin > s.autoNumberMax) {
      ctx.addIssue({ code: 'custom', message: '自動採番の範囲の下限が上限を超えています', path: ['autoNumberMax'] });
    }
    if (
      rangesOverlap(
        { min: s.ticketNumberMin, max: s.ticketNumberMax },
        { min: s.autoNumberMin, max: s.autoNumberMax },
      )
    ) {
      ctx.addIssue({ code: 'custom', message: '番号札と自動採番の番号範囲が重なっています', path: ['autoNumberMin'] });
    }
    if (s.kitchenWarnSeconds >= s.kitchenAlertSeconds) {
      ctx.addIssue({
        code: 'custom',
        message: 'キッチンの経過時間は「注意」より「警告」を長くしてください',
        path: ['kitchenAlertSeconds'],
      });
    }
  });
export type StoreSettingsInput = z.input<typeof storeSettingsInput>;
export type StoreSettings = z.output<typeof storeSettingsInput>;

export const TAX_ROUNDING_LABELS = { floor: '切り捨て', round: '四捨五入', ceil: '切り上げ' } as const;

// ───────── レジ向けカタログ ─────────

/** レジが商品ボタンを描くのに必要なものをまとめて返す */
export interface Catalog {
  categories: Category[];
  products: Product[];
  optionGroups: OptionGroup[];
  /** 現在有効な割引・クーポン */
  discounts: Discount[];
}

export interface CsvImportResult {
  created: number;
  updated: number;
}

export interface CsvImportErrorBody {
  error: { code: 'csv_invalid'; message: string; rows: { row: number; message: string }[] };
}

/** 端末側（レジ・キッチン・カスタマー・ピックアップ）が使う設定。`GET /api/device-settings` */
export type DeviceSettings = Pick<
  StoreSettings,
  | 'storeName'
  | 'customerMessage'
  | 'kitchenWarnSeconds'
  | 'kitchenAlertSeconds'
  | 'ticketNumberMin'
  | 'ticketNumberMax'
  | 'autoNumberMin'
  | 'autoNumberMax'
  | 'taxRounding'
  | 'handoverUndoSeconds'
>;
