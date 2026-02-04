import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../src/utils/helpers.js', () => ({
  sleep: vi.fn().mockResolvedValue(undefined),
}));

import { sleep } from '../src/utils/helpers.js';
import { RateLimiter } from '../src/utils/rate-limiter.js';

const mockSleep = vi.mocked(sleep);

describe('RateLimiter', () => {
  let dateNowSpy: ReturnType<typeof vi.spyOn>;
  let currentTime: number;

  beforeEach(() => {
    mockSleep.mockClear();
    currentTime = 100_000;
    dateNowSpy = vi.spyOn(Date, 'now').mockImplementation(() => currentTime);
  });

  afterEach(() => {
    dateNowSpy.mockRestore();
  });

  it('allows first call without sleeping (large elapsed from epoch 0)', () => {
    // lastRequest starts at 0; currentTime is 100_000 → elapsed is 100_000
    const limiter = new RateLimiter(60);

    limiter.wait();

    expect(mockSleep).not.toHaveBeenCalled();
  });

  it('sleeps when called too soon after previous call', async () => {
    const limiter = new RateLimiter(60);
    // minInterval = ceil(60_000 / 60) + 50 = 1050

    await limiter.wait(); // sets lastRequest = 100_000
    currentTime = 100_200; // only 200ms later
    await limiter.wait();

    expect(mockSleep).toHaveBeenCalledTimes(1);
    expect(mockSleep).toHaveBeenCalledWith(850); // 1050 - 200
  });

  it('does not sleep when enough time has passed', async () => {
    const limiter = new RateLimiter(60);

    await limiter.wait(); // sets lastRequest = 100_000
    currentTime = 102_000; // 2000ms later — well past 1050ms interval
    await limiter.wait();

    expect(mockSleep).not.toHaveBeenCalled();
  });

  it('calculates correct delay for custom rate', async () => {
    const limiter = new RateLimiter(120);
    // minInterval = ceil(60_000 / 120) + 50 = 550

    await limiter.wait(); // sets lastRequest = 100_000
    currentTime = 100_300; // 300ms later
    await limiter.wait();

    expect(mockSleep).toHaveBeenCalledTimes(1);
    expect(mockSleep).toHaveBeenCalledWith(250); // 550 - 300
  });

  it('spaces multiple consecutive calls correctly', async () => {
    const limiter = new RateLimiter(60);

    await limiter.wait(); // lastRequest = 100_000
    currentTime = 100_500;
    await limiter.wait(); // sleeps 550ms, lastRequest = 100_500
    currentTime = 100_800;
    await limiter.wait(); // sleeps 750ms (1050 - 300)

    expect(mockSleep).toHaveBeenCalledTimes(2);
    expect(mockSleep).toHaveBeenNthCalledWith(1, 550);
    expect(mockSleep).toHaveBeenNthCalledWith(2, 750);
  });
});
