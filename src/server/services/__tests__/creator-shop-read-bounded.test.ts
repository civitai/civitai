import { describe, expect, it, vi } from 'vitest';

/**
 * Direct unit tests for `readBounded` — the bounded stream read behind `validateArtwork`.
 *
 * 🔴 WHY THIS FILE EXISTS. The service-level suite exercised `readBounded` only through mocked
 * `fetch` responses, and every one of those either supplied no `body` (taking the
 * `arrayBuffer` FALLBACK) or was an oversize case that threw before the return. So the
 * STREAMING SUCCESS PATH — the only path the docblock says production ever takes — was
 * untested. MEASURED (re-measured for this commit): replacing `return Buffer.concat(chunks,
 * total)` with `return Buffer.alloc(0)` leaves every OTHER `creator-shop-*.test.ts` suite in
 * `src/server/services/__tests__/` fully GREEN — 13 files, 151 tests, the population enumerated
 * by that glob minus this file — while two rows in THIS file go red (`expected +0 to be 9`,
 * `expected +0 to be 100`). An earlier draft of this docblock put that surviving population at
 * "all five creator-shop suites GREEN (40/40)"; the glob holds 13 suites and 151 tests. (The
 * four `creator-shop-*` suites under `src/server/__tests__/` were not in the measured set.)
 *
 * That gap matters beyond "a test is missing": the bytes this returns are sha256'd into
 * `CosmeticShopItem.meta` and read back by `findDuplicateArtwork`, so a silent truncation or
 * mis-offset would corrupt duplicate detection rather than fail loudly.
 *
 * FIXTURES. Four rows pass `{ body: <real ReadableStream> }` object literals, so those
 * assertions are against genuine web-stream semantics rather than a mock's idea of them. The
 * other three pass hand-rolled `getReader()` mocks with no stream at all — deliberately, because
 * they pin reader-level behaviour (`cancel()` being called, a `{done:false, value:undefined}`
 * yield) that a real stream cannot be made to produce. No `Response` object appears in this
 * file; an earlier draft of this docblock claimed one did.
 */

vi.mock('~/server/services/blocklist.service', () => ({ throwOnBlockedUserContent: vi.fn() }));
vi.mock('~/server/redis/caches', () => ({ refreshOwnedStickerCache: vi.fn() }));
vi.mock('~/server/services/cosmetic-phash.service', () => ({
  queueCosmeticPerceptualHash: vi.fn(),
}));
vi.mock('~/server/services/placement-moderation.service', () => ({
  removePlacementsByCosmetic: vi.fn(),
}));
vi.mock('sharp', () => ({ default: vi.fn() }));
vi.mock('~/env/client', () => ({ env: { NEXT_PUBLIC_IMAGE_LOCATION: 'https://image.test' } }));

import { ARTWORK_MAX_BYTES, readBounded } from '~/server/services/creator-shop.service';
import { constants } from '~/server/common/constants';

/** A real ReadableStream emitting the given chunks, so web-stream semantics are genuine. */
const streamOf = (chunks: Uint8Array[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });

describe('readBounded — streaming success path', () => {
  it('returns the EXACT bytes, in order, across multiple chunks', async () => {
    // 🔴 The row that kills `return Buffer.alloc(0)` and every truncation/mis-offset mutant.
    // Distinct byte values per chunk on purpose: a fixture of all-zero chunks would pass
    // against a wrong offset, since every byte would compare equal to every other.
    const a = new Uint8Array([1, 2, 3]);
    const b = new Uint8Array([4, 5]);
    const c = new Uint8Array([6, 7, 8, 9]);

    const out = await readBounded({ body: streamOf([a, b, c]) } as never, 1024);

    expect(out.byteLength).toBe(9);
    expect([...out]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('returns an empty buffer for an empty stream, without throwing', async () => {
    const out = await readBounded({ body: streamOf([]) } as never, 1024);
    expect(out.byteLength).toBe(0);
  });

  it('accepts a body exactly AT the cap — the bound is > not >=', async () => {
    // ⚠ TWO RETRACTIONS. An earlier comment here said the value was "chosen to overshoot rather
    // than sit on a power-of-two multiple of the chunk size" — that rationale was borrowed and
    // is about nothing at this row: the fixture is a SINGLE 100-byte chunk against a cap of 100,
    // so no chunk-size/step relationship exists to overshoot. And it said "an off-by-one in
    // either direction changes this row's verdict", which is false in the loose direction.
    //
    // MEASURED, both directions, on `if (total > maxBytes)` in `readBounded`:
    //   * `total >= maxBytes` (tight) — THIS row goes red, 1 failed | 8 passed.
    //   * `total > maxBytes + 1` (loose) — this row stays GREEN; the red one is the sibling
    //     `throws once the running total EXCEEDS the cap` row, 1 failed | 8 passed.
    // So the boundary IS pinned in both directions, by the PAIR of rows, not by this row alone.
    // Deleting either row reopens one side. Beyond equalling the cap, the number 100 carries no
    // further justification — none is claimed here.
    const out = await readBounded({ body: streamOf([new Uint8Array(100)]) } as never, 100);
    expect(out.byteLength).toBe(100);
  });
});

describe('readBounded — the bound', () => {
  it('throws once the running total EXCEEDS the cap', async () => {
    await expect(
      readBounded({ body: streamOf([new Uint8Array(101)]) } as never, 100)
    ).rejects.toThrow('artwork too large');
  });

  it('stops READING at the bound rather than draining the whole body', async () => {
    // 🔴 This is the property the cap exists for — it is a MEMORY bound, so what matters is
    // that the read stopped, not merely that it threw afterwards. Counting pulls is the only
    // way to tell those apart: a buffer-then-check implementation drains all 50 chunks and
    // still throws, passing a rejects-only assertion.
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        if (pulled > 50) return controller.close();
        controller.enqueue(new Uint8Array(10));
      },
    });

    await expect(readBounded({ body } as never, 25)).rejects.toThrow('artwork too large');
    expect(pulled).toBeLessThan(10);
  });

  it('cancels the reader, releasing the connection', async () => {
    // 🔴 THE MOCK IS BOUNDED DELIBERATELY, for the same reason as the empty-chunk row below.
    // An unbounded reader — always `{done:false, value:<chunk>}` — terminates only because the
    // IN-LOOP size check throws, so when that check is moved OUT of the loop (exactly the
    // regression this file exists to catch) the loop accumulates forever. MEASURED: with the
    // unbounded fixture and the bound moved after the read loop, a whole-file run died with
    // `FATAL ERROR: Ineffective mark-compacts near heap limit` / `Worker exited unexpectedly`
    // and reported ZERO of 9 results — the OOM suppresses every other row's verdict, including
    // the one that catches the regression. Bounding the pulls keeps the failure attributable.
    let reads = 0;
    const cancel = vi.fn(async () => undefined);
    const body = {
      getReader: () => ({
        read: async () =>
          ++reads > 2
            ? { done: true, value: undefined }
            : { done: false, value: new Uint8Array(10) },
        cancel,
      }),
    };

    await expect(readBounded({ body } as never, 5)).rejects.toThrow('artwork too large');
    // The docblock claims cancel() releases the connection; nothing asserted it until now,
    // and deleting the whole `finally` block left the service suite green.
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('throws rather than spinning if a stream ever yields no chunk while not done', async () => {
    // Unreachable against undici, pinned because the alternative (`continue`) is an
    // unrecoverable event-loop wedge that the AbortSignal timer cannot interrupt.
    //
    // 🔴 THE MOCK IS BOUNDED DELIBERATELY. An unbounded one — always `{done:false,
    // value:undefined}` — makes this row HANG rather than fail when someone reintroduces
    // `continue`, and vitest's own test timeout CANNOT rescue it, because the tight await-loop
    // starves the macrotask queue that timer lives on. MEASURED: a sweep with the unbounded
    // mock wedged and had to be killed by PID. A test that hangs CI is worse than one that
    // fails it, so the fixture yields a few empty chunks and then completes: with the throw it
    // rejects, and with `continue` it returns an empty buffer and this row fails FAST.
    let reads = 0;
    const body = {
      getReader: () => ({
        read: async () =>
          ++reads > 3 ? { done: true, value: undefined } : { done: false, value: undefined },
        cancel: async () => undefined,
      }),
    };
    await expect(readBounded({ body } as never, 1024)).rejects.toThrow('empty chunk');
  });
});

describe('readBounded — the fallback', () => {
  it('falls back to arrayBuffer() when there is no readable body', async () => {
    const out = await readBounded(
      { body: null, arrayBuffer: async () => new Uint8Array([7, 7]).buffer } as never,
      1024
    );
    expect([...out]).toEqual([7, 7]);
  });
});

describe('the artwork cap is the PRODUCT limit, not a second number', () => {
  it('is exactly `constants.mediaUpload.maxImageFileSize`', () => {
    // 🔴 Identity, not magnitude. MEASURED: swapping in `maxOrchestratorImageFileSize` left
    // the service suite fully green, because its size fixtures only bound the cap loosely.
    // The creator is shown "Under 50 MB" derived from THIS constant, so any other value
    // reopens a window where a legal upload is refused server-side.
    expect(ARTWORK_MAX_BYTES).toBe(constants.mediaUpload.maxImageFileSize);
  });
});
