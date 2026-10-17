import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import zlib from 'zlib';
import { describe, expect, it, vi } from 'vitest';
import {
  parseTagVocabulary,
  TAG_BUILD_PARAMS,
  TagIndexAccumulator,
  type TagModelContent,
  type TagTrainingRow,
  type TrainingResource,
} from '~/server/services/resource-intent-tags/build';
import {
  encodeTagIndex,
  encodeTagIndexCooperative,
  packTagIndex,
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

  it('the cooperative encode consumes the index only when asked, with the same bytes', async () => {
    const kept = filled().finalize().data;
    const payload = await encodeTagIndexCooperative(kept, SPEC, async () => undefined);
    expect(sha(payload)).toBe(PINNED_SHA256);
    expect(
      zlib.brotliDecompressSync(payload).equals(packTagIndex(filled().finalize().data, SPEC))
    ).toBe(true);
    // Not asked to consume: the index is intact.
    expect(kept.kinds.addon.postings.resource.length).toBeGreaterThan(0);

    const consumed = filled().finalize().data;
    const payload2 = await encodeTagIndexCooperative(consumed, SPEC, async () => undefined, {
      consume: true,
    });
    expect(payload2.equals(payload)).toBe(true);
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

  it('streams into brotli as it packs: writes and pauses interleave', async () => {
    const events: string[] = [];
    const real = zlib.createBrotliCompress;
    const spy = vi.spyOn(zlib, 'createBrotliCompress').mockImplementation((opts) => {
      const z = real(opts);
      const write = z.write.bind(z) as (...a: unknown[]) => boolean;
      (z as unknown as { write: typeof write }).write = (...a: unknown[]) => {
        events.push('w');
        return write(...a);
      };
      return z;
    });
    try {
      await encodeTagIndexCooperative(
        filled().finalize().data,
        SPEC,
        async () => void events.push('p'),
        {
          every: 64,
        }
      );
    } finally {
      spy.mockRestore();
    }
    const firstWrite = events.indexOf('w');
    const lastWrite = events.lastIndexOf('w');
    // Packed whole first and compressed after, every pause would come before the first write.
    expect(events.slice(firstWrite, lastWrite).filter((e) => e === 'p').length).toBeGreaterThan(10);
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

  it('waits for drain when brotli reports a full buffer, before the next write', async () => {
    const events: string[] = [];
    const real = zlib.createBrotliCompress;
    const spy = vi.spyOn(zlib, 'createBrotliCompress').mockImplementation((opts) => {
      const z = real(opts);
      const write = z.write.bind(z) as (...a: unknown[]) => boolean;
      let writes = 0;
      (z as unknown as { write: typeof write }).write = (...a: unknown[]) => {
        write(...a);
        events.push('write');
        // The first write reports a full buffer; 'drain' follows 20 ms later.
        if (++writes > 1) return true;
        setTimeout(() => {
          events.push('drain');
          z.emit('drain');
        }, 20);
        return false;
      };
      return z;
    });
    try {
      await encodeTagIndexCooperative(filled().finalize().data, SPEC, async () => undefined);
    } finally {
      spy.mockRestore();
    }
    expect(events.slice(0, 3)).toEqual(['write', 'drain', 'write']);
  });

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

  it('pauses while checking the content scores, before a byte is written', async () => {
    // One tag with 70,000 postings: over one 65,536-entry chunk, so the fit count pauses twice and
    // the score check, which refuses in its second chunk, pauses once after its first.
    const d = filled().finalize().data;
    const n = 70_000;
    const p = d.kinds.addon.postings;
    p.ptr = new Uint32Array(p.ptr.length).fill(n, 1);
    p.resource = new Uint32Array(n);
    p.c = new Float64Array(n).fill(0.5);
    p.fit = new Float64Array(n).fill(NaN);
    p.c[66_000] = 0.12345;
    let pauses = 0;
    await expect(
      encodeTagIndexCooperative(d, SPEC, async () => void pauses++, { every: 1 })
    ).rejects.toThrow('is not a multiple');
    expect(pauses).toBe(3);
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
    // Every growable store the accumulator holds, found rather than named.
    const stores = () =>
      Object.entries(acc as unknown as Record<string, unknown>).flatMap(([k, v]) => {
        const g = v as { buf?: unknown; length?: number };
        return g && ArrayBuffer.isView(g.buf) ? [[k, g.length, (g.buf as Uint8Array).length]] : [];
      });
    const before = stores();
    expect(before.length).toBeGreaterThan(10);
    expect(before.filter(([, n]) => (n as number) > 0).length).toBeGreaterThan(10);
    acc.finalize();
    expect(stores()).toEqual(before.map(([k]) => [k, 0, 0]));
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
