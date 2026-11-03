/**
 * ブラウザストレージの薄いラッパー。プライベートモード等で例外が出ても画面を止めない。
 * - local: 端末に紐づく情報（端末トークン・キッチンの表示範囲など、再起動後も維持）
 * - session: ログイン（タブを閉じたら消える）
 */
function wrap(getStore: () => Storage) {
  return {
    get(key: string): string | null {
      try {
        return getStore().getItem(key);
      } catch {
        return null;
      }
    },
    set(key: string, value: string) {
      try {
        getStore().setItem(key, value);
      } catch {
        // 保存できなくても動作は続ける
      }
    },
    remove(key: string) {
      try {
        getStore().removeItem(key);
      } catch {
        // noop
      }
    },
  };
}

export const local = wrap(() => window.localStorage);
export const session = wrap(() => window.sessionStorage);

export const keys = {
  deviceToken: 'pos.deviceToken',
  device: 'pos.device',
  staffSession: 'pos.staffSession',
  adminSession: 'pos.adminSession',
  kitchenView: 'pos.kitchenView',
} as const;

export function readJson<T>(store: typeof local, key: string): T | null {
  const raw = store.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
