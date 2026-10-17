import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import {
  parseTagVocabulary,
  TagIndexAccumulator,
  type TagModelContent,
  type TagTrainingRow,
  type TrainingResource,
} from '~/server/services/resource-intent-tags/build';
import { encodeTagIndex } from '~/server/services/resource-intent-tags/payload';
import { genTrainingRow, type VersionInfo } from '~/server/services/resource-intent-tags/sources';
import { RESOURCE_INTENT_TAGS_SPEC } from '~/server/services/resource-intent-tags/spec';

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

function filled() {
  const acc = new TagIndexAccumulator(vocab, {
    addonTypes: RESOURCE_INTENT_TAGS_SPEC.build.addonTypes,
    excludeGenPrompt: () => false,
  });
  for (const m of golden.models) acc.addModel(m);
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
  return acc;
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
