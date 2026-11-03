import { AppError } from './errors.js';

/** UNIQUE 制約違反を、画面に出せる 409 に変換する */
export function rethrowUnique(err: unknown, message: string): never {
  if (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'SQLITE_CONSTRAINT_UNIQUE'
  ) {
    throw new AppError(409, 'conflict', message);
  }
  throw err;
}
