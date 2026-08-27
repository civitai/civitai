import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BLOCK_STORAGE_READ_STALE_TIME_MS } from './blockStorageCache';

/**
 * Block storage read-cache PARITY guard — both hosts, every read AND every write.
 *
 * THE BUG CLASS: civitai's QueryClient is `staleTime: Infinity`, and the hosts
 * serve storage reads through React Query `fetchQuery`, which never refetches a
 * non-stale entry. An unbounded read never observes another user's write; an
 * un-invalidated write is not even visible to its own author. See
 * `blockStorageCache.ts`.
 *
 * Why a STRUCTURAL grep and not only browser tests: the behavioural pins live in
 * `PageBlockHostSharedStorage.browser.test.tsx`, which mounts the real page host
 * — but `IframeHost` wires the same bridges and has NO shared-storage browser
 * suite, so half the call sites would otherwise be covered by nothing. This is
 * what makes the two hosts move in lockstep (same reason `hostHandlerParity.ts`
 * exists), and what fails when a new read or write is added to one host only.
 *
 * 🔴 IT STRIPS COMMENTS FIRST, and that is load-bearing. An earlier version
 * grepped raw source, so commenting a call out — `// await invalidate…` — left
 * the guard fully green while the protection was gone. An adversarial audit
 * demonstrated exactly that one-line walk-past on IframeHost, the host this
 * guard is the only coverage for.
 *
 * 🔴 BE PRECISE ABOUT WHAT THIS CERTIFIES: it is a TEXT predicate, so what it
 * proves is that the call's characters appear in the right window — not that
 * the call executes. A later audit showed the remaining hole: an inert string
 * literal containing the call's text still satisfies it. Deletion, commenting
 * out and reordering (the regressions that actually happen) are all caught;
 * deliberately inert look-alike text is not. Do not read a green run here as
 * "the invalidation runs" — that claim belongs to the browser tests and to
 * `blockStorageCacheSemantics.test.ts`.
 */

const HOST_DIR = __dirname;

type HostFile = 'IframeHost.tsx' | 'PageBlockHost.tsx';
const HOSTS: HostFile[] = ['IframeHost.tsx', 'PageBlockHost.tsx'];

/** Every shared (cross-user) write the hosts bridge. */
const SHARED_WRITE_MUTATIONS = [
  'sharedAppendMutation',
  'sharedUpdateMutation',
  'sharedVoteMutation',
  'sharedUnvoteMutation',
  'sharedWithdrawMutation',
  'sharedReportMutation',
] as const;

/** Every per-user (private KV) write the hosts bridge. */
const PRIVATE_WRITE_MUTATIONS = ['storageSetMutation', 'storageDeleteMutation'] as const;

const EXPECTED_READS = 7; // shared: list/get/getCount/getCounts · storage: get/list/getQuota

/**
 * Strip block and line comments so the assertions below cannot be satisfied by
 * commented-out code.
 *
 * Still naive — it does not parse string or regex literals, so a `/*` inside a
 * string would over-strip. The line-comment half is anchored to line-start
 * precisely because the unanchored version DID over-strip real code. An
 * over-strip removes a real call and causes a spurious FAILURE a human then
 * investigates, which is the safe direction; the theoretical way it could
 * invent coverage is by deleting a `send(` and widening an ordering window
 * into a neighbouring handler. No such construction was reachable when this was
 * checked, but it is not proven impossible — hence "safe direction", not
 * "cannot".
 *
 * Mirrors `hostHandlerParity.test.ts`'s `stripComments`, same rationale.
 */
function stripComments(src: string): string {
  return (
    src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      // Line comments ONLY where `//` opens the line (after indentation). A
      // commented-out call is always that shape, and anchoring here avoids
      // truncating real code that merely CONTAINS `//` — e.g. the open-redirect
      // guard `cleaned.includes('//')` in PageBlockHost, which the previous
      // unanchored version chopped mid-condition.
      .replace(/^[ \t]*\/\/[^\n]*$/gm, '')
  );
}

function readHost(f: HostFile): string {
  return stripComments(readFileSync(join(HOST_DIR, f), 'utf8'));
}

/** Raw (un-stripped) source — only for asserting the comment-strip itself works. */
function readHostRaw(f: HostFile): string {
  return readFileSync(join(HOST_DIR, f), 'utf8');
}

describe('block storage cache policy — both hosts', () => {
  it('the stale-time bound is short but non-zero', () => {
    // Pins the two properties the module argues for: bounded (so a cross-user
    // write becomes visible without a reload) and NOT zero (so these
    // unrate-limited public reads keep an incidental burst ceiling).
    expect(BLOCK_STORAGE_READ_STALE_TIME_MS).toBeGreaterThan(0);
    expect(BLOCK_STORAGE_READ_STALE_TIME_MS).toBeLessThanOrEqual(5_000);
  });

  it('pins the stale-time VALUE, not merely its range', () => {
    // Every other assertion references the constant, so by construction none of
    // them can see the value move: raising it 1s -> 5s once left the whole suite
    // green, i.e. a 5x cross-user-freshness regression would have shipped
    // unremarked. This is the one place the number itself is asserted.
    //
    // Changing it is a legitimate product decision — change it HERE too, and say
    // why in the commit. The point is that it cannot move silently.
    expect(BLOCK_STORAGE_READ_STALE_TIME_MS).toBe(1_000);
  });

  it.each(HOSTS)('%s imports the shared cache policy module', (host) => {
    expect(readHost(host)).toContain("from '~/components/AppBlocks/blockStorageCache'");
  });

  // ── READS: every one bounded ────────────────────────────────────────────────
  it.each(HOSTS)('%s bounds every storage read with the shared staleTime', (host) => {
    const src = readHost(host);
    const reads = [...src.matchAll(/trpcUtils\.apps\.(?:shared|storage)\.[A-Za-z]+\.fetch\(/g)];
    expect(reads.length, `${host}: read count moved — update EXPECTED_READS deliberately`).toBe(
      EXPECTED_READS
    );
    // Check each call SITE, not a text count. An earlier version counted
    // `BLOCK_STORAGE_READ_OPTS)` — which pins the FORMATTING, not the state:
    // Prettier moved the argument onto its own line and the guard read 0 of 7
    // bounded while every read was in fact bounded. Assert the state.
    const unbounded = reads
      .map((m) => {
        const from = m.index ?? 0;
        const window = src.slice(from, from + 800);
        const replyAt = window.indexOf('send(');
        const callText = replyAt === -1 ? window : window.slice(0, replyAt);
        return callText.includes('BLOCK_STORAGE_READ_OPTS') ? null : m[0];
      })
      .filter(Boolean);
    expect(
      unbounded,
      `${host}: ${unbounded.length} storage read(s) are UNBOUNDED — under ` +
        `staleTime:Infinity they will never observe another user's write`
    ).toEqual([]);
  });

  // ── WRITES: every one invalidates, before it replies ─────────────────────────
  it.each(HOSTS)('%s invalidates once per write, and no more', (host) => {
    const src = readHost(host);
    const shared = src.split('await invalidateSharedStorageReads(').length - 1;
    const priv = src.split('await invalidatePrivateStorageReads(').length - 1;
    expect(shared).toBe(SHARED_WRITE_MUTATIONS.length);
    expect(priv).toBe(PRIVATE_WRITE_MUTATIONS.length);
  });

  for (const host of HOSTS) {
    for (const [mutation, helper] of [
      ...SHARED_WRITE_MUTATIONS.map((m) => [m, 'invalidateSharedStorageReads'] as const),
      ...PRIVATE_WRITE_MUTATIONS.map((m) => [m, 'invalidatePrivateStorageReads'] as const),
    ]) {
      it(`${host}: ${mutation} invalidates BEFORE it replies`, () => {
        const src = readHost(host);
        const callIdx = src.indexOf(`await ${mutation}.mutateAsync(`);
        expect(
          callIdx,
          `${host} does not call ${mutation}.mutateAsync — did the handler move or get renamed?`
        ).toBeGreaterThan(-1);

        const afterCall = src.slice(callIdx);
        const sendIdx = afterCall.indexOf('send(');
        expect(sendIdx, `${host}: no reply found after ${mutation}`).toBeGreaterThan(-1);

        expect(
          afterCall.slice(0, sendIdx),
          `${host}: ${mutation} replies without invalidating first — the block's own next ` +
            `read is served from cache`
        ).toContain(helper);
      });
    }
  }

  // ── Controls on the guard itself ────────────────────────────────────────────
  it('the comment-strip actually removes a commented-out call', () => {
    // The guard above is only as good as this. Without it, `// await
    // invalidateSharedStorageReads(...)` satisfies every assertion in this file
    // — measured: an audit walked past the previous version exactly that way.
    const withComment = [
      '      const x = 1;',
      '      // await invalidateSharedStorageReads(trpcUtils);',
      '      /* await invalidatePrivateStorageReads(trpcUtils); */',
      '      await realCall();',
    ].join('\n');
    const stripped = stripComments(withComment);
    expect(stripped).not.toContain('invalidateSharedStorageReads');
    expect(stripped).not.toContain('invalidatePrivateStorageReads');
    expect(stripped).toContain('realCall');
  });

  it('the comment-strip preserves real code containing // (regression)', () => {
    // A URL, and the actual line the unanchored version truncated.
    expect(stripComments("const u = 'https://example.com/x'; // trailing")).toContain(
      'https://example.com/x'
    );
    const redirectGuard = "    if (cleaned.startsWith('/') || cleaned.includes('//')) {";
    expect(stripComments(redirectGuard)).toContain("includes('//')");
  });

  it('every host really does carry comments (the strip is not a no-op)', () => {
    // Positive control: if the hosts had no comments, the strip would be inert
    // and the assertion above would prove nothing about these files.
    for (const host of HOSTS) {
      expect(readHostRaw(host).length).toBeGreaterThan(readHost(host).length);
    }
  });

  it('the write ledger matches what the hosts actually declare', () => {
    // If a host gains another storage write, this fails rather than silently
    // leaving it unguarded.
    for (const host of HOSTS) {
      const src = readHost(host);
      const shared = [...src.matchAll(/const (shared\w+Mutation) = trpc\.apps\.shared\./g)].map(
        (m) => m[1]
      );
      const priv = [...src.matchAll(/const (storage\w+Mutation) = trpc\.apps\.storage\./g)].map(
        (m) => m[1]
      );
      expect(shared.sort()).toEqual([...SHARED_WRITE_MUTATIONS].sort());
      expect(priv.sort()).toEqual([...PRIVATE_WRITE_MUTATIONS].sort());
    }
  });
});
