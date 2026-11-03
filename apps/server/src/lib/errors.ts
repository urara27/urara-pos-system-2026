import type { FastifyError, FastifyInstance } from 'fastify';
import { ZodError, type ZodType } from 'zod';
import type { ApiErrorBody } from '@pos/shared';

export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const unauthorized = (message = '認証が必要です') => new AppError(401, 'unauthorized', message);
export const forbidden = (message = 'この操作は許可されていません') =>
  new AppError(403, 'forbidden', message);
export const notFound = (message = '見つかりません') => new AppError(404, 'not_found', message);

/** リクエストを Zod で検証し、失敗したら 400 を返す */
export function parse<T>(schema: ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new AppError(400, 'invalid_request', result.error.issues[0]?.message ?? '入力が不正です');
  }
  return result.data;
}

export function registerErrorHandler(app: FastifyInstance) {
  app.setErrorHandler((err: FastifyError | AppError | ZodError, request, reply) => {
    let status = 500;
    let body: ApiErrorBody = { error: { code: 'internal', message: 'サーバーエラーが発生しました' } };
    if (err instanceof AppError) {
      status = err.statusCode;
      body = { error: { code: err.code, message: err.message } };
    } else if (err instanceof ZodError) {
      status = 400;
      body = { error: { code: 'invalid_request', message: err.issues[0]?.message ?? '入力が不正です' } };
    } else if ('statusCode' in err && typeof err.statusCode === 'number' && err.statusCode < 500) {
      status = err.statusCode;
      body = { error: { code: err.code ?? 'bad_request', message: err.message } };
    }
    if (status >= 500) request.log.error(err);
    void reply.status(status).send(body);
  });
}
