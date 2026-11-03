/**
 * 冪等キー用のランダムID。crypto.randomUUID は HTTPS か localhost でしか使えないので、
 * 店内LANを HTTP で試すときのために getRandomValues で作る。
 */
export function randomId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
