import { describe, expect, it, vi } from 'vitest';

import {
  CoocCountAccumulator,
  deserializeCoocCounts,
  deserializeCoocPayload,
  serializeCoocCounts,
  serializeTrainImageIds,
} from '~/server/services/resource-intent-cooc/build';
import {
  CHECKPOINT_ATTACH_BUILD_HASH,
  CheckpointAttachAccumulator,
  checkpointAttachIndex,
  decodeCheckpointAttachSection,
  encodeCheckpointAttachSection,
} from '~/server/services/resource-intent-cooc/checkpoint-attach';
import { CoocSnapshotHolder } from '~/server/services/resource-intent-cooc/holder';
import { buildCoocSnapshot } from '~/server/services/resource-intent-cooc/pipeline';
import {
  RESOURCE_INTENT_COOC_SPEC,
  RESOURCE_INTENT_COOC_SPEC_HASH,
} from '~/server/services/resource-intent-cooc/spec';
import {
  beginCoocBuild,
  completeCoocBuild,
  CoocSnapshotCorruptError,
  loadCoocSnapshot,
  type CoocSql,
} from '~/server/services/resource-intent-cooc/store';
import { fakeImageDb, freshDb } from './resource-intent-cooc.harness';

/**
 * Checkpoint mode's attachment section inside the co-occurrence snapshot: the accumulator, the
 * encoding and its validation, and how a snapshot with, without, or with a foreign section is
 * loaded and served. The seam against the screen is `resource-intent-checkpoint.seam.test.ts`.
 * Synthetic data only; the store runs over the real migration in PGlite.
 */

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const DAY = 86_400_000;
const ck = (modelId: number, versionId: number) => ({
  modelId,
  versionId,
  modelType: 'Checkpoint',
});

function coocCounts() {
  const acc = new CoocCountAccumulator(RESOURCE_INTENT_COOC_SPEC.addonTypes);
  for (let i = 0; i < 5; i++) acc.add(['zephyr'], [[77, 'LORA']]);
  for (let i = 0; i < 195; i++) acc.add([], []);
  const {
    rawPairs: _p,
    rawVocab: _v,
    typeConflicts: _t,
    ...counts
  } = acc.finalize(RESOURCE_INTENT_COOC_SPEC);
  return counts;
}

function sectionCounts() {
  const acc = new CheckpointAttachAccumulator();
  acc.add([ck(5, 50), ck(5, 51)]); // two versions of one model, one baseModel: counts once
  acc.add([ck(5, 52), ck(6, 60)]); // version 52 is under another baseModel
  acc.add([ck(6, 60), { modelId: 9, versionId: 90, modelType: 'LORA' }]);
  acc.add([ck(7, 70)]); // version 70 has no baseModel row: '?'
  acc.add([{ modelId: 9, versionId: 90, modelType: 'LORA' }]); // no checkpoint
  expect(acc.imagesWithCheckpoint).toBe(4);
  expect(acc.versionIds()).toEqual([50, 51, 52, 60, 70]);
  return acc.finalize(
    new Map([
      [50, 'EcoA'],
      [51, 'EcoA'],
      [52, 'EcoB'],
      [60, 'EcoA'],
    ])
  );
}

describe('CheckpointAttachAccumulator', () => {
  it('counts each image once per distinct (baseModel, model) pair, unknown versions under ?', () => {
    expect(sectionCounts()).toEqual(
      new Map([
        [
          'EcoA',
          new Map([
            [5, 1],
            [6, 2],
          ]),
        ],
        ['EcoB', new Map([[5, 1]])],
        ['?', new Map([[7, 1]])],
      ])
    );
  });

  it('refuses to add or finalize twice', () => {
    const acc = new CheckpointAttachAccumulator();
    acc.finalize(new Map());
    expect(() => acc.add([ck(1, 1)])).toThrow('already finalized');
    expect(() => acc.finalize(new Map())).toThrow('already finalized');
  });
});

describe('the section encoding', () => {
  it('round-trips through the payload; equal counts in any insertion order give equal bytes', async () => {
    const counts = sectionCounts();
    const payload = await serializeCoocCounts(coocCounts(), encodeCheckpointAttachSection(counts));
    const decoded = await deserializeCoocPayload(payload);
    expect(decoded.counts).toEqual(coocCounts());
    expect(decodeCheckpointAttachSection(decoded.checkpointSection)).toEqual({
      buildHash: CHECKPOINT_ATTACH_BUILD_HASH,
      counts,
    });
    const reversed = new Map(
      [...counts].reverse().map(([bm, m]) => [bm, new Map([...m].reverse())])
    );
    expect(
      (await serializeCoocCounts(coocCounts(), encodeCheckpointAttachSection(reversed))).equals(
        payload
      )
    ).toBe(true);
  });

  it('🔴 without a section the payload is the 11-element format it always was, and still decodes', async () => {
    const plain = await serializeCoocCounts(coocCounts());
    expect((await deserializeCoocPayload(plain)).checkpointSection).toBeUndefined();
    expect(await deserializeCoocCounts(plain)).toEqual(coocCounts());
    // The section changes the bytes, so a snapshot carrying one has a different content hash.
    const withSection = await serializeCoocCounts(
      coocCounts(),
      encodeCheckpointAttachSection(sectionCounts())
    );
    expect(withSection.equals(plain)).toBe(false);
  });

  it('the cooc spec hash does not depend on the section (existing snapshots stay servable)', () => {
    // Pinned in resource-intent-cooc.spec.test.ts; restated so the dependency is visible here.
    expect(RESOURCE_INTENT_COOC_SPEC_HASH.slice(0, 8)).toBe('8a3f0edb');
  });

  it.each<[string, (s: unknown[]) => unknown]>([
    ['an unknown format', (s) => ['other/1', ...s.slice(1)]],
    ['a missing element', (s) => s.slice(0, 4)],
    ['an empty build hash', (s) => [s[0], '', ...s.slice(2)]],
    ['unordered baseModels', (s) => [s[0], s[1], ['EcoB', 'EcoA', '?'], s[3], s[4]]],
    [
      'mismatched per-baseModel arrays',
      (s) => [s[0], s[1], s[2], (s[3] as unknown[]).slice(1), s[4]],
    ],
    [
      'a model/count length mismatch',
      (s) => [s[0], s[1], s[2], s[3], [Buffer.alloc(4), ...(s[4] as Buffer[]).slice(1)]],
    ],
    [
      'a zero count',
      (s) => [s[0], s[1], s[2], s[3], (s[4] as Buffer[]).map((b) => Buffer.alloc(b.length))],
    ],
    [
      'unordered model ids',
      (s) => {
        const ids = [...(s[3] as Buffer[])];
        const counts = [...(s[4] as Buffer[])];
        const i = (s[2] as string[]).indexOf('EcoA');
        ids[i] = Buffer.from([...ids[i].subarray(4, 8), ...ids[i].subarray(0, 4)]);
        counts[i] = Buffer.from([...counts[i].subarray(4, 8), ...counts[i].subarray(0, 4)]);
        return [s[0], s[1], s[2], ids, counts];
      },
    ],
  ])('refuses %s', (_label, corrupt) => {
    const good = encodeCheckpointAttachSection(sectionCounts());
    expect(() => decodeCheckpointAttachSection(good)).not.toThrow();
    expect(() => decodeCheckpointAttachSection(corrupt(good))).toThrow(
      'checkpoint attach section invalid'
    );
  });

  it('the index ranks by count, then ascending id, and keeps the first 300', () => {
    const big = new Map<number, number>();
    for (let id = 1; id <= 400; id++) big.set(id, 1 + (id % 3));
    const index = checkpointAttachIndex(new Map([['E', big]]));
    const ranked = index.candidates.get('E')!;
    expect(ranked).toHaveLength(300);
    expect(ranked.slice(0, 3)).toEqual([2, 5, 8]);
    expect(ranked[133]).toBe(1); // after the 133 count-3 ids, the count-2 ids start at 1
  });
});

async function storeSnapshot(
  sql: CoocSql,
  kind: 'production' | 'study',
  section: unknown[] | undefined,
  seed: number
) {
  const now = new Date();
  const trainEnd = new Date(now.getTime() - 2 * DAY);
  const { id } = await beginCoocBuild(sql, {
    kind,
    specHash: RESOURCE_INTENT_COOC_SPEC_HASH,
    trainStart: new Date(trainEnd.getTime() - 120 * DAY),
    trainEnd,
    seed,
    pinnedUntil: kind === 'study' ? new Date(now.getTime() + 30 * DAY) : null,
    now,
  });
  const counts = coocCounts();
  const { contentHash } = await completeCoocBuild(sql, id, {
    payload: await serializeCoocCounts(counts, section),
    trainImageIds: await serializeTrainImageIds([seed]),
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

describe('loading and serving the section', () => {
  it('🔴 a snapshot with the section serves its ranked candidates beside the cooc scores', async () => {
    const { sql } = await freshDb();
    const hash = await storeSnapshot(
      sql,
      'production',
      encodeCheckpointAttachSection(sectionCounts()),
      1
    );
    const served = await new CoocSnapshotHolder({ sql: () => sql }).resolve();
    expect(served.snapshot?.contentHash).toBe(hash);
    expect(served.snapshot?.checkpoints?.candidates).toEqual(
      new Map([
        ['EcoA', [6, 5]],
        ['EcoB', [5]],
        ['?', [7]],
      ])
    );
  });

  it('🔴 a snapshot without the section (built before it existed) still serves POOL_MERGE; checkpoints null', async () => {
    const { sql } = await freshDb();
    const hash = await storeSnapshot(sql, 'production', undefined, 2);
    expect(
      (await loadCoocSnapshot(sql, hash, { kind: 'production', now: new Date() })).checkpoints
    ).toBeNull();
    const served = await new CoocSnapshotHolder({ sql: () => sql }).resolve();
    expect(served.fallbackReason).toBeNull();
    expect(served.snapshot?.contentHash).toBe(hash);
    expect(served.snapshot?.checkpoints).toBeNull();
  });

  it('a section built under another build hash is not served; the snapshot still is', async () => {
    const { sql } = await freshDb();
    await storeSnapshot(
      sql,
      'production',
      encodeCheckpointAttachSection(sectionCounts(), 'f'.repeat(64)),
      3
    );
    const served = await new CoocSnapshotHolder({ sql: () => sql }).resolve();
    expect(served.snapshot).not.toBeNull();
    expect(served.snapshot?.checkpoints).toBeNull();
  });

  it('a malformed section makes the whole snapshot unservable (corrupt)', async () => {
    const { sql } = await freshDb();
    const hash = await storeSnapshot(sql, 'production', ['not-a-section'], 4);
    await expect(
      loadCoocSnapshot(sql, hash, { kind: 'production', now: new Date() })
    ).rejects.toBeInstanceOf(CoocSnapshotCorruptError);
  });
});

describe('the build pipeline writes the section', () => {
  it('🔴 a production build counts every training image’s checkpoint under its version’s baseModel', async () => {
    const { sql } = await freshDb();
    const trainEnd = new Date('2026-09-30T00:00:00.000Z');
    const images = fakeImageDb({
      trainStart: new Date(trainEnd.getTime() - RESOURCE_INTENT_COOC_SPEC.trainDays * DAY),
      trainEnd,
      images: 900,
    });
    const asked: number[][] = [];
    const s = await buildCoocSnapshot({
      kind: 'production',
      seed: RESOURCE_INTENT_COOC_SPEC.defaultSeed,
      pinnedUntil: null,
      dryRun: false,
      now: new Date('2026-10-01T12:34:56.789Z'),
      query: async (q) => {
        if (q.sql.includes('"baseModel" FROM "ModelVersion"')) asked.push(q.values[0] as number[]);
        return images.query(q);
      },
      sql,
    });
    expect([s.checkpointBaseModels, s.checkpointPairs]).toEqual([1, 1]);
    const { checkpoints } = await loadCoocSnapshot(sql, s.contentHash, {
      kind: 'production',
      now: new Date('2026-10-01T12:34:56.789Z'),
    });
    // Every image attaches checkpoint 9000 (version 9900, which the harness puts under SynthBase).
    expect(checkpoints).toEqual({
      buildHash: CHECKPOINT_ATTACH_BUILD_HASH,
      counts: new Map([['SynthBase', new Map([[9000, 900]])]]),
    });
    // One baseModel lookup, for the checkpoint version only (the LORA versions are never asked).
    expect(asked).toEqual([[9900]]);
  });
});
