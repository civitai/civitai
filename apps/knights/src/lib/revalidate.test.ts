import { describe, expect, it, vi } from 'vitest';
import { revalidateUntilStopped } from './revalidate';

const never = () => new Promise<void>(() => undefined);

describe('revalidateUntilStopped', () => {
  it('waits for a slow revalidation instead of starting another over it', async () => {
    const controller = new AbortController();
    let running = 0;
    let overlapped = false;
    let calls = 0;
    const revalidate = async () => {
      calls++;
      running++;
      overlapped ||= running > 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      running--;
      if (calls === 3) controller.abort();
    };

    await revalidateUntilStopped(revalidate, {
      signal: controller.signal,
      delays: [1],
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    });

    expect(calls).toBe(3);
    expect(overlapped).toBe(false);
  });

  it('backs off between tries and holds at the last delay', async () => {
    const controller = new AbortController();
    const waits: number[] = [];
    let calls = 0;

    await revalidateUntilStopped(
      async () => {
        calls++;
      },
      {
        signal: controller.signal,
        delays: [100, 200, 300],
        sleep: async (ms) => {
          waits.push(ms);
          if (waits.length === 5) controller.abort();
        },
      }
    );

    expect(waits).toEqual([100, 200, 300, 300, 300]);
    expect(calls).toBe(5);
  });

  it('keeps going after a revalidation fails', async () => {
    const controller = new AbortController();
    let calls = 0;

    await revalidateUntilStopped(
      async () => {
        calls++;
        if (calls === 1) throw new Error('offline');
        controller.abort();
      },
      { signal: controller.signal, delays: [0], sleep: async () => undefined }
    );

    expect(calls).toBe(2);
  });

  it('leaves no abort listeners behind after many rounds', async () => {
    const controller = new AbortController();
    const added = vi.spyOn(controller.signal, 'addEventListener');
    const removed = vi.spyOn(controller.signal, 'removeEventListener');
    let calls = 0;

    await revalidateUntilStopped(
      async () => {
        if (++calls === 6) controller.abort();
      },
      { signal: controller.signal, delays: [0] }
    );

    expect(added.mock.calls.length).toBeGreaterThan(5);
    expect(removed.mock.calls.length).toBe(added.mock.calls.length);
  });

  it('stops while a revalidation is still running', async () => {
    const controller = new AbortController();
    const done = revalidateUntilStopped(never, {
      signal: controller.signal,
      delays: [0],
      sleep: async () => undefined,
    });
    controller.abort();

    await expect(done).resolves.toBeUndefined();
  });
});
