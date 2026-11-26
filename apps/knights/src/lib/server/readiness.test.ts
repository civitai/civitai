import { afterEach, describe, expect, it, vi } from 'vitest';

const { getSysRedis, sysPing } = vi.hoisted(() => {
  const sysPing = vi.fn(async () => 'PONG');
  return { sysPing, getSysRedis: vi.fn(() => ({ ping: sysPing })) };
});
vi.mock('./redis', () => ({ getSysRedis }));

const { createReadiness, readiness } = await import('./readiness');

const never = () => new Promise<never>(() => {});

afterEach(() => {
  vi.useRealTimers();
});

describe('createReadiness', () => {
  it('is not ready while the ping fails, and ready once it answers', async () => {
    const ping = vi.fn().mockRejectedValueOnce(new Error('closed')).mockResolvedValue('PONG');
    const r = createReadiness({ ping });
    expect(await r.check()).toBe(false);
    expect(await r.check()).toBe(true);
  });

  it('stays ready after a later ping would fail, without pinging again', async () => {
    const ping = vi.fn().mockResolvedValueOnce('PONG').mockRejectedValue(new Error('closed'));
    const r = createReadiness({ ping });
    expect(await r.check()).toBe(true);
    expect(await r.check()).toBe(true);
    expect(await r.check()).toBe(true);
    expect(ping).toHaveBeenCalledTimes(1);
  });

  it('answers not-ready when a ping hangs past the timeout, and the next check sends a new ping', async () => {
    vi.useFakeTimers();
    const ping = vi.fn().mockImplementationOnce(never).mockResolvedValue('PONG');
    const r = createReadiness({ ping, timeoutMs: 100 });

    const first = r.check();
    await vi.advanceTimersByTimeAsync(100);
    expect(await first).toBe(false);

    expect(await r.check()).toBe(true);
    expect(ping).toHaveBeenCalledTimes(2);
  });

  it('shares one in-flight ping between concurrent checks', async () => {
    let answer!: (v: string) => void;
    const ping = vi.fn(() => new Promise<string>((res) => (answer = res)));
    const r = createReadiness({ ping });
    const checks = [r.check(), r.check(), r.check()];
    await Promise.resolve();
    answer('PONG');
    expect(await Promise.all(checks)).toEqual([true, true, true]);
    expect(ping).toHaveBeenCalledTimes(1);
  });

  it('treats a ping that throws synchronously as not ready', async () => {
    const r = createReadiness({
      ping: () => {
        throw new Error('no client');
      },
    });
    expect(await r.check()).toBe(false);
  });
});

describe('readiness', () => {
  it('builds the system client itself, so it works when the server init never ran', async () => {
    expect(getSysRedis).not.toHaveBeenCalled();
    expect(await readiness.check()).toBe(true);
    expect(getSysRedis).toHaveBeenCalled();
    expect(sysPing).toHaveBeenCalledTimes(1);
  });
});
