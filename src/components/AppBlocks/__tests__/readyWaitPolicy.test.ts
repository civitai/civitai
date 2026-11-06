import { describe, expect, it } from 'vitest';

import {
  BLOCK_READY_TIMEOUT_MS,
  DEV_TUNNEL_READY_TIMEOUT_MS,
  TOKEN_WAIT_TIMEOUT_MS,
  decideAutoRetry,
  readyWaitPolicyFor,
} from '../pageBlockHostLogic';
import { BLOCK_HOST_DEEP_LINK_BASE } from '../blockInitFragmentGate';
import type { BlockHostSurface } from '../blockInitFragmentGate';
import { maxInitPostsWithin } from '../iframeInitController';
import { MAX_LAUNCH_INIT_POSTS, MAX_LAUNCH_SAMPLE_MS } from '../launchTimings';

/**
 * The BLOCK_READY wait per surface. Only the author's dev tunnel differs: a 30 s
 * window, no automatic reload after a timeout, and dev-server copy. Literal values
 * are the contract and are pinned as literals.
 */

// Every surface, taken from a production TOTAL record over `BlockHostSurface` so a
// new surface joins this ledger without anyone remembering to add it.
const ALL_SURFACES = Object.keys(BLOCK_HOST_DEEP_LINK_BASE) as BlockHostSurface[];

describe('readyWaitPolicyFor — the one surface check', () => {
  it('the ledger really is every surface (positive control)', () => {
    expect([...ALL_SURFACES].sort()).toEqual(
      ['dev-tunnel', 'model-slot', 'page-run', 'private-run', 'review-preview'].sort()
    );
  });

  it('dev-tunnel: 30 s, no auto-retry on timeout, dev-server copy', () => {
    expect(readyWaitPolicyFor('dev-tunnel')).toEqual({
      readyTimeoutMs: 30_000,
      autoRetryOnTimeout: false,
      timeoutCopy: 'dev-server',
    });
    expect(DEV_TUNNEL_READY_TIMEOUT_MS).toBe(30_000);
  });

  it('every OTHER surface: unchanged 10 s, auto-retry on timeout, default copy', () => {
    const others = ALL_SURFACES.filter((s) => s !== 'dev-tunnel');
    expect(others).toHaveLength(4);
    for (const surface of others) {
      expect(readyWaitPolicyFor(surface), surface).toEqual({
        readyTimeoutMs: 10_000,
        autoRetryOnTimeout: true,
        timeoutCopy: 'default',
      });
    }
    expect(BLOCK_READY_TIMEOUT_MS).toBe(10_000);
  });
});

describe('decideAutoRetry — autoRetryOnTimeout', () => {
  const base = { attempts: 0, reminted: 0, canRemint: true };

  it('false settles a `timeout` immediately', () => {
    expect(decideAutoRetry({ ...base, status: 'timeout', autoRetryOnTimeout: false })).toEqual({
      kind: 'none',
    });
  });

  it('omitted (every non-dev surface) still retries a `timeout`', () => {
    expect(decideAutoRetry({ ...base, status: 'timeout' }).kind).toBe('retry');
    expect(decideAutoRetry({ ...base, status: 'timeout', autoRetryOnTimeout: true }).kind).toBe(
      'retry'
    );
  });

  it('false touches ONLY `timeout` — fatal and auth terminals still auto-retry', () => {
    for (const status of ['fatal', 'no_token', 'error'] as const) {
      expect(decideAutoRetry({ ...base, status, autoRetryOnTimeout: false }).kind, status).toBe(
        'retry'
      );
    }
  });
});

/**
 * The launch-sample caps were derived for the 10 s window (`worstReachableLaunchMs`).
 * A dev-tunnel launch that succeeds on its FIRST attempt — the full token wait plus
 * the full 30 s window — must still be recorded, never dropped.
 */
describe('dev-tunnel first-attempt launch stays inside the sample caps', () => {
  it('duration: token wait + 30 s window < MAX_LAUNCH_SAMPLE_MS', () => {
    expect(TOKEN_WAIT_TIMEOUT_MS + DEV_TUNNEL_READY_TIMEOUT_MS).toBeLessThan(MAX_LAUNCH_SAMPLE_MS);
  });

  it('init posts: one 30 s attempt (+ the BLOCK_HELLO push) < MAX_LAUNCH_INIT_POSTS', () => {
    expect(maxInitPostsWithin(DEV_TUNNEL_READY_TIMEOUT_MS) + 1).toBeLessThan(MAX_LAUNCH_INIT_POSTS);
  });
});
