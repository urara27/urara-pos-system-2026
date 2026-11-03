import { z } from 'zod';
import { DEVICE_ROLES, EMPLOYEE_ROLES } from './domain.js';

/** 端末トークンを送るヘッダー */
export const DEVICE_TOKEN_HEADER = 'x-device-token';
/** 従業員・管理者セッションを送るヘッダー */
export const STAFF_SESSION_HEADER = 'x-staff-session';

export const pairingCodeSchema = z.string().regex(/^\d{6}$/, 'ペアリングコードは6桁の数字です');

export const createPairingCodeRequest = z.object({
  role: z.enum(DEVICE_ROLES),
});
export type CreatePairingCodeRequest = z.infer<typeof createPairingCodeRequest>;

export const pairingCodeResponse = z.object({
  code: pairingCodeSchema,
  role: z.enum(DEVICE_ROLES),
  expiresAt: z.number(),
});
export type PairingCodeResponse = z.infer<typeof pairingCodeResponse>;

export const pairDeviceRequest = z.object({
  code: pairingCodeSchema,
  name: z.string().trim().min(1, '端末名を入力してください').max(40),
});
export type PairDeviceRequest = z.infer<typeof pairDeviceRequest>;

export const deviceInfo = z.object({
  id: z.number(),
  name: z.string(),
  role: z.enum(DEVICE_ROLES),
});
export type DeviceInfo = z.infer<typeof deviceInfo>;

export const pairDeviceResponse = z.object({
  token: z.string(),
  device: deviceInfo,
});
export type PairDeviceResponse = z.infer<typeof pairDeviceResponse>;

export const employeeCodeSchema = z.string().trim().regex(/^\d{1,8}$/, '従業員コードは数字8桁以内です');
export const pinSchema = z.string().regex(/^\d{4,8}$/, 'PINは4〜8桁の数字です');

export const staffLoginRequest = z.object({
  code: employeeCodeSchema,
  pin: pinSchema,
});
export type StaffLoginRequest = z.infer<typeof staffLoginRequest>;

export const adminLoginRequest = z.object({
  code: employeeCodeSchema,
  password: z.string().min(8, 'パスワードは8文字以上です').max(128),
});
export type AdminLoginRequest = z.infer<typeof adminLoginRequest>;

export const employeeInfo = z.object({
  id: z.number(),
  code: z.string(),
  name: z.string(),
  role: z.enum(EMPLOYEE_ROLES),
  canManualDiscount: z.boolean(),
});
export type EmployeeInfo = z.infer<typeof employeeInfo>;

export const staffSessionResponse = z.object({
  token: z.string(),
  employee: employeeInfo,
  expiresAt: z.number(),
});
export type StaffSessionResponse = z.infer<typeof staffSessionResponse>;

export const adminDeviceRow = deviceInfo.extend({
  enabled: z.boolean(),
  pairedAt: z.number(),
  lastSeenAt: z.number().nullable(),
  online: z.boolean(),
});
export type AdminDeviceRow = z.infer<typeof adminDeviceRow>;

export const broadcastPingRequest = z.object({
  message: z.string().trim().min(1).max(100),
});
export type BroadcastPingRequest = z.infer<typeof broadcastPingRequest>;

/** APIエラーの共通形式 */
export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
  };
}
