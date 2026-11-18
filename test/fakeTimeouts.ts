import { vi } from 'vitest';

/**
 * Fake-clock helpers for component tests whose subject is a TIMER: the App Blocks
 * hosts' 10 s readiness timeout, 15 s token wait and auto-retry backoff, the tip
 * button's 5 s confirmation timeout. Waiting those out in real time cost 5-15 s
 * per test. These put setTimeout/clearTimeout on a FAKE clock (install it BEFORE
 * render, so every timer the component arms is fake) and walk it in the same
 * grain the real-time waits used. The production constants are unchanged.
 *
 * Only setTimeout/clearTimeout are faked: React's scheduler (MessageChannel), the
 * iframe's load and the browser runner's own plumbing stay real.
 *
 * 🔴 A bare `vi.waitFor` under fake timers does NOT save the time: it advances the
 * fake clock by `interval` per check while ALSO sleeping `interval` of real time
 * between checks, so fake time tracks real time 1:1. Use `advanceUntil`.
 */
export function fakeTimeouts({ animationFrames = false }: { animationFrames?: boolean } = {}) {
  vi.useFakeTimers({
    toFake: [
      'setTimeout',
      'clearTimeout',
      // Opt-in: a component whose close/unmount waits on a transition that
      // requestAnimationFrame schedules (Mantine's Popover) needs its frames on the
      // same clock, or the fake steps run past it before the frame fires.
      ...(animationFrames ? (['requestAnimationFrame', 'cancelAnimationFrame'] as const) : []),
    ],
  });
}

/** One turn of React's scheduler: it posts its work on a MessageChannel (FIFO). */
function schedulerTurn() {
  return new Promise<void>((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => resolve();
    channel.port2.postMessage(null);
  });
}

async function fakeStep(stepMs: number) {
  await vi.advanceTimersByTimeAsync(stepMs);
  await schedulerTurn();
  await schedulerTurn();
}

/**
 * `vi.waitFor(check, { timeout: budgetMs, interval: stepMs })` on the FAKE clock:
 * check; if it throws, advance `stepMs` of fake time and let React commit; repeat
 * until `check` passes or `budgetMs` of fake time has gone by (then its error is
 * thrown).
 */
export async function advanceUntil(check: () => void, budgetMs: number, stepMs = 250) {
  for (let elapsed = 0; ; elapsed += stepMs) {
    try {
      check();
      return;
    } catch (e) {
      if (elapsed >= budgetMs) throw e;
    }
    await fakeStep(stepMs);
  }
}

/** `totalMs` of fake time in `stepMs` steps, React committing between them. */
export async function advanceBy(totalMs: number, stepMs = 250) {
  for (let elapsed = 0; elapsed < totalMs; elapsed += stepMs) await fakeStep(stepMs);
}
