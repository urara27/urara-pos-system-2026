import { createHash, randomBytes, randomInt } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';

/** 端末トークン・セッショントークン用のランダム文字列 */
export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

/** トークンは高エントロピーなので DB には SHA-256 で保存する */
export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function randomDigits(length: number): string {
  return Array.from({ length }, () => randomInt(10)).join('');
}

/** PIN・パスワードは Argon2id でハッシュ化する */
export function hashSecret(secret: string): Promise<string> {
  return hash(secret);
}

export async function verifySecret(hashed: string, secret: string): Promise<boolean> {
  try {
    return await verify(hashed, secret);
  } catch {
    return false;
  }
}
