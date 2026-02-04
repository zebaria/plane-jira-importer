/**
 * Token-bucket-style rate limiter.
 *
 * Plane enforces 60 requests/minute.  This limiter spaces outgoing requests
 * at fixed intervals (with a small buffer) so we stay safely under the limit
 * without relying solely on 429-retry logic.
 */

import type { IRateLimiter } from '../types/config.js';
import { sleep } from './helpers.js';

export class RateLimiter implements IRateLimiter {
  /** Minimum milliseconds between consecutive requests. */
  private readonly minInterval: number;

  /** Timestamp (epoch ms) of the most recent request. */
  private lastRequest: number;

  /**
   * @param requestsPerMinute  Maximum allowed requests per minute.
   *                           Defaults to 60 (Plane's limit).
   */
  constructor(requestsPerMinute = 60) {
    // +50 ms buffer to avoid edge-case bursts
    this.minInterval = Math.ceil(60_000 / requestsPerMinute) + 50;
    this.lastRequest = 0;
  }

  /**
   * Wait until enough time has passed since the last request before
   * allowing the next one to proceed.
   */
  async wait(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastRequest;

    if (elapsed < this.minInterval) {
      const delay = this.minInterval - elapsed;
      await sleep(delay);
    }

    this.lastRequest = Date.now();
  }
}
