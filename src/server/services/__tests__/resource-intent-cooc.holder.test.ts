import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CoocCountAccumulator,
  serializeCoocCounts,
  serializeTrainImageIds,
} from '~/server/services/resource-intent-cooc/build';
import {
  COOC_FIRST_LOAD_WAIT_MS,
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
  completeCoocBuild,
  CoocSnapshotExpiredError,
  CoocSnapshotKindMismatchError,
  type CoocSql,
} from '~/server/services/resource-intent-cooc/store';
import { freshDb } from './resource-intent-cooc.harness';

/** The serving holder over the real migration (PGlite) and the real store. Synthetic data only. */

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const DAY = 86_400_000;

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

/** A `CoocSql` that counts payload loads and can be made to fail. */
function instrumented(sql: CoocSql) {
  const state = { loads: 0, latestReads: 0, fail: false };
  const wrapped: CoocSql = {
    query: async (s) => {
      if (state.fail) throw new Error('replica unavailable');
      if (s.text.includes('"payload"')) state.loads++;
      if (s.text.includes('LIMIT 1')) state.latestReads++;
      return sql.query(s);
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
    const holder = new CoocSnapshotHolder({ sql: () => probe.sql, now: () => clock });

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
    const holder = new CoocSnapshotHolder({ sql: () => sql, now: () => clock });
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

  it('a failed check keeps serving the snapshot already held', async () => {
    const { sql } = await freshDb();
    const hash = await build(sql, 'production', { token: 'zephyr', model: 77 });
    const probe = instrumented(sql);
    const failures: string[] = [];
    let clock = 1_000_000;
    const holder = new CoocSnapshotHolder({
      sql: () => probe.sql,
      now: () => clock,
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
    const holder = new CoocSnapshotHolder({ sql: () => probe.sql, now: () => clock });
    expect(await holder.resolve()).toEqual({ snapshot: null, fallbackReason: 'spec_mismatch' });
    clock += COOC_SNAPSHOT_POLL_MS;
    expect(await holder.resolve()).toEqual({ snapshot: null, fallbackReason: 'spec_mismatch' });
    expect(probe.state.loads).toBe(1);
    expect(probe.state.latestReads).toBe(2);
  });

  it('a first load slower than the wait serves the fallback (loading) instead of blocking', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const sql: CoocSql = {
      query: async () => {
        await gate;
        return [];
      },
      execute: async () => 0,
    };
    const holder = new CoocSnapshotHolder({ sql: () => sql });
    const pending = holder.resolve();
    await vi.advanceTimersByTimeAsync(COOC_FIRST_LOAD_WAIT_MS);
    expect(await pending).toEqual({ snapshot: null, fallbackReason: 'loading' });
    release();
    await vi.runAllTimersAsync();
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
