import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Shared-storage read-cache invalidation PARITY guard (both hosts, all writes).
 *
 * THE BUG CLASS: civitai's QueryClient is `staleTime: Infinity`, and the hosts
 * serve shared-storage reads through React Query `fetchQuery`, which never
 * refetches a non-stale entry. So a shared-storage WRITE that does not
 * invalidate leaves the block's OWN next read serving the pre-write snapshot for
 * the whole page lifetime. See `sharedStorageInvalidation.ts`.
 *
 * Why a STRUCTURAL grep and not only browser tests: the behavioural pins live in
 * `PageBlockHostSharedStorage.browser.test.tsx`, which mounts the real page host
 * — but `IframeHost` (the model-slot host) wires the same six shared-storage
 * writes and has NO shared-storage browser suite. Six of the twelve call sites
 * would otherwise be covered by nothing at all. This guard is what makes the two
 * hosts move in lockstep (the same reason `hostHandlerParity.ts` exists), and
 * what fails when a SEVENTH shared write is added to one host and not wired.
 *
 * It asserts a RELATIONSHIP, not a component: for every shared-storage mutation,
 * the source between the `mutateAsync` call and the reply that follows it must
 * contain the invalidation. That encodes both halves of the contract — that it
 * happens at all, and that it happens BEFORE the reply (ordering is load-bearing:
 * a block may re-read the instant its reply resolves).
 */

const HOST_DIR = __dirname;

type HostFile = 'IframeHost.tsx' | 'PageBlockHost.tsx';

const HOSTS: HostFile[] = ['IframeHost.tsx', 'PageBlockHost.tsx'];

/**
 * Every shared-storage WRITE the hosts bridge. If the SDK/protocol grows a
 * seventh, add it here — the count assertion below is what forces that.
 */
const SHARED_WRITE_MUTATIONS = [
  'sharedAppendMutation',
  'sharedUpdateMutation',
  'sharedVoteMutation',
  'sharedUnvoteMutation',
  'sharedWithdrawMutation',
  'sharedReportMutation',
] as const;

const HELPER = 'invalidateSharedStorageReads';

function readHost(f: HostFile): string {
  return readFileSync(join(HOST_DIR, f), 'utf8');
}

describe('shared-storage writes invalidate the read cache — both hosts', () => {
  it.each(HOSTS)('%s imports the shared invalidation helper', (host) => {
    expect(readHost(host)).toContain(`import { ${HELPER} }`);
  });

  it.each(HOSTS)('%s invalidates once per shared write, and no more', (host) => {
    const src = readHost(host);
    // Import line + one call per write.
    const calls = src.split(`await ${HELPER}(`).length - 1;
    expect(calls).toBe(SHARED_WRITE_MUTATIONS.length);
  });

  // The relationship that actually matters: between each write and its reply.
  for (const host of HOSTS) {
    for (const mutation of SHARED_WRITE_MUTATIONS) {
      it(`${host}: ${mutation} invalidates BEFORE it replies`, () => {
        const src = readHost(host);
        const callIdx = src.indexOf(`await ${mutation}.mutateAsync(`);
        expect(
          callIdx,
          `${host} does not call ${mutation}.mutateAsync — did the handler move or get renamed?`
        ).toBeGreaterThan(-1);

        // The success reply is the first `send(` after the write returns.
        const afterCall = src.slice(callIdx);
        const sendIdx = afterCall.indexOf('send(');
        expect(sendIdx, `${host}: no reply found after ${mutation}`).toBeGreaterThan(-1);

        const between = afterCall.slice(0, sendIdx);
        expect(
          between,
          `${host}: ${mutation} replies without invalidating first — the block's own ` +
            `next read will be served from the staleTime:Infinity cache`
        ).toContain(HELPER);
      });
    }
  }

  it('the mutation list matches what the hosts actually declare', () => {
    // Positive control on the list above: if a host gains a seventh shared write
    // hook, this fails rather than silently leaving it unguarded. Without it,
    // every assertion above stays green while the new write goes uncovered.
    for (const host of HOSTS) {
      const src = readHost(host);
      const declared = [...src.matchAll(/const (shared\w+Mutation) = trpc\.apps\.shared\./g)].map(
        (m) => m[1]
      );
      expect(declared.sort()).toEqual([...SHARED_WRITE_MUTATIONS].sort());
    }
  });
});
