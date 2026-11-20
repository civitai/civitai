import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import zlib from 'zlib';
import { describe, expect, it, vi } from 'vitest';
import {
  parseTagVocabulary,
  TagIndexAccumulator,
  type TagModelContent,
  type TagTrainingRow,
  type TrainingResource,
} from '~/server/services/resource-intent-tags/build';
import {
  encodeTagIndex,
  encodeTagIndexCooperative,
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

  it('a brotli failure while the encode is paused fails its next write instead of hanging', async () => {
    let stream: ReturnType<typeof zlib.createBrotliCompress> | null = null;
    const real = zlib.createBrotliCompress;
    const spy = vi
      .spyOn(zlib, 'createBrotliCompress')
      .mockImplementation((opts) => (stream = real(opts)));
    let pauses = 0;
    try {
      await expect(
        encodeTagIndexCooperative(
          filled().finalize().data,
          SPEC,
          async () => {
            // Fails between writes, while nothing waits on the stream; a destroyed stream emits
            // nothing more, so only the error kept from this moment can stop the next write.
            if (++pauses === 20) {
              stream?.destroy(new Error('brotli failed while paused'));
              await new Promise((r) => setTimeout(r, 0));
            }
          },
          { every: 64 }
        )
      ).rejects.toThrow('brotli failed while paused');
    } finally {
      spy.mockRestore();
    }
  }, 5_000);

  it('a brotli failure mid-stream fails the encode, and leaves no rejection unhandled', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    const real = zlib.createBrotliCompress;
    const spy = vi.spyOn(zlib, 'createBrotliCompress').mockImplementation((opts) => {
      const z = real(opts);
      const write = z.write.bind(z) as (...a: unknown[]) => boolean;
      let writes = 0;
      (z as unknown as { write: typeof write }).write = (...a: unknown[]) => {
        const ok = write(...a);
        if (++writes === 3) z.destroy(new Error('brotli failed'));
        return ok;
      };
      return z;
    });
    try {
      await expect(
        encodeTagIndexCooperative(filled().finalize().data, SPEC, async () => undefined)
      ).rejects.toThrow('brotli failed');
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).toEqual([]);
    } finally {
      spy.mockRestore();
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it("the pipeline's finalize-and-encode gives the synchronous path's bytes", async () => {
    const { payload, stats } = await finalizeAndEncodeTagIndex(filled(true), async () => undefined);
    const sync = filled(true).finalize();
    expect(payload.equals(await encodeTagIndex(sync.data, RESOURCE_INTENT_TAGS_SPEC_HASH))).toBe(
      true
    );
    expect(stats).toEqual(sync.stats);
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
    const once = tags(filled().finalize().data);
    expect(once.length).toBeGreaterThan(0);
    // The second copy carries a tag the first does not: kept, it would show; merged, too.
    const extra = vocab.tags.findIndex((_, t) => !once.includes(t));
    acc.addModel({
      ...first,
      name: vocab.tags[extra].key,
      description: '',
      tags: [],
      trigger: [],
      showcase: [],
      gallery: [],
    });
    expect(tags(acc.finalize().data)).toEqual(once);
  });
});
