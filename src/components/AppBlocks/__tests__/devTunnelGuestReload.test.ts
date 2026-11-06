import { describe, expect, it } from 'vitest';

import {
  countGuestFrameEvent,
  isDevTunnelGuestReload,
  NO_GUEST_FRAME_EVENTS,
} from '../devTunnelGuestReload';

/**
 * The ONE rule behind "the dev-tunnel app reloaded itself in the frame — ask for a fresh
 * entry URL": the counts (`countGuestFrameEvent`) and the predicate. Pinned on literals.
 *
 * 🔴 The orderings a browser test cannot produce deterministically live here, replayed as
 * whole event sequences through the same two functions the host calls. Above all the
 * frame's INITIAL `load` arriving AFTER BLOCK_READY (measured 2026-10-23 in Chromium:
 * READY at 24 ms, first `load` at 624 ms), which must not read as a reload or the remount
 * loops.
 */

type Step = 'hello' | 'load' | 'READY';

/** Replay a frame's events on the dev-tunnel surface; return each event's verdict. */
function replay(steps: Step[], surface: 'dev-tunnel' | 'page-run' = 'dev-tunnel') {
  let counts = NO_GUEST_FRAME_EVENTS;
  let status: 'loading' | 'ready' = 'loading';
  const verdicts: boolean[] = [];
  for (const step of steps) {
    if (step === 'READY') {
      status = 'ready';
      continue;
    }
    counts = countGuestFrameEvent(counts, step);
    verdicts.push(isDevTunnelGuestReload({ surface, event: step, ...counts, status }));
  }
  return verdicts;
}
/** The verdict on the LAST event, and that no earlier one reported. */
function lastOnly(steps: Step[], surface?: 'dev-tunnel' | 'page-run') {
  const verdicts = replay(steps, surface);
  expect(verdicts.slice(0, -1), 'an earlier event already reported').not.toContain(true);
  return verdicts[verdicts.length - 1];
}

describe('dev-tunnel guest reload — whole event sequences', () => {
  it('normal boot, then a refused (401) reload → the 401 load asks', () => {
    expect(lastOnly(['hello', 'load', 'READY', 'load'])).toBe(true);
  });

  it('the initial load arriving AFTER ready is NOT a reload (the loop guard)', () => {
    expect(lastOnly(['hello', 'READY', 'load'])).toBe(false);
  });

  it('a reload whose entry was still valid: the new document’s hello asks', () => {
    expect(lastOnly(['hello', 'load', 'READY', 'hello'])).toBe(true);
  });

  it('a hello AFTER its own load (a late-starting SDK), then a 401 → asks', () => {
    expect(lastOnly(['load', 'hello', 'READY', 'load'])).toBe(true);
  });

  // This exact sequence is ALSO the module's second residual — a spare hello, then a
  // document whose hello trails its own load, then a 401 — read event for event. The host
  // cannot tell them apart; this pins the side chosen (no remount loop over a missed 401).
  it('a document replaced during boot, both said hello → not a reload; a 401 later asks', () => {
    expect(lastOnly(['hello', 'load', 'hello', 'READY', 'load'])).toBe(false);
    expect(lastOnly(['hello', 'load', 'hello', 'READY', 'load', 'load'])).toBe(true);
  });

  // 🔴 REGRESSION (round-3 audit): a document that said hello and navigated before its
  // own load left a spare hello, and uncapped counts let it cancel the later 401's load.
  it('a hello whose document never loaded does not hide a later 401', () => {
    expect(lastOnly(['hello', 'hello', 'READY', 'load'])).toBe(false);
    expect(lastOnly(['hello', 'hello', 'READY', 'load', 'load'])).toBe(true);
  });

  it('an SDK that never says hello: its first load is not a reload, a second one is', () => {
    expect(lastOnly(['READY', 'load'])).toBe(false);
    expect(lastOnly(['load', 'READY', 'load'])).toBe(true);
  });

  it('not ready → nothing is a reload: the running handshake serves a new document', () => {
    expect(replay(['hello', 'load', 'load', 'hello', 'load'])).not.toContain(true);
  });

  it('every other surface → never', () => {
    expect(replay(['hello', 'load', 'READY', 'load', 'hello', 'load'], 'page-run')).not.toContain(
      true
    );
  });
});

describe('countGuestFrameEvent', () => {
  it('a hello adds a hello; a load adds a load and caps hellos at loads', () => {
    expect(countGuestFrameEvent({ loads: 1, hellos: 1 }, 'hello')).toEqual({ loads: 1, hellos: 2 });
    expect(countGuestFrameEvent({ loads: 1, hellos: 1 }, 'load')).toEqual({ loads: 2, hellos: 1 });
    expect(countGuestFrameEvent({ loads: 0, hellos: 3 }, 'load')).toEqual({ loads: 1, hellos: 1 });
  });
});
