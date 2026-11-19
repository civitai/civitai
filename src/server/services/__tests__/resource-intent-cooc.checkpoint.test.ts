import { createHash } from 'crypto';
import { promisify } from 'util';
import zlib from 'zlib';
import { Packr } from 'msgpackr';
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
// The payload's own msgpack options and brotli, to inspect and re-pack its elements.
const packr = new Packr({ useRecords: false, mapsAsObjects: true });
const inflate = promisify(zlib.brotliDecompress);
const deflate = promisify(zlib.brotliCompress);
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
    // Frozen: the sha256 of the uncompressed bytes `main`'s serializer (before the section
    // existed) produced for this fixture, taken once from `origin/main`'s build.ts. The compressed
    // payload was identical too; the raw bytes are pinned so a brotli upgrade cannot move this.
    expect(
      createHash('sha256')
        .update(await inflate(plain))
        .digest('hex')
    ).toBe('ed16853bf524c24ce68876dfbf64498331ce21f8f3dd1105e91b4094657a24b7');
    expect((packr.unpack(await inflate(plain)) as unknown[]).length).toBe(11);
    expect((await deserializeCoocPayload(plain)).checkpointSection).toBeUndefined();
    expect(await deserializeCoocCounts(plain)).toEqual(coocCounts());
    // The section changes the bytes, so a snapshot carrying one has a different content hash.
    const withSection = await serializeCoocCounts(
      coocCounts(),
      encodeCheckpointAttachSection(sectionCounts())
    );
    expect(withSection.equals(plain)).toBe(false);
  });

  it('🔴 elements after the ones this decoder knows are ignored, not refused', async () => {
    const section = encodeCheckpointAttachSection(sectionCounts());
    const raw = packr.unpack(
      await inflate(await serializeCoocCounts(coocCounts(), section))
    ) as unknown[];
    expect(raw.length).toBe(12);
    const later = await deflate(packr.pack([...raw, ['a later section'], 7]));
    const decoded = await deserializeCoocPayload(later);
    expect(decoded.counts).toEqual(coocCounts());
    expect(decodeCheckpointAttachSection(decoded.checkpointSection)).toEqual({
      buildHash: CHECKPOINT_ATTACH_BUILD_HASH,
      counts: sectionCounts(),
    });
    // Fewer than 11 is still refused.
    await expect(
      deserializeCoocPayload(await deflate(packr.pack(raw.slice(0, 10))))
    ).rejects.toThrow('unknown format');
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
});

describe('the build pipeline writes the section when asked', () => {
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
      checkpointSection: true,
      now: new Date('2026-10-01T12:34:56.789Z'),
      query: async (q) => {
        if (q.sql.includes('"baseModel" FROM "ModelVersion"')) asked.push(q.values[0] as number[]);
        return images.query(q);
      },
      sql,
    });
    expect([s.checkpointSection, s.checkpointBaseModels, s.checkpointPairs]).toEqual([true, 1, 1]);
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
