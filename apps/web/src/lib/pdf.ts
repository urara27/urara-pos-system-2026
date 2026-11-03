import { DEVICE_TOKEN_HEADER, STAFF_SESSION_HEADER } from '@pos/shared';
import { keys, local, session } from './storage';

/**
 * 認証ヘッダーが必要な PDF を新しいタブで開く。
 * iPad の Safari はタップの直後でないとタブを開かせないので、先に空のタブを開いてから中身を入れる。
 */
export async function openPdf(path: string, auth: 'staff' | 'admin') {
  const tab = window.open('', '_blank');
  const headers: Record<string, string> = {};
  const deviceToken = local.get(keys.deviceToken);
  if (deviceToken) headers[DEVICE_TOKEN_HEADER] = deviceToken;
  const sessionToken = session.get(auth === 'staff' ? keys.staffSession : keys.adminSession);
  if (sessionToken) headers[STAFF_SESSION_HEADER] = sessionToken;
  try {
    const res = await fetch(path, { headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const url = URL.createObjectURL(await res.blob());
    if (tab) tab.location.href = url;
    else window.location.href = url;
    // タブが読み込み終わるまで URL を残しておく
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (err) {
    tab?.close();
    throw err;
  }
}
