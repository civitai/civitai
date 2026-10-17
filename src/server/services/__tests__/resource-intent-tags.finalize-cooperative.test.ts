import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import {
  parseTagVocabulary,
  roundHalfEven,
  TAG_BUILD_PARAMS,
  TagIndexAccumulator,
  type TagModelContent,
  type TagTrainingRow,
  type TrainingResource,
} from '~/server/services/resource-intent-tags/build';
import {
  compressTagIndex,
  encodeTagIndex,
  encodeTagIndexCooperative,
  packTagIndex,
  packTagIndexCooperative,
} from '~/server/services/resource-intent-tags/payload';
import { finalizeAndEncodeTagIndex } from '~/server/services/resource-intent-tags/pipeline';
import { genTrainingRow, type VersionInfo } from '~/server/services/resource-intent-tags/sources';
import {
  RESOURCE_INTENT_TAGS_SPEC,
  RESOURCE_INTENT_TAGS_SPEC_HASH,
} from '~/server/services/resource-intent-tags/spec';

/**
 * `finalizeCooperative` pauses inside the index computation so a real-size build does not hold the
 * event loop, and must produce exactly what the synchronous `finalize` produced before it existed:
 * the encoded snapshot of the build parity fixture is pinned by sha256.
 */

type Golden = {
  vocabulary: unknown[];
  versions: [number, number, string, string][];
  genRows: {
    u: string;
    p: string;
    versionIds: number[];
    liked: boolean;
    favorite: boolean;
    disliked: boolean;
  }[];
  postRows: {
    u: string;
    p: string;
    resources: TrainingResource[];
    reactions: number;
    tips: number;
  }[];
  models: TagModelContent[];
};
const golden = JSON.parse(
  readFileSync(join(__dirname, 'fixtures/resource-intent-tags-build-golden.json'), 'utf8')
) as Golden;
const vocab = parseTagVocabulary(
  Buffer.from(JSON.stringify({ schema: 'p2m-vocab/2', tags: golden.vocabulary }))
);
const versions = new Map<number, VersionInfo>(
  golden.versions.map(([v, modelId, type, baseModel]) => [
    v,
    { modelId, type, baseModel, flagged: false },
  ])
);

/** The fixture's accumulator; `rowsFirst` adds the rows before the models, as the pipeline does. */
function filled(rowsFirst = false) {
  const acc = new TagIndexAccumulator(vocab, {
    addonTypes: RESOURCE_INTENT_TAGS_SPEC.build.addonTypes,
    excludeGenPrompt: () => false,
  });
  if (!rowsFirst) for (const m of golden.models) acc.addModel(m);
  addRows(acc);
  if (rowsFirst) for (const m of golden.models) acc.addModel(m);
  return acc;
}

function addRows(acc: TagIndexAccumulator) {
  for (const r of golden.genRows)
    acc.addRow(
      genTrainingRow(
        {
          user: r.u,
          prompt: r.p,
          versionIds: r.versionIds,
          liked: r.liked,
          favorite: r.favorite,
          disliked: r.disliked,
        },
        versions
      ) as TagTrainingRow
    );
  for (const r of golden.postRows)
    acc.addRow({
      source: 'post',
      user: r.u,
      prompt: r.p,
      resources: r.resources,
      reactions: r.reactions,
      tips: r.tips,
    });
}

const SPEC = 'd'.repeat(64);
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
/** The fixture's encoded snapshot, from the synchronous finalize before the cooperative one existed. */
const PINNED_SHA256 = 'bfe0e4f8c499708dcd41033705cabb5f47bc362d5a7c2af5aa18d922e85d915c';

describe('finalizeCooperative', () => {
  it('the synchronous finalize still encodes to the pinned bytes', async () => {
    expect(sha(await encodeTagIndex(filled().finalize().data, SPEC))).toBe(PINNED_SHA256);
  });

  it('pauses throughout the computation and encodes to the same bytes', async () => {
    let pauses = 0;
    const { data, stats } = await filled().finalizeCooperative(async () => {
      pauses++;
    }, 64);
    expect(sha(await encodeTagIndex(data, SPEC))).toBe(PINNED_SHA256);
    expect(stats).toEqual(filled().finalize().stats);
    // Positive control for the pauses themselves: at 64 units of work per pause the fixture's
    // ~2,300 rows, their tags and the postings pass through hundreds of pause points.
    expect(pauses).toBeGreaterThan(500);
  });

  it('a pause that rejects stops the computation', async () => {
    await expect(
      filled().finalizeCooperative(async () => {
        throw new Error('stop');
      }, 64)
    ).rejects.toThrow('stop');
  });
});

describe('the build at full coverage: memory and order', () => {
  it('adding the rows before the models (the pipeline order) builds the same bytes', async () => {
    expect(sha(await encodeTagIndex(filled(true).finalize().data, SPEC))).toBe(PINNED_SHA256);
  });

  it('the cooperative pack pauses and gives the synchronous bytes, consuming the index only when asked', async () => {
    const kept = filled().finalize().data;
    let pauses = 0;
    const raw = await packTagIndexCooperative(kept, SPEC, async () => void pauses++, { every: 64 });
    expect(sha(await compressTagIndex(raw))).toBe(PINNED_SHA256);
    expect(raw.equals(packTagIndex(filled().finalize().data, SPEC))).toBe(true);
    expect(pauses).toBeGreaterThan(50);
    // Not asked to consume: the index is intact.
    expect(kept.kinds.addon.postings.resource.length).toBeGreaterThan(0);

    const consumed = filled().finalize().data;
    const raw2 = await packTagIndexCooperative(consumed, SPEC, async () => undefined, {
      consume: true,
    });
    expect(raw2.equals(raw)).toBe(true);
    for (const kind of ['addon', 'checkpoint'] as const) {
      const p = consumed.kinds[kind].postings;
      expect([p.resource.length, p.c.length, p.fit.length]).toEqual([0, 0, 0]);
    }
  });

  it('the streaming encode pauses as it packs, and gives encodeTagIndex’s bytes', async () => {
    let pauses = 0;
    const payload = await encodeTagIndexCooperative(
      filled().finalize().data,
      SPEC,
      async () => void pauses++,
      { every: 64 }
    );
    expect(sha(payload)).toBe(PINNED_SHA256);
    expect(pauses).toBeGreaterThan(50);
  });

  it('pauses while checking the content scores, before a byte is written', async () => {
    // The last score is not a multiple of 1/10^4, so the check refuses at the very end of its pass:
    // every pause counted before the refusal is one taken inside the check.
    const d = filled().finalize().data;
    const c = d.kinds.addon.postings.c;
    c[c.length - 1] = 0.12345;
    let pauses = 0;
    await expect(
      packTagIndexCooperative(d, SPEC, async () => void pauses++, { every: 1 })
    ).rejects.toThrow('is not a multiple');
    expect(pauses).toBeGreaterThan(0);
  });

  it("the pipeline's finalize-and-encode gives the synchronous path's bytes", async () => {
    const { payload, stats } = await finalizeAndEncodeTagIndex(filled(true), async () => undefined);
    const sync = filled(true).finalize();
    expect(payload.equals(await encodeTagIndex(sync.data, RESOURCE_INTENT_TAGS_SPEC_HASH))).toBe(
      true
    );
    expect(stats).toEqual(sync.stats);
  });

  it('finalize drops the rows and the models it no longer needs', () => {
    const acc = filled();
    const store = acc as unknown as Record<string, { length: number; buf: { length: number } }>;
    const grows = [
      'rowTags',
      'rowUser',
      'rowResModel',
      'contentTags',
      'contentScaled',
      'modelEcos',
    ];
    for (const g of grows) expect(store[g].buf.length).toBeGreaterThan(0);
    acc.finalize();
    for (const g of grows) expect([g, store[g].length, store[g].buf.length]).toEqual([g, 0, 0]);
    expect(acc.usedModelIds()).toEqual([]);
  });

  it('with float32Postings, the postings scores and fits are float32 and encode to the same bytes', async () => {
    const { data } = filled().finalize({ float32Postings: true });
    for (const kind of ['addon', 'checkpoint'] as const) {
      expect(data.kinds[kind].postings.c).toBeInstanceOf(Float32Array);
      expect(data.kinds[kind].postings.fit).toBeInstanceOf(Float32Array);
    }
    expect(filled().finalize().data.kinds.addon.postings.c).toBeInstanceOf(Float64Array);
    expect(sha(await encodeTagIndex(data, SPEC))).toBe(PINNED_SHA256);
  });

  it('a model given twice keeps its first content', async () => {
    const acc = filled();
    const first = golden.models[0];
    const tags = (d: ReturnType<typeof acc.finalize>['data']) => {
      const k = d.kinds[first.type === 'Checkpoint' ? 'checkpoint' : 'addon'];
      const r = k.modelIds.indexOf(first.modelId);
      const out: number[] = [];
      for (let t = 0; t + 1 < k.postings.ptr.length; t++)
        for (let j = k.postings.ptr[t]; j < k.postings.ptr[t + 1]; j++)
          if (k.postings.resource[j] === r && k.postings.c[j] > 0) out.push(t);
      return out;
    };
    acc.addModel({
      ...first,
      name: '',
      description: '',
      tags: [],
      trigger: [],
      showcase: [],
      gallery: [],
    });
    const once = tags(filled().finalize().data);
    expect(once.length).toBeGreaterThan(0);
    expect(tags(acc.finalize().data)).toEqual(once);
  });

  it('a content score is stored exactly as an integer of its decimals', () => {
    // The accumulator keeps c as round(c·10^4) and reads it back divided: every value the build can
    // produce (c ≥ minScore, 4 decimals) must survive that unchanged.
    expect(TAG_BUILD_PARAMS.content.scoreDecimals).toBe(4);
    for (let k = 1000; k <= 10_000; k++) {
      const c = roundHalfEven(k / 10_000 + 1e-7 * ((k % 3) - 1), 4);
      expect(Math.round(c * 10_000) / 10_000).toBe(c);
    }
  });

  it('refuses content scores rounded to more decimals than it can store', () => {
    const params = {
      ...TAG_BUILD_PARAMS,
      content: { ...TAG_BUILD_PARAMS.content, scoreDecimals: 5 },
    } as unknown as typeof TAG_BUILD_PARAMS;
    expect(
      () =>
        new TagIndexAccumulator(vocab, {
          addonTypes: RESOURCE_INTENT_TAGS_SPEC.build.addonTypes,
          excludeGenPrompt: () => false,
          params,
        })
    ).toThrow('at most 4 decimals');
  });
});
