import { sql } from 'drizzle-orm';
import {
  type AnySQLiteColumn,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import {
  DEVICE_ROLES,
  DINING_OPTIONS,
  EMPLOYEE_ROLES,
  NUMBERING_MODES,
  ORDER_STATUSES,
  PAYMENT_METHODS,
  STATIONS,
  TAX_ROUNDING_MODES,
} from '@pos/shared';

// 規約: 金額はすべて整数（円）。時刻は epoch ミリ秒。販売・返金系は物理削除しない。

const nowMs = sql`(cast(unixepoch('subsec') * 1000 as integer))`;
const createdAt = () => integer('created_at').notNull().default(nowMs);
const updatedAt = () => integer('updated_at').notNull().default(nowMs);
const bool = (name: string) => integer(name, { mode: 'boolean' });

// ───────────────────────── 設定 ─────────────────────────

/** 店舗・運用設定（1行のみ, id=1） */
export const storeSettings = sqliteTable('store_settings', {
  id: integer('id').primaryKey(),
  storeCode: text('store_code').notNull().default('STORE01'),
  storeName: text('store_name').notNull().default(''),
  address: text('address').notNull().default(''),
  phone: text('phone').notNull().default(''),
  invoiceRegistrationNumber: text('invoice_registration_number').notNull().default(''),
  receiptHeader: text('receipt_header').notNull().default(''),
  receiptFooter: text('receipt_footer').notNull().default(''),
  taxRounding: text('tax_rounding', { enum: TAX_ROUNDING_MODES }).notNull().default('floor'),
  /** 営業日の切替時刻（0時からの分）。例: 240 = 午前4時 */
  businessDayCutoverMinutes: integer('business_day_cutover_minutes').notNull().default(240),
  ticketNumberMin: integer('ticket_number_min').notNull().default(1),
  ticketNumberMax: integer('ticket_number_max').notNull().default(99),
  autoNumberMin: integer('auto_number_min').notNull().default(100),
  autoNumberMax: integer('auto_number_max').notNull().default(999),
  autoNumberResetDaily: bool('auto_number_reset_daily').notNull().default(true),
  /** キッチンのカード色を変える経過時間の閾値（秒） */
  kitchenWarnSeconds: integer('kitchen_warn_seconds').notNull().default(300),
  kitchenAlertSeconds: integer('kitchen_alert_seconds').notNull().default(600),
  /** 受け渡し済みを呼び出し中に戻せる時間（秒） */
  handoverUndoSeconds: integer('handover_undo_seconds').notNull().default(300),
  customerMessage: text('customer_message').notNull().default(''),
  updatedAt: updatedAt(),
});

// ───────────────────────── 端末・従業員 ─────────────────────────

export const devices = sqliteTable('devices', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  role: text('role', { enum: DEVICE_ROLES }).notNull(),
  /** 端末トークンの SHA-256（平文は端末だけが持つ） */
  tokenHash: text('token_hash').notNull().unique(),
  enabled: bool('enabled').notNull().default(true),
  pairedAt: integer('paired_at').notNull(),
  lastSeenAt: integer('last_seen_at'),
  createdAt: createdAt(),
});

export const employees = sqliteTable('employees', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  pinHash: text('pin_hash').notNull(),
  /** 管理画面ログイン用。管理者のみ設定する */
  passwordHash: text('password_hash'),
  role: text('role', { enum: EMPLOYEE_ROLES }).notNull().default('staff'),
  canManualDiscount: bool('can_manual_discount').notNull().default(false),
  enabled: bool('enabled').notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const pairingCodes = sqliteTable(
  'pairing_codes',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    code: text('code').notNull(),
    role: text('role', { enum: DEVICE_ROLES }).notNull(),
    expiresAt: integer('expires_at').notNull(),
    usedAt: integer('used_at'),
    usedByDeviceId: integer('used_by_device_id').references(() => devices.id),
    createdByEmployeeId: integer('created_by_employee_id').references(() => employees.id),
    createdAt: createdAt(),
  },
  (t) => [index('pairing_codes_code_idx').on(t.code)],
);

export const staffSessions = sqliteTable(
  'staff_sessions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    tokenHash: text('token_hash').notNull().unique(),
    employeeId: integer('employee_id')
      .notNull()
      .references(() => employees.id),
    /** レジ等の端末からのログインなら端末ID。管理画面ログインは NULL */
    deviceId: integer('device_id').references(() => devices.id),
    kind: text('kind', { enum: ['staff', 'admin'] }).notNull(),
    expiresAt: integer('expires_at').notNull(),
    revokedAt: integer('revoked_at'),
    createdAt: createdAt(),
  },
  (t) => [index('staff_sessions_employee_idx').on(t.employeeId)],
);

export const registers = sqliteTable('registers', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  /** レジ番号（レシート番号に使う） */
  number: integer('number').notNull().unique(),
  name: text('name').notNull(),
  numberingMode: text('numbering_mode', { enum: NUMBERING_MODES }).notNull().default('auto'),
  /** （将来）使用するプリンター */
  printerId: text('printer_id'),
  enabled: bool('enabled').notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// ───────────────────────── マスタ ─────────────────────────

export const categories = sqliteTable('categories', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  enabled: bool('enabled').notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const products = sqliteTable(
  'products',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    kitchenName: text('kitchen_name').notNull().default(''),
    /** 税込価格（店内）。持ち帰り価格が NULL なら共通 */
    priceEatIn: integer('price_eat_in').notNull(),
    priceTakeOut: integer('price_take_out'),
    /** 軽減税率の対象（飲食料品）か */
    reducedTaxEligible: bool('reduced_tax_eligible').notNull().default(true),
    categoryId: integer('category_id')
      .notNull()
      .references(() => categories.id),
    station: text('station', { enum: STATIONS }).notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    buttonColor: text('button_color').notNull().default(''),
    soldOut: bool('sold_out').notNull().default(false),
    enabled: bool('enabled').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('products_category_idx').on(t.categoryId)],
);

export const optionGroups = sqliteTable('option_groups', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  /** single: 1つを必ず選ぶ / multiple: 複数選べる（0個可） */
  selection: text('selection', { enum: ['single', 'multiple'] }).notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  enabled: bool('enabled').notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const options = sqliteTable(
  'options',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    groupId: integer('group_id')
      .notNull()
      .references(() => optionGroups.id),
    name: text('name').notNull(),
    kitchenName: text('kitchen_name').notNull().default(''),
    /** 加算額（0円可） */
    priceDelta: integer('price_delta').notNull().default(0),
    isDefault: bool('is_default').notNull().default(false),
    /** 調理ステーション。NULL なら商品のステーションに従う（セットのドリンク等で指定） */
    station: text('station', { enum: STATIONS }),
    sortOrder: integer('sort_order').notNull().default(0),
    soldOut: bool('sold_out').notNull().default(false),
    enabled: bool('enabled').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('options_group_idx').on(t.groupId)],
);

export const productOptionGroups = sqliteTable(
  'product_option_groups',
  {
    productId: integer('product_id')
      .notNull()
      .references(() => products.id),
    groupId: integer('group_id')
      .notNull()
      .references(() => optionGroups.id),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.productId, t.groupId] })],
);

export const discounts = sqliteTable('discounts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  kind: text('kind', { enum: ['amount', 'rate'] }).notNull(),
  /** amount: 円 / rate: % */
  value: integer('value').notNull(),
  scope: text('scope', { enum: ['line', 'order'] }).notNull(),
  validFrom: integer('valid_from'),
  validTo: integer('valid_to'),
  sortOrder: integer('sort_order').notNull().default(0),
  enabled: bool('enabled').notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// ───────────────────────── 営業日・レジ開設 ─────────────────────────

export const businessDays = sqliteTable('business_days', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  /** 営業日（YYYY-MM-DD） */
  date: text('date').notNull().unique(),
  status: text('status', { enum: ['open', 'closed'] }).notNull().default('open'),
  openedAt: integer('opened_at').notNull(),
  closedAt: integer('closed_at'),
  closedBy: text('closed_by', { enum: ['manual', 'auto'] }),
  closedByEmployeeId: integer('closed_by_employee_id').references(() => employees.id),
});

export const registerSessions = sqliteTable(
  'register_sessions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    registerId: integer('register_id')
      .notNull()
      .references(() => registers.id),
    deviceId: integer('device_id')
      .notNull()
      .references(() => devices.id),
    businessDayId: integer('business_day_id')
      .notNull()
      .references(() => businessDays.id),
    openedByEmployeeId: integer('opened_by_employee_id')
      .notNull()
      .references(() => employees.id),
    openedAt: integer('opened_at').notNull(),
    /** 釣銭準備金 */
    openingCash: integer('opening_cash').notNull(),
    closedByEmployeeId: integer('closed_by_employee_id').references(() => employees.id),
    closedAt: integer('closed_at'),
    /** 閉設時の実査額・理論額・過不足 */
    countedCash: integer('counted_cash'),
    expectedCash: integer('expected_cash'),
    cashDifference: integer('cash_difference'),
  },
  (t) => [
    // 同じレジを2台で同時に開設できないようにする
    uniqueIndex('register_sessions_open_uq')
      .on(t.registerId)
      .where(sql`closed_at IS NULL`),
  ],
);

/** 採番カウンタ。key 例: `auto_order_number`, `receipt:2026-11-03:1` */
export const counters = sqliteTable('counters', {
  key: text('key').primaryKey(),
  value: integer('value').notNull(),
  updatedAt: updatedAt(),
});

// ───────────────────────── 取引 ─────────────────────────

export const transactions = sqliteTable(
  'transactions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** `営業日-レジ番号-連番` 例: 20261103-1-0001 */
    receiptNumber: text('receipt_number').notNull().unique(),
    kind: text('kind', { enum: ['sale', 'refund', 'exchange'] }).notNull(),
    /** 返金・変更の元取引 */
    originalTransactionId: integer('original_transaction_id').references(
      (): AnySQLiteColumn => transactions.id,
    ),
    businessDayId: integer('business_day_id')
      .notNull()
      .references(() => businessDays.id),
    registerId: integer('register_id')
      .notNull()
      .references(() => registers.id),
    registerSessionId: integer('register_session_id')
      .notNull()
      .references(() => registerSessions.id),
    employeeId: integer('employee_id')
      .notNull()
      .references(() => employees.id),
    approvedByEmployeeId: integer('approved_by_employee_id').references(() => employees.id),
    reason: text('reason'),
    diningOption: text('dining_option', { enum: DINING_OPTIONS }).notNull(),
    paymentMethod: text('payment_method', { enum: PAYMENT_METHODS }).notNull(),
    /** 小計（割引前, 税込）。返金はマイナス */
    subtotal: integer('subtotal').notNull(),
    discountTotal: integer('discount_total').notNull(),
    total: integer('total').notNull(),
    cashReceived: integer('cash_received'),
    change: integer('change'),
    idempotencyKey: text('idempotency_key').notNull().unique(),
    createdAt: createdAt(),
  },
  (t) => [
    index('transactions_business_day_idx').on(t.businessDayId),
    index('transactions_original_idx').on(t.originalTransactionId),
  ],
);

export const transactionLines = sqliteTable(
  'transaction_lines',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    transactionId: integer('transaction_id')
      .notNull()
      .references(() => transactions.id),
    lineNo: integer('line_no').notNull(),
    productId: integer('product_id').references(() => products.id),
    /** 返金明細なら元の明細 */
    originalLineId: integer('original_line_id').references(
      (): AnySQLiteColumn => transactionLines.id,
    ),
    // 以下はスナップショット（マスタ変更の影響を受けない）
    productName: text('product_name').notNull(),
    kitchenName: text('kitchen_name').notNull(),
    categoryName: text('category_name').notNull(),
    station: text('station', { enum: STATIONS }).notNull(),
    unitPrice: integer('unit_price').notNull(),
    quantity: integer('quantity').notNull(),
    /** 税率（%）: 8 or 10 */
    taxRate: integer('tax_rate').notNull(),
    /** (単価+オプション加算)×数量 */
    grossAmount: integer('gross_amount').notNull(),
    lineDiscountAmount: integer('line_discount_amount').notNull().default(0),
    /** 会計割引の按分額 */
    allocatedOrderDiscount: integer('allocated_order_discount').notNull().default(0),
    netAmount: integer('net_amount').notNull(),
  },
  (t) => [index('transaction_lines_tx_idx').on(t.transactionId)],
);

export const transactionLineOptions = sqliteTable(
  'transaction_line_options',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    lineId: integer('line_id')
      .notNull()
      .references(() => transactionLines.id),
    optionId: integer('option_id').references(() => options.id),
    groupName: text('group_name').notNull(),
    optionName: text('option_name').notNull(),
    kitchenName: text('kitchen_name').notNull(),
    station: text('station', { enum: STATIONS }).notNull(),
    priceDelta: integer('price_delta').notNull(),
  },
  (t) => [index('transaction_line_options_line_idx').on(t.lineId)],
);

export const transactionDiscounts = sqliteTable(
  'transaction_discounts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    transactionId: integer('transaction_id')
      .notNull()
      .references(() => transactions.id),
    /** 明細割引なら対象明細 */
    lineId: integer('line_id').references(() => transactionLines.id),
    /** マスタの割引。手入力なら NULL */
    discountId: integer('discount_id').references(() => discounts.id),
    name: text('name').notNull(),
    kind: text('kind', { enum: ['amount', 'rate'] }).notNull(),
    value: integer('value').notNull(),
    scope: text('scope', { enum: ['line', 'order'] }).notNull(),
    /** 適用順 */
    seq: integer('seq').notNull(),
    /** 計算後の割引額 */
    amount: integer('amount').notNull(),
  },
  (t) => [index('transaction_discounts_tx_idx').on(t.transactionId)],
);

export const transactionTaxSummaries = sqliteTable(
  'transaction_tax_summaries',
  {
    transactionId: integer('transaction_id')
      .notNull()
      .references(() => transactions.id),
    taxRate: integer('tax_rate').notNull(),
    /** 税率ごとの対象額（税込） */
    taxableAmount: integer('taxable_amount').notNull(),
    taxAmount: integer('tax_amount').notNull(),
  },
  (t) => [primaryKey({ columns: [t.transactionId, t.taxRate] })],
);

// ───────────────────────── 注文 ─────────────────────────

export const orders = sqliteTable(
  'orders',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    transactionId: integer('transaction_id')
      .notNull()
      .unique()
      .references(() => transactions.id),
    businessDayId: integer('business_day_id')
      .notNull()
      .references(() => businessDays.id),
    orderNumber: integer('order_number').notNull(),
    numberingMode: text('numbering_mode', { enum: NUMBERING_MODES }).notNull(),
    diningOption: text('dining_option', { enum: DINING_OPTIONS }).notNull(),
    status: text('status', { enum: ORDER_STATUSES }).notNull().default('accepted'),
    acceptedAt: integer('accepted_at').notNull(),
    calledAt: integer('called_at'),
    completedAt: integer('completed_at'),
    cancelledAt: integer('cancelled_at'),
    /** 変更・取消があったことをキッチンに知らせる */
    modifiedAt: integer('modified_at'),
    /** 楽観ロック */
    version: integer('version').notNull().default(1),
  },
  (t) => [
    // 未完了の注文で番号が重複しないことを DB でも保証する
    uniqueIndex('orders_active_number_uq')
      .on(t.orderNumber)
      .where(sql`status IN ('accepted', 'calling')`),
    index('orders_status_idx').on(t.status),
  ],
);

export const orderStationStatus = sqliteTable(
  'order_station_status',
  {
    orderId: integer('order_id')
      .notNull()
      .references(() => orders.id),
    station: text('station', { enum: STATIONS }).notNull(),
    /** そのステーションの明細があるか（無ければ最初から完了扱い） */
    hasItems: bool('has_items').notNull(),
    completedAt: integer('completed_at'),
  },
  (t) => [primaryKey({ columns: [t.orderId, t.station] })],
);

export const orderEvents = sqliteTable(
  'order_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    orderId: integer('order_id')
      .notNull()
      .references(() => orders.id),
    type: text('type').notNull(),
    fromStatus: text('from_status', { enum: ORDER_STATUSES }),
    toStatus: text('to_status', { enum: ORDER_STATUSES }),
    station: text('station', { enum: STATIONS }),
    deviceId: integer('device_id').references(() => devices.id),
    employeeId: integer('employee_id').references(() => employees.id),
    createdAt: createdAt(),
  },
  (t) => [index('order_events_order_idx').on(t.orderId)],
);

// ───────────────────────── 操作ログ ─────────────────────────

export const auditLogs = sqliteTable(
  'audit_logs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    action: text('action').notNull(),
    employeeId: integer('employee_id').references(() => employees.id),
    deviceId: integer('device_id').references(() => devices.id),
    targetType: text('target_type'),
    targetId: text('target_id'),
    before: text('before', { mode: 'json' }),
    after: text('after', { mode: 'json' }),
    createdAt: createdAt(),
  },
  (t) => [index('audit_logs_created_idx').on(t.createdAt)],
);
