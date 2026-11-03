import { AppError } from './errors.js';

/**
 * PIN・ペアリングコードの総当たり対策。キー（IP等）ごとに一定時間内の失敗回数を数える。
 * 1台のサーバーで完結するのでメモリ上で十分。
 */
export class FailureLimiter {
  private readonly failures = new Map<string, number[]>();

  constructor(
    private readonly maxFailures: number,
    private readonly windowMs: number,
  ) {}

  assertAllowed(key: string, now = Date.now()) {
    if (this.recent(key, now).length >= this.maxFailures) {
      throw new AppError(429, 'too_many_attempts', '失敗が続いたため、しばらく待ってから再試行してください');
    }
  }

  recordFailure(key: string, now = Date.now()) {
    this.failures.set(key, [...this.recent(key, now), now]);
  }

  reset(key: string) {
    this.failures.delete(key);
  }

  private recent(key: string, now: number) {
    return (this.failures.get(key) ?? []).filter((t) => now - t < this.windowMs);
  }
}
