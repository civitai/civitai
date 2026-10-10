import { brotliCompressSync } from 'zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CoocCountAccumulator,
  deserializeCoocCounts,
  serializeCoocCounts,
  serializeTrainImageIds,
} from '~/server/services/resource-intent-cooc/build';
import {
  COOC_FIRST_LOAD_WAIT_MS,
  COOC_SNAPSHOT_LOAD_TIMEOUT_MS,
  COOC_SNAPSHOT_POLL_JITTER_MS,
  COOC_SNAPSHOT_POLL_MS,
  COOC_SNAPSHOT_RETRY_MS,
  CoocSnapshotHolder,
  CoocStudySnapshots,
} from '~/server/services/resource-intent-cooc/holder';
import { rankCooc } from '~/server/services/resource-intent-cooc/score';
import {
  RESOURCE_INTENT_COOC_SPEC,
  RESOURCE_INTENT_COOC_SPEC_HASH,
} from '~/server/services/resource-intent-cooc/spec';
import {
  beginCoocBuild,
  coocContentHash,
  completeCoocBuild,
  CoocSnapshotCorruptError,
  CoocSnapshotExpiredError,
  CoocSnapshotHashMismatchError,
  CoocSnapshotKindMismatchError,
  type CoocSql,
} from '~/server/services/resource-intent-cooc/store';
import type * as CoocBuild from '~/server/services/resource-intent-cooc/build';
import { asFixtureWriter, freshDb } from './resource-intent-cooc.harness';

// The real decoder, which one test makes fail once the way it would out of memory.
vi.mock('~/server/services/resource-intent-cooc/build', async (importOriginal) => {
  const actual = await importOriginal<typeof CoocBuild>();
  return { ...actual, deserializeCoocCounts: vi.fn(actual.deserializeCoocCounts) };
});

/** The serving holder over the real migration (PGlite) and the real store. Synthetic data only. */

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const DAY = 86_400_000;

type PGliteLike = Awaited<ReturnType<typeof freshDb>>['db'];

/** `model` co-occurs with `token` in 5 of 200 rows. */
function countsFor(token: string, model: number) {
  const acc = new CoocCountAccumulator(RESOURCE_INTENT_COOC_SPEC.addonTypes);
  for (let i = 0; i < 5; i++) acc.add([token], [[model, 'LORA']]);
  for (let i = 0; i < 195; i++) acc.add([], []);
  const {
    rawPairs: _p,
    rawVocab: _v,
    typeConflicts: _t,
    ...counts
  } = acc.finalize(RESOURCE_INTENT_COOC_SPEC);
  return counts;
}

async function build(
  sql: CoocSql,
  kind: 'production' | 'study',
  opts: { token: string; model: number; trainEndDaysAgo?: number; specHash?: string }
) {
  const now = new Date();
  const trainEnd = new Date(now.getTime() - (opts.trainEndDaysAgo ?? 2) * DAY);
  const { id } = await beginCoocBuild(sql, {
    kind,
    specHash: opts.specHash ?? RESOURCE_INTENT_COOC_SPEC_HASH,
    trainStart: new Date(trainEnd.getTime() - 120 * DAY),
    trainEnd,
    seed: opts.model,
    pinnedUntil: kind === 'study' ? new Date(now.getTime() + 30 * DAY) : null,
    now,
  });
  const counts = countsFor(opts.token, opts.model);
  const { contentHash } = await completeCoocBuild(sql, id, {
    payload: await serializeCoocCounts(counts),
    trainImageIds: await serializeTrainImageIds([1, 2]),
    trainCreatedAtMin: new Date(trainEnd.getTime() - 100 * DAY),
    trainCreatedAtMax: new Date(trainEnd.getTime() - 1),
    idsTried: 200,
    trainRows: counts.N,
    vocab: counts.vocab.length,
    models: counts.modelIds.length,
    keptPairs: counts.modelIdx.length,
  });
  return contentHash;
}

/**
 * A `CoocSql` that counts payload loads and queries still running, and can be made to fail: every
 * query (`fail`) or only the payload query (`failPayload`).
 */
function instrumented(sql: CoocSql) {
  const state = { loads: 0, latestReads: 0, pending: 0, fail: false, failPayload: false };
  const wrapped: CoocSql = {
    query: async (s) => {
      if (state.fail) throw new Error('replica unavailable');
      if (s.text.includes('"payload"')) state.loads++;
      if (state.failPayload && s.text.includes('"payload"'))
        throw new Error('connection terminated unexpectedly');
      if (s.text.includes('LIMIT 1')) state.latestReads++;
      state.pending++;
      try {
        return await sql.query(s);
      } finally {
        state.pending--;
      }
    },
    execute: sql.execute,
  };
  return { state, sql: wrapped };
}

const candidates = (scores: Parameters<typeof rankCooc>[0], token: string) =>
  rankCooc(scores, [token], ['LORA'], 10).map((c) => c.modelId);

afterEach(() => {
  vi.useRealTimers();
});

describe('CoocSnapshotHolder (production)', () => {
  it('no ready production snapshot ⇒ fallback no_snapshot, re-checked only after the poll', async () => {
    const { sql } = await freshDb();
    const probe = instrumented(sql);
    let clock = 1_000_000;
    const holder = new CoocSnapshotHolder({
      sql: () => probe.sql,
      now: () => clock,
      random: () => 0,
    });

    expect(await holder.resolve()).toEqual({ snapshot: null, fallbackReason: 'no_snapshot' });
    await holder.resolve();
    expect(probe.state.latestReads).toBe(1);

    const hash = await build(sql, 'production', { token: 'zephyr', model: 77 });
    clock += COOC_SNAPSHOT_POLL_MS - 1;
    expect((await holder.resolve()).snapshot).toBeNull();
    clock += 1;
    await holder.resolve(); // starts the check; nothing was held, so this call waited for it
    const served = await holder.resolve();
    expect(served.snapshot?.contentHash).toBe(hash);
    expect(candidates(served.snapshot!.scores, 'zephyr')).toEqual([77]);
  });

  it('a study snapshot is never served as production', async () => {
    const { sql } = await freshDb();
    await build(sql, 'study', { token: 'zephyr', model: 77 });
    const holder = new CoocSnapshotHolder({ sql: () => sql });
    expect(await holder.resolve()).toEqual({ snapshot: null, fallbackReason: 'no_snapshot' });
  });

  it('concurrent first requests share ONE load (single flight)', async () => {
    const { sql } = await freshDb();
    const hash = await build(sql, 'production', { token: 'zephyr', model: 77 });
    const probe = instrumented(sql);
    const holder = new CoocSnapshotHolder({ sql: () => probe.sql });
    const all = await Promise.all(Array.from({ length: 8 }, () => holder.resolve()));
    expect(all.map((r) => r.snapshot?.contentHash)).toEqual(Array(8).fill(hash));
    expect(probe.state.loads).toBe(1);
    expect(probe.state.latestReads).toBe(1);
  });

  it('a newer build is picked up at the next poll, and the old one serves until then', async () => {
    const { sql } = await freshDb();
    const old = await build(sql, 'production', { token: 'zephyr', model: 77, trainEndDaysAgo: 9 });
    let clock = 1_000_000;
    const holder = new CoocSnapshotHolder({ sql: () => sql, now: () => clock, random: () => 0 });
    expect((await holder.resolve()).snapshot?.contentHash).toBe(old);

    const fresh = await build(sql, 'production', {
      token: 'yarrow',
      model: 88,
      trainEndDaysAgo: 2,
    });
    clock += COOC_SNAPSHOT_POLL_MS;
    // A held snapshot never waits on the check: this call still answers with the old one.
    expect((await holder.resolve()).snapshot?.contentHash).toBe(old);
    await vi.waitFor(async () =>
      expect((await holder.resolve()).snapshot?.contentHash).toBe(fresh)
    );
  });

  it('a failed check with nothing held ⇒ load_failed, retried after 60 s, not the full poll', async () => {
    const { sql } = await freshDb();
    const hash = await build(sql, 'production', { token: 'zephyr', model: 77 });
    const probe = instrumented(sql);
    const failures: string[] = [];
    let clock = 1_000_000;
    const holder = new CoocSnapshotHolder({
      sql: () => probe.sql,
      now: () => clock,
      random: () => 0,
      onLoadFailure: (reason) => failures.push(reason),
    });
    probe.state.fail = true;
    expect(await holder.resolve()).toEqual({ snapshot: null, fallbackReason: 'load_failed' });
    expect(failures).toEqual(['load_failed']);

    probe.state.fail = false;
    clock += COOC_SNAPSHOT_RETRY_MS - 1;
    expect((await holder.resolve()).fallbackReason).toBe('load_failed');
    clock += 1;
    expect((await holder.resolve()).snapshot?.contentHash).toBe(hash);
  });

  it('🔴 a failed payload read is not remembered: the same snapshot is re-read at 60 s and served', async () => {
    const { sql } = await freshDb();
    const hash = await build(sql, 'production', { token: 'zephyr', model: 77 });
    const probe = instrumented(sql);
    const failures: string[] = [];
    let clock = 1_000_000;
    const holder = new CoocSnapshotHolder({
      sql: () => probe.sql,
      now: () => clock,
      random: () => 0,
      onLoadFailure: (reason) => failures.push(reason),
    });
    // The newest snapshot is found; only its load fails.
    probe.state.failPayload = true;
    expect(await holder.resolve()).toEqual({ snapshot: null, fallbackReason: 'load_failed' });
    expect(failures).toEqual(['load_failed']);
    expect(probe.state).toMatchObject({ latestReads: 1, loads: 1 });

    probe.state.failPayload = false;
    clock += COOC_SNAPSHOT_RETRY_MS - 1;
    expect((await holder.resolve()).fallbackReason).toBe('load_failed');
    expect(probe.state).toMatchObject({ latestReads: 1, loads: 1 });
    clock += 1;
    expect((await holder.resolve()).snapshot?.contentHash).toBe(hash);
    expect(probe.state).toMatchObject({ latestReads: 2, loads: 2 });
  });

  // Buffer and ArrayBuffer: live failures, as Node and V8 throw them. Brotli and zlib cannot be
  // made to fail allocating here, so those carry the codes Node gives them.
  const allocationFailure = (allocate: () => unknown) => {
    try {
      allocate();
    } catch (e) {
      return e;
    }
    throw new Error('allocation unexpectedly succeeded');
  };
  it.each([
    ['a Buffer', () => allocationFailure(() => Buffer.allocUnsafe(2 ** 52))],
    ['an ArrayBuffer', () => allocationFailure(() => new ArrayBuffer(2 ** 52))],
    [
      "brotli's ring buffer",
      () =>
        Object.assign(new Error('Decompression failed'), {
          code: 'ERR__ERROR_ALLOC_RING_BUFFER_1',
        }),
    ],
    [
      "zlib's state",
      () =>
        Object.assign(new Error('Initialization failed'), {
          code: 'ERR_ZLIB_INITIALIZATION_FAILED',
        }),
    ],
  ])(
    '🔴 running out of memory allocating %s while decoding a good snapshot is retried at 60 s, not remembered',
    async (_what, failure) => {
      const { sql } = await freshDb();
      const hash = await build(sql, 'production', { token: 'zephyr', model: 77 });
      const probe = instrumented(sql);
      const errors: unknown[] = [];
      let clock = 1_000_000;
      const holder = new CoocSnapshotHolder({
        sql: () => probe.sql,
        now: () => clock,
        random: () => 0,
        onLoadFailure: (_reason, error) => errors.push(error),
      });
      const error = failure();
      vi.mocked(deserializeCoocCounts).mockRejectedValueOnce(error);
      expect(await holder.resolve()).toEqual({ snapshot: null, fallbackReason: 'load_failed' });
      // The allocation error itself, not a corrupt-payload refusal wrapping it.
      expect(errors).toEqual([error]);

      clock += COOC_SNAPSHOT_RETRY_MS;
      expect((await holder.resolve()).snapshot?.contentHash).toBe(hash);
      expect(probe.state.loads).toBe(2);
    }
  );

  it('a failed check keeps serving the snapshot already held', async () => {
    const { sql } = await freshDb();
    const hash = await build(sql, 'production', { token: 'zephyr', model: 77 });
    const probe = instrumented(sql);
    const failures: string[] = [];
    let clock = 1_000_000;
    const holder = new CoocSnapshotHolder({
      sql: () => probe.sql,
      now: () => clock,
      random: () => 0,
      onLoadFailure: (reason) => failures.push(reason),
    });
    expect((await holder.resolve()).snapshot?.contentHash).toBe(hash);
    probe.state.fail = true;
    clock += COOC_SNAPSHOT_POLL_MS;
    await holder.resolve();
    await vi.waitFor(() => expect(failures).toEqual(['load_failed']));
    expect((await holder.resolve()).snapshot?.contentHash).toBe(hash);
  });

  it('a snapshot built under another cooc spec is refused once and not re-downloaded', async () => {
    const { sql } = await freshDb();
    await build(sql, 'production', { token: 'zephyr', model: 77, specHash: 'older-spec' });
    const probe = instrumented(sql);
    let clock = 1_000_000;
    const holder = new CoocSnapshotHolder({
      sql: () => probe.sql,
      now: () => clock,
      random: () => 0,
    });
    expect(await holder.resolve()).toEqual({ snapshot: null, fallbackReason: 'spec_mismatch' });
    clock += COOC_SNAPSHOT_POLL_MS;
    expect(await holder.resolve()).toEqual({ snapshot: null, fallbackReason: 'spec_mismatch' });
    expect(probe.state.loads).toBe(1);
    expect(probe.state.latestReads).toBe(2);
  });

  // Each corrupts the newest snapshot's stored row the way a bad write or a bad build could.
  it.each([
    [
      'bytes no longer matching its content hash',
      CoocSnapshotHashMismatchError,
      /content hash mismatch/,
      async (db: PGliteLike, hash: string) => {
        await asFixtureWriter(db, () =>
          db.query(
            `UPDATE "ResourceIntentCoocSnapshot" SET "payload" = $1 WHERE "contentHash" = $2`,
            [new Uint8Array([1, 2, 3]), hash]
          )
        );
      },
    ],
    [
      'a payload that matches its hash but fails count validation',
      CoocSnapshotCorruptError,
      /cooc counts invalid: N/,
      async (db: PGliteLike, hash: string) => {
        const bad = await serializeCoocCounts({ ...countsFor('zephyr', 77), N: -1 });
        const badHash = coocContentHash('production', bad);
        await asFixtureWriter(db, () =>
          db.query(
            `UPDATE "ResourceIntentCoocSnapshot" SET "payload" = $1, "contentHash" = $2 WHERE "contentHash" = $3`,
            [bad, badHash, hash]
          )
        );
      },
    ],
    [
      // A RangeError that is bad bytes, not low memory: a float64 marker with 2 of its 8 bytes.
      'a payload that matches its hash but msgpack reads past its end',
      CoocSnapshotCorruptError,
      /Offset is outside the bounds/,
      async (db: PGliteLike, hash: string) => {
        const bad = brotliCompressSync(Buffer.from([0xcb, 0, 0]));
        const badHash = coocContentHash('production', bad);
        await asFixtureWriter(db, () =>
          db.query(
            `UPDATE "ResourceIntentCoocSnapshot" SET "payload" = $1, "contentHash" = $2 WHERE "contentHash" = $3`,
            [bad, badHash, hash]
          )
        );
      },
    ],
  ])(
    '🔴 a snapshot with %s is snapshot_unservable once, not re-downloaded every 60 s; a new build still loads',
    async (_what, errorClass, message, corrupt) => {
      const { db, sql } = await freshDb();
      await corrupt(
        db,
        await build(sql, 'production', { token: 'zephyr', model: 77, trainEndDaysAgo: 9 })
      );
      const probe = instrumented(sql);
      const failures: string[] = [];
      const errors: unknown[] = [];
      let clock = 1_000_000;
      const holder = new CoocSnapshotHolder({
        sql: () => probe.sql,
        now: () => clock,
        random: () => 0,
        onLoadFailure: (reason, error) => (failures.push(reason), errors.push(error)),
      });
      expect(await holder.resolve()).toEqual({
        snapshot: null,
        fallbackReason: 'snapshot_unservable',
      });
      expect(failures).toEqual(['snapshot_unservable']);
      // The refusal this case means to reach, not some other error.
      expect(errors[0]).toBeInstanceOf(errorClass);
      expect((errors[0] as Error).message).toMatch(message);
      expect(probe.state).toMatchObject({ latestReads: 1, loads: 1 });

      // Not the transient 60 s retry: nothing is read at all until the poll.
      clock += COOC_SNAPSHOT_RETRY_MS;
      expect(await holder.resolve()).toEqual({
        snapshot: null,
        fallbackReason: 'snapshot_unservable',
      });
      expect(probe.state).toMatchObject({ latestReads: 1, loads: 1 });
      // At the poll the same snapshot is still the newest: checked, not downloaded again.
      clock += COOC_SNAPSHOT_POLL_MS;
      expect(await holder.resolve()).toEqual({
        snapshot: null,
        fallbackReason: 'snapshot_unservable',
      });
      expect(probe.state).toMatchObject({ latestReads: 2, loads: 1 });
      expect(failures).toEqual(['snapshot_unservable']);

      const fresh = await build(sql, 'production', { token: 'yarrow', model: 99 });
      clock += COOC_SNAPSHOT_POLL_MS;
      await holder.resolve();
      await vi.waitFor(async () =>
        expect((await holder.resolve()).snapshot?.contentHash).toBe(fresh)
      );
      expect(probe.state.loads).toBe(2);
    }
  );

  it('a slow first load: ONE request waits, later ones fall back at once, then the load is served', async () => {
    const { sql: real } = await freshDb();
    const hash = await build(real, 'production', { token: 'zephyr', model: 77 });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const sql: CoocSql = {
      query: async (q) => {
        await gate;
        return real.query(q);
      },
      execute: real.execute,
    };
    const holder = new CoocSnapshotHolder({ sql: () => sql, random: () => 0 });
    const first = holder.resolve();
    await vi.advanceTimersByTimeAsync(COOC_FIRST_LOAD_WAIT_MS);
    expect(await first).toEqual({ snapshot: null, fallbackReason: 'loading' });
    // The wait is spent for this load: the next request does not wait another 10 s.
    let settled = false;
    const second = holder.resolve().then((r) => ((settled = true), r));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(true);
    expect(await second).toEqual({ snapshot: null, fallbackReason: 'loading' });

    release();
    vi.useRealTimers();
    await vi.waitFor(async () => expect((await holder.resolve()).snapshot?.contentHash).toBe(hash));
  });

  it('a check that never settles is abandoned as load_failed and retried', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const failures: string[] = [];
    let calls = 0;
    let clock = 1_000_000;
    const sql: CoocSql = {
      query: () => {
        calls++;
        return new Promise(() => undefined);
      },
      execute: async () => 0,
    };
    const holder = new CoocSnapshotHolder({
      sql: () => sql,
      now: () => clock,
      random: () => 0,
      onLoadFailure: (reason) => failures.push(reason),
    });
    void holder.resolve();
    clock += COOC_SNAPSHOT_LOAD_TIMEOUT_MS;
    await vi.advanceTimersByTimeAsync(COOC_SNAPSHOT_LOAD_TIMEOUT_MS);
    expect(failures).toEqual(['load_failed']);
    expect(await holder.resolve()).toEqual({ snapshot: null, fallbackReason: 'load_failed' });
    expect(calls).toBe(1);
    // The retry is measured from the abandonment, not from when the check started.
    clock += COOC_SNAPSHOT_RETRY_MS - 1;
    void holder.resolve();
    expect(calls).toBe(1);
    clock += 1;
    void holder.resolve();
    expect(calls).toBe(2);
    await vi.advanceTimersByTimeAsync(COOC_SNAPSHOT_LOAD_TIMEOUT_MS);
  });

  it('the poll is jittered', async () => {
    const { sql } = await freshDb();
    const probe = instrumented(sql);
    let clock = 1_000_000;
    const holder = new CoocSnapshotHolder({
      sql: () => probe.sql,
      now: () => clock,
      random: () => 0.5,
    });
    await holder.resolve();
    clock += COOC_SNAPSHOT_POLL_MS + COOC_SNAPSHOT_POLL_JITTER_MS / 2 - 1;
    await holder.resolve();
    expect(probe.state.latestReads).toBe(1);
    clock += 1;
    await holder.resolve();
    expect(probe.state.latestReads).toBe(2);
  });

  it('a served snapshot that disappears is dropped (no_snapshot)', async () => {
    const { db, sql } = await freshDb();
    await build(sql, 'production', { token: 'zephyr', model: 77 });
    let clock = 1_000_000;
    const holder = new CoocSnapshotHolder({ sql: () => sql, now: () => clock, random: () => 0 });
    expect((await holder.resolve()).snapshot).not.toBeNull();
    await db.exec('DELETE FROM "ResourceIntentCoocSnapshot"');
    clock += COOC_SNAPSHOT_POLL_MS;
    await vi.waitFor(async () =>
      expect(await holder.resolve()).toEqual({ snapshot: null, fallbackReason: 'no_snapshot' })
    );
  });

  it('a newer build under another spec keeps the held one, once; a later good build replaces it', async () => {
    const { sql } = await freshDb();
    const old = await build(sql, 'production', { token: 'zephyr', model: 77, trainEndDaysAgo: 9 });
    const probe = instrumented(sql);
    const failures: string[] = [];
    let clock = 1_000_000;
    const holder = new CoocSnapshotHolder({
      sql: () => probe.sql,
      now: () => clock,
      random: () => 0,
      onLoadFailure: (reason) => failures.push(reason),
    });
    expect((await holder.resolve()).snapshot?.contentHash).toBe(old);

    await build(sql, 'production', {
      token: 'yarrow',
      model: 88,
      trainEndDaysAgo: 5,
      specHash: 'other',
    });
    clock += COOC_SNAPSHOT_POLL_MS;
    await holder.resolve();
    await vi.waitFor(() => expect(failures).toEqual(['spec_mismatch']));
    expect((await holder.resolve()).snapshot?.contentHash).toBe(old);
    // The next poll sees the same rejected hash and does not download it again.
    clock += COOC_SNAPSHOT_POLL_MS;
    await holder.resolve();
    // Settled: the poll ran and no query (a re-download would be one) is still running.
    await vi.waitFor(() => expect(probe.state).toMatchObject({ latestReads: 3, pending: 0 }));
    expect((await holder.resolve()).snapshot?.contentHash).toBe(old);
    expect(probe.state.loads).toBe(2); // the held one, and the mismatched one once

    const fresh = await build(sql, 'production', {
      token: 'yarrow',
      model: 99,
      trainEndDaysAgo: 2,
    });
    clock += COOC_SNAPSHOT_POLL_MS;
    await holder.resolve();
    await vi.waitFor(async () =>
      expect((await holder.resolve()).snapshot?.contentHash).toBe(fresh)
    );
  });
});

describe('CoocStudySnapshots', () => {
  it('loads a study snapshot by content hash, once', async () => {
    const { sql } = await freshDb();
    const hash = await build(sql, 'study', { token: 'zephyr', model: 77 });
    const probe = instrumented(sql);
    const studies = new CoocStudySnapshots({ sql: () => probe.sql });
    const now = new Date();
    const [a, b] = await Promise.all([studies.get(hash, now), studies.get(hash, now)]);
    expect(a.contentHash).toBe(hash);
    expect(b.contentHash).toBe(hash);
    expect(candidates(a.scores, 'zephyr')).toEqual([77]);
    expect(probe.state.loads).toBe(1);
  });

  it('refuses a production snapshot', async () => {
    const { sql } = await freshDb();
    const hash = await build(sql, 'production', { token: 'zephyr', model: 77 });
    const studies = new CoocStudySnapshots({ sql: () => sql });
    await expect(studies.get(hash, new Date())).rejects.toBeInstanceOf(
      CoocSnapshotKindMismatchError
    );
  });

  it('refuses a held snapshot once its pin passes', async () => {
    const { sql } = await freshDb();
    const hash = await build(sql, 'study', { token: 'zephyr', model: 77 });
    const studies = new CoocStudySnapshots({ sql: () => sql });
    await studies.get(hash, new Date());
    await expect(studies.get(hash, new Date(Date.now() + 31 * DAY))).rejects.toBeInstanceOf(
      CoocSnapshotExpiredError
    );
  });

  it('refuses an unknown hash, and a later attempt reads again', async () => {
    const { sql } = await freshDb();
    const probe = instrumented(sql);
    const studies = new CoocStudySnapshots({ sql: () => probe.sql });
    await expect(studies.get('0'.repeat(64), new Date())).rejects.toThrow('not found');
    await expect(studies.get('0'.repeat(64), new Date())).rejects.toThrow('not found');
    expect(probe.state.loads).toBe(2);
  });
});
