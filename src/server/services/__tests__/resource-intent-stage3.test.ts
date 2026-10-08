import { describe, expect, it } from 'vitest';

import { buildDecisionsQuestions } from '~/server/services/ai/jev';
import type { ResourceIntentShortlistEntry } from '~/server/services/resource-intent-matcher.service';
import {
  buildStage3Question,
  buildStage3State,
  combineStage3Answers,
  mergeHybrid,
  RESOURCE_INTENT_STAGE3_SPEC_HASH,
  stage3Orders,
} from '~/server/services/resource-intent-stage3';

/**
 * Stage 3 (R4c) and the HYBRID_10 merge as pure functions. Every expectation is a
 * literal: the merge cases are the offline screen's own merge fixtures, and the
 * question text is the screened wording verbatim.
 */

const entry = (modelId: number, versionId: number): ResourceIntentShortlistEntry => ({
  versionId,
  modelId,
  modelName: `Model ${modelId}`,
  versionName: `v${versionId}`,
  baseModel: 'Pony',
  modelType: 'LORA',
  thumbsUpCount: 0,
});
const ids = (entries: { modelId: number }[]) => entries.map((e) => e.modelId);
const models = (...modelIds: number[]) => modelIds.map((m) => ({ modelId: m }));

describe('buildStage3Question — R4c shape', () => {
  it('puts each description in criteria, describes none, and lists nothing in the instructions', () => {
    const question = buildStage3Question([entry(7, 70), entry(8, 80)]);
    expect(question).toEqual({
      id: 'resourceVersion',
      type: 'choice',
      prompt:
        'The `prompt` is an image-generation prompt. `role` is the kind of add-on resource it needs and `styleFamily` is its visual style family. Which ONE of the listed community resources best fits this prompt for that role? Choose "none" if no listed resource fits.',
      options: ['0', '1', 'none'],
      optionDescriptions: {
        '0': 'Model 7 — v70 (LORA, Pony)',
        '1': 'Model 8 — v80 (LORA, Pony)',
        none: 'None of the listed resources fits: each is the wrong character, subject, style or purpose for this prompt.',
      },
    });
    // On the WIRE: the vendor scores against `criteria`, so that is where the
    // descriptions must land — and the instructions carry no numbered line.
    const wire = buildDecisionsQuestions([question]).resourceVersion;
    expect(wire).toEqual({
      type: 'choice',
      instructions: question.prompt,
      criteria: {
        '0': 'Model 7 — v70 (LORA, Pony)',
        '1': 'Model 8 — v80 (LORA, Pony)',
        none: 'None of the listed resources fits: each is the wrong character, subject, style or purpose for this prompt.',
      },
    });
    expect(wire.instructions).not.toMatch(/^\d+: /m);
  });

  it('state is exactly {prompt, role, styleFamily}', () => {
    expect(buildStage3State('a knight', { role: 'character', styleFamily: 'anime_manga' })).toEqual(
      { prompt: 'a knight', role: 'character', styleFamily: 'anime_manga' }
    );
  });
});

describe('stage3Orders — popularity order and its exact reverse', () => {
  it('orders shortlist indexes by their position in the seed pool', () => {
    // Shortlist (re-rank order) 10,20,30,40; pool (popularity) 30,10,40,20.
    const shortlist = [entry(1, 10), entry(2, 20), entry(3, 30), entry(4, 40)];
    const pool = [shortlist[2], shortlist[0], shortlist[3], shortlist[1]];
    expect(stage3Orders(shortlist, pool)).toEqual([
      [2, 0, 3, 1],
      [1, 3, 0, 2],
    ]);
  });

  it('caps what it sends at the vendor option budget minus none', () => {
    // Pool = the shortlist reversed, so the 254 sent are the shortlist's FIRST 254 (in
    // popularity order), not the 254 most popular.
    const shortlist = Array.from({ length: 300 }, (_, i) => entry(i + 1, i + 1));
    const [forward, reverse] = stage3Orders(shortlist, [...shortlist].reverse());
    expect(forward).toHaveLength(254);
    expect(forward[0]).toBe(253);
    expect(forward.at(-1)).toBe(0);
    expect(forward).not.toContain(299);
    expect(reverse[0]).toBe(0);
    expect(buildStage3Question(forward.map((i) => shortlist[i])).options).toHaveLength(255);
  });
});

describe('combineStage3Answers — averaging and tie-break', () => {
  it('maps each order back to shortlist indexes and averages per entry', () => {
    // Order 0 sends shortlist 0,1,2; order 1 sends 2,1,0. Position "0" of order 1 is
    // shortlist index 2, so index 2 averages (0 + 0.8) / 2 = 0.4, index 0 (0.6 + 0) / 2.
    const result = combineStage3Answers(
      3,
      [
        [0, 1, 2],
        [2, 1, 0],
      ],
      [
        { '0': 0.6, none: 0.4 },
        { '0': 0.8, none: 0.2 },
      ]
    );
    expect(result.order).toEqual([2, 0, 1]);
    expect(result.noneProbability).toBeCloseTo(0.3, 12);
  });

  it('breaks an exact tie by shortlist index (the matcher order), not by either order sent', () => {
    // Indexes 1 and 3 both average 0.25; index 1 comes first although order 0 put 3 ahead.
    const result = combineStage3Answers(
      4,
      [
        [3, 2, 1, 0],
        [0, 1, 2, 3],
      ],
      [
        { '0': 0.25, '2': 0.25, '3': 0.5 },
        { '1': 0.25, '3': 0.25, '0': 0.5 },
      ]
    );
    expect(result.order).toEqual([0, 1, 3, 2]);
    expect(result.noneProbability).toBe(0);
  });

  it('takes the MEAN across orders: one strong order does not beat two consistent ones', () => {
    // Index 0 gets 0.6 in order 0 only (mean 0.3, max 0.6); index 1 gets 0.35 in both
    // (mean 0.35). The mean puts 1 first; a max, or reading one order, would put 0 first.
    const result = combineStage3Answers(
      2,
      [
        [0, 1],
        [1, 0],
      ],
      [
        { '0': 0.6, '1': 0.35, none: 0.05 },
        { '0': 0.35, none: 0.65 },
      ]
    );
    expect(result.order).toEqual([1, 0]);
    expect(result.noneProbability).toBeCloseTo(0.35, 12);
  });

  it('all mass on none keeps the list in shortlist order and reports none = 1', () => {
    const result = combineStage3Answers(
      3,
      [
        [0, 1, 2],
        [2, 1, 0],
      ],
      [{ none: 1 }, { none: 1 }]
    );
    expect(result).toEqual({ order: [0, 1, 2], noneProbability: 1 });
  });

  it('an entry beyond the ranked budget gets probability 0 and sorts after every ranked one', () => {
    const result = combineStage3Answers(
      3,
      [
        [1, 0],
        [0, 1],
      ],
      [{ '0': 0.1, none: 0.9 }, { none: 1 }]
    );
    expect(result.order).toEqual([1, 0, 2]);
  });
});

describe('mergeHybrid — the screen fixtures', () => {
  it('skips a repeated model in the head and still fills the head to its size', () => {
    expect(ids(mergeHybrid(models(7, 7, 8, 9), models(1, 2, 3), 2, 5))).toEqual([7, 8, 1, 2, 3]);
  });

  it('fill skips placed models in fill order and stops at cap', () => {
    expect(ids(mergeHybrid(models(30, 10), models(10, 20, 30, 40, 50, 60), 2, 4))).toEqual([
      30, 10, 20, 40,
    ]);
  });

  it('head models beyond headSize are not reserved and can enter at their fill position', () => {
    expect(ids(mergeHybrid(models(5, 6, 7, 8), models(8, 1, 7), 2, 5))).toEqual([5, 6, 8, 1, 7]);
  });

  it('a short head is taken whole and a short fill leaves the list under cap', () => {
    expect(ids(mergeHybrid(models(4, 4, 4), models(1, 4, 2), 10, 50))).toEqual([4, 1, 2]);
  });

  it('an empty head returns the fill top cap exactly', () => {
    const fill = Array.from({ length: 100 }, (_, i) => ({ modelId: 1000 + i }));
    expect(ids(mergeHybrid([], fill, 10, 50))).toEqual(ids(fill.slice(0, 50)));
    expect(mergeHybrid([], [], 10, 50)).toEqual([]);
  });

  it('a disjoint full head: head[0..9] then fill[0..39]', () => {
    const head = Array.from({ length: 30 }, (_, i) => ({ modelId: 1 + i }));
    const fill = Array.from({ length: 100 }, (_, i) => ({ modelId: 1000 + i }));
    const merged = ids(mergeHybrid(head, fill, 10, 50));
    expect(merged).toHaveLength(50);
    expect(merged.slice(0, 10)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(merged[10]).toBe(1000);
    expect(merged[49]).toBe(1039);
  });

  it('a head overlapping the fill sends the fill deeper, never past cap entries of it', () => {
    const fill = Array.from({ length: 100 }, (_, i) => ({ modelId: 1000 + i }));
    const merged = ids(mergeHybrid(fill.slice(5, 15), fill, 10, 50));
    expect(merged.slice(10)).toEqual([
      ...[1000, 1001, 1002, 1003, 1004],
      ...Array.from({ length: 35 }, (_, i) => 1015 + i),
    ]);
    // The last fill entry read is fill[49] — `cap` deep, the bound the matcher relies on.
    expect(merged.at(-1)).toBe(1049);
  });

  it('keeps the FIRST version of a model it places (the entry, not just the id)', () => {
    const merged = mergeHybrid([entry(1, 12), entry(1, 11), entry(2, 21)], [entry(3, 31)], 10, 50);
    expect(merged.map((e) => e.versionId)).toEqual([12, 21, 31]);
  });
});

describe('RESOURCE_INTENT_STAGE3_SPEC_HASH', () => {
  it('is a sha256 that differs from the stage-1 spec hash', async () => {
    const { RESOURCE_INTENT_SPEC_HASH } = await import('~/server/schema/resource-intent.schema');
    expect(RESOURCE_INTENT_STAGE3_SPEC_HASH).toMatch(/^[0-9a-f]{64}$/);
    expect(RESOURCE_INTENT_STAGE3_SPEC_HASH).not.toBe(RESOURCE_INTENT_SPEC_HASH);
  });

  it('is pinned: a change to stage-3 wording, averaging or merge must update this literal', () => {
    // Deliberately a literal. When this fails because you changed stage 3 on purpose,
    // the cache key and the shadow `stage3SpecHash` have moved with it — update it here.
    expect(RESOURCE_INTENT_STAGE3_SPEC_HASH).toBe(EXPECTED_STAGE3_SPEC_HASH);
  });
});

const EXPECTED_STAGE3_SPEC_HASH =
  '88c36d9e271571d0cb815c7d0291b572c492b8fc8211e13edca715a0b446a3e8';
