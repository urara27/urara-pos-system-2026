import { DEVICE_TOKEN_HEADER, STAFF_SESSION_HEADER, type ApiErrorBody } from '@pos/shared';
import { keys, local, session } from './storage';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  /** 送るセッション。レジは staff、管理画面は admin */
  auth?: 'staff' | 'admin' | 'none';
}

/**
 * API 呼び出し。端末トークンは常に付ける。
 * 通信できない場合は status 0 の ApiError を投げる（会計などは確定させずにエラー表示する）。
 */
export async function api<T>(path: string, { method = 'GET', body, auth = 'none' }: RequestOptions = {}) {
  const headers: Record<string, string> = {};
  const deviceToken = local.get(keys.deviceToken);
  if (deviceToken) headers[DEVICE_TOKEN_HEADER] = deviceToken;
  const sessionToken =
    auth === 'staff' ? session.get(keys.staffSession) : auth === 'admin' ? session.get(keys.adminSession) : null;
  if (sessionToken) headers[STAFF_SESSION_HEADER] = sessionToken;
  if (body !== undefined) headers['content-type'] = 'application/json';

  let res: Response;
  try {
    res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError(0, 'network', 'サーバーと通信できません');
  }
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const err = (data as ApiErrorBody | null)?.error;
    throw new ApiError(res.status, err?.code ?? 'unknown', err?.message ?? `エラーが発生しました (${res.status})`);
  }
  return data as T;
}
