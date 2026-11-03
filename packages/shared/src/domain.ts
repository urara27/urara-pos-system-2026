/** 端末の役割。管理画面はペアリング不要（管理者ログインで保護）なので含めない */
export const DEVICE_ROLES = ['register', 'kitchen', 'customer', 'pickup'] as const;
export type DeviceRole = (typeof DEVICE_ROLES)[number];

export const DEVICE_ROLE_LABELS: Record<DeviceRole, string> = {
  register: 'レジ',
  kitchen: 'キッチンモニター',
  customer: 'カスタマーモニター',
  pickup: 'ピックアップ端末',
};

export const EMPLOYEE_ROLES = ['staff', 'manager', 'admin'] as const;
export type EmployeeRole = (typeof EMPLOYEE_ROLES)[number];

export const EMPLOYEE_ROLE_LABELS: Record<EmployeeRole, string> = {
  staff: 'スタッフ',
  manager: '責任者',
  admin: '管理者',
};

export const STATIONS = ['food', 'drink'] as const;
export type Station = (typeof STATIONS)[number];

/** キッチンモニターの表示範囲 */
export const KITCHEN_VIEWS = ['all', ...STATIONS] as const;
export type KitchenView = (typeof KITCHEN_VIEWS)[number];

export const ORDER_STATUSES = ['accepted', 'calling', 'completed', 'cancelled'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const NUMBERING_MODES = ['ticket', 'auto'] as const;
export type NumberingMode = (typeof NUMBERING_MODES)[number];

export const PAYMENT_METHODS = ['cash', 'paypay'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const DINING_OPTIONS = ['eat_in', 'take_out'] as const;
export type DiningOption = (typeof DINING_OPTIONS)[number];

export const TAX_ROUNDING_MODES = ['floor', 'round', 'ceil'] as const;
export type TaxRoundingMode = (typeof TAX_ROUNDING_MODES)[number];
