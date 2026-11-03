import { describe, expect, it } from 'vitest';
import type {
  BuildCheckpoint,
  CheckpointStore,
  IndexSource,
} from '~/server/search/opensearch/index-build';
import { buildIndex, rollbackAlias } from '~/server/search/opensearch/index-build';
import type {
  BulkOperation,
  BulkResult,
  OpenSearchClient,
} from '~/server/search/opensearch/opensearch-client';

// In-memory stand-in for the engine: concrete indexes, aliases, and a hook to refuse bulk items.
function fakeEngine() {
  const indexes = new Map<string, Map<string, unknown>>();
  const aliases = new Map<string, string>();
  let refuse: ((index: string, op: BulkOperation) => 'retry' | 'reject' | null) | null = null;
  const client = {
    indexExists: async (i: string) => indexes.has(i),
    createIndex: async (i: string) => void indexes.set(i, new Map()),
    deleteIndex: async (i: string) => void indexes.delete(i),
    updateSettings: async () => undefined,
    refresh: async () => undefined,
    count: async (i: string) => indexes.get(i)!.size,
    aliasTargets: async (a: string) => (aliases.has(a) ? [aliases.get(a)!] : []),
    listIndexes: async (prefix: string) =>
      [...indexes.keys()].filter((i) => i.startsWith(prefix)).sort(),
    swapAlias: async (a: string, i: string) => void aliases.set(a, i),
    bulk: async (i: string, ops: BulkOperation[]): Promise<BulkResult> => {
      const result: BulkResult = { rejected: [], retryable: [] };
      for (const op of ops) {
        const verdict = refuse?.(i, op);
        if (verdict === 'retry') result.retryable.push(String(op.id));
        else if (verdict === 'reject')
          result.rejected.push({ id: String(op.id), status: 400, reason: 'bad' });
        else if (op.action === 'index') indexes.get(i)!.set(String(op.id), op.document);
        else indexes.get(i)!.delete(String(op.id));
      }
      return result;
    },
  } as unknown as OpenSearchClient;
  return {
    client,
    indexes,
    aliases,
    setRefuse: (fn: typeof refuse) => (refuse = fn),
    served: (alias: string) => indexes.get(aliases.get(alias)!)!,
  };
}

function memoryCheckpoints() {
  const store = new Map<string, BuildCheckpoint>();
  const saved: number[] = [];
  const checkpoints: CheckpointStore = {
    get: async (a) => store.get(a) ?? null,
    set: async (a, c) => {
      store.set(a, c);
      saved.push(c.watermark);
    },
    clear: async (a) => void store.delete(a),
  };
  return { checkpoints, store, saved };
}

// A table of rows; `doc(id)` is what the index should hold for it.
function table(ids: number[]) {
  const rows = new Map(ids.map((id) => [id, { id, v: 1 }]));
  const scans: number[] = [];
  let failOnce: ((ids: number[]) => boolean) | null = null;
  const source: IndexSource = {
    nextIds: async (afterId, limit) => {
      scans.push(afterId);
      return [...rows.keys()]
        .filter((id) => id > afterId)
        .sort((a, b) => a - b)
        .slice(0, limit);
    },
    buildDocuments: async (batch) => {
      if (failOnce?.(batch)) {
        failOnce = null;
        throw new Error('database went away');
      }
      return new Map(batch.filter((id) => rows.has(id)).map((id) => [id, { ...rows.get(id)! }]));
    },
    changedSince: async () => [...changed],
  };
  const changed = new Set<number>();
  return { rows, source, scans, changed, failOn: (fn: typeof failOnce) => (failOnce = fn) };
}

const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);
const clock = (...isoTimes: string[]) => {
  let i = 0;
  return () => new Date(isoTimes[Math.min(i++, isoTimes.length - 1)]);
};
const noSleep = async () => undefined;

describe('buildIndex', () => {
  it('builds every row into a new index, swaps the alias, and keeps the previous build for rollback', async () => {
    const engine = fakeEngine();
    const { checkpoints } = memoryCheckpoints();
    const rows = range(1, 95);
    const run = (at: string) =>
      buildIndex({
        alias: 'models',
        client: engine.client,
        source: table(rows).source,
        checkpoints,
        definition: { mappings: {} },
        batchSize: 10,
        concurrency: 3,
        now: clock(at),
        sleep: noSleep,
      });

    await run('2026-11-01T00:00:00Z');
    await run('2026-11-02T00:00:00Z');
    const third = await run('2026-11-03T00:00:00Z');

    expect(engine.aliases.get('models')).toBe('models_20261103000000');
    expect([...engine.served('models').keys()].map(Number).sort((a, b) => a - b)).toEqual(rows);
    expect(third.documents).toBe(95);
    // One previous build kept, the oldest dropped.
    expect([...engine.indexes.keys()].sort()).toEqual([
      'models_20261102000000',
      'models_20261103000000',
    ]);
  });

  it('leaves the serving index alone when a build fails, and resumes from its checkpoint', async () => {
    const engine = fakeEngine();
    const { checkpoints, store } = memoryCheckpoints();
    const t = table(range(1, 100));
    const opts = {
      alias: 'models',
      client: engine.client,
      source: t.source,
      checkpoints,
      definition: { mappings: {} },
      batchSize: 10,
      concurrency: 1,
      sleep: noSleep,
    };
    await buildIndex({ ...opts, now: clock('2026-11-01T00:00:00Z') });
    t.rows.set(101, { id: 101, v: 1 });

    t.failOn((batch) => batch.includes(61));
    await expect(buildIndex({ ...opts, now: clock('2026-11-02T00:00:00Z') })).rejects.toThrow(
      'database went away'
    );
    expect(engine.aliases.get('models')).toBe('models_20261101000000');
    expect(engine.served('models').has('101')).toBe(false);
    expect(store.get('models')?.watermark).toBe(60);

    const scansBefore = t.scans.length;
    const resumed = await buildIndex({ ...opts, now: clock('2026-11-02T05:00:00Z') });
    expect(resumed.resumed).toBe(true);
    expect(t.scans[scansBefore]).toBe(60); // picked up at the checkpoint, not at 0
    expect(engine.aliases.get('models')).toBe('models_20261102000000');
    expect(engine.served('models').size).toBe(101);
    expect(store.has('models')).toBe(false);
  });

  it('never checkpoints past a batch that has not finished, even when later batches have', async () => {
    const engine = fakeEngine();
    const { checkpoints, saved } = memoryCheckpoints();
    const t = table(range(1, 60));
    // The first batch is slow and then fails; batches after it finish first.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const build = t.source.buildDocuments;
    t.source.buildDocuments = async (ids) => {
      if (ids[0] === 1) {
        await gate;
        throw new Error('slow batch failed');
      }
      const docs = await build(ids);
      if (ids[0] === 41) release();
      return docs;
    };

    await expect(
      buildIndex({
        alias: 'models',
        client: engine.client,
        source: t.source,
        checkpoints,
        definition: { mappings: {} },
        batchSize: 10,
        concurrency: 6,
        sleep: noSleep,
        now: clock('2026-11-01T00:00:00Z'),
      })
    ).rejects.toThrow('slow batch failed');
    expect(Math.max(0, ...saved)).toBe(0);
  });

  it('rewrites rows that changed during the scan, removing the ones that no longer belong', async () => {
    const engine = fakeEngine();
    const { checkpoints } = memoryCheckpoints();
    const t = table(range(1, 30));
    const build = t.source.buildDocuments;
    t.source.buildDocuments = async (ids) => {
      const docs = await build(ids);
      if (ids.includes(30)) {
        // While the last batch is read: row 5 is edited and row 7 unpublished, both already written.
        t.rows.set(5, { id: 5, v: 2 });
        t.rows.delete(7);
        t.changed.add(5).add(7);
      }
      return docs;
    };

    const report = await buildIndex({
      alias: 'models',
      client: engine.client,
      source: t.source,
      checkpoints,
      definition: { mappings: {} },
      batchSize: 10,
      concurrency: 1,
      sleep: noSleep,
      now: clock('2026-11-01T00:00:00Z'),
    });
    expect(engine.served('models').get('5')).toEqual({ id: 5, v: 2 });
    expect(engine.served('models').has('7')).toBe(false);
    expect(report.caughtUp).toBe(2);
  });

  it('retries documents the engine refused under load and stops the swap on a rejected one', async () => {
    const engine = fakeEngine();
    const { checkpoints } = memoryCheckpoints();
    const opts = {
      alias: 'models',
      client: engine.client,
      checkpoints,
      definition: { mappings: {} },
      batchSize: 10,
      concurrency: 2,
      sleep: noSleep,
    };
    const refusals = new Map<string, number>();
    engine.setRefuse((_, op) => {
      const n = refusals.get(String(op.id)) ?? 0;
      refusals.set(String(op.id), n + 1);
      return Number(op.id) % 3 === 0 && n < 2 ? 'retry' : null;
    });
    await buildIndex({
      ...opts,
      source: table(range(1, 30)).source,
      now: clock('2026-11-01T00:00:00Z'),
    });
    expect(engine.served('models').size).toBe(30);

    engine.setRefuse((_, op) => (op.id === 17 ? 'reject' : null));
    await expect(
      buildIndex({
        ...opts,
        source: table(range(1, 30)).source,
        now: clock('2026-11-02T00:00:00Z'),
      })
    ).rejects.toThrow('rejected');
    expect(engine.aliases.get('models')).toBe('models_20261101000000');
  });
});

describe('rollbackAlias', () => {
  it('points the alias back at the previous build', async () => {
    const engine = fakeEngine();
    const { checkpoints } = memoryCheckpoints();
    const run = (at: string, ids: number[]) =>
      buildIndex({
        alias: 'models',
        client: engine.client,
        source: table(ids).source,
        checkpoints,
        definition: { mappings: {} },
        now: clock(at),
        sleep: noSleep,
      });
    await run('2026-11-01T00:00:00Z', range(1, 10));
    await run('2026-11-02T00:00:00Z', range(1, 3));

    expect(await rollbackAlias(engine.client, 'models')).toEqual({
      from: 'models_20261102000000',
      to: 'models_20261101000000',
    });
    expect(engine.served('models').size).toBe(10);
  });
});
