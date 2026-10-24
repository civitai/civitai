import { beforeEach, describe, expect, it } from 'vitest';

import { REMIX_CLAIM_TTL, useRemixStore } from '~/store/remix.store';
import { remixClaimHolds, remixClaimState, resolveRemixOfId } from '~/utils/remix-claim';

const SOURCE_ID = 11217158;

/** The source image's prompt in ClickUp 868m5acdq — a stranger's XXX image. */
const SEEDED_PROMPT =
  'netorare, cuckold pov, 1girl, 1boy, creampie, bed, bedroom, night, detailed background';

/** What the restricted account actually typed, minutes to days later. */
const UNRELATED_PROMPT =
  'boku no hero academia, aizawa shota, closed mouth, midoriya izuku, open mouth, u.a. school uniform, standing, from side, classroom, chalkboard, day';

function seedRemix(prompt: string = SEEDED_PROMPT, createdAt = Date.now()) {
  useRemixStore.setState({
    data: { remixOfId: SOURCE_ID, originalParams: { prompt }, createdAt },
  });
}

beforeEach(() => {
  useRemixStore.setState({ data: null });
});

describe('remixClaimHolds', () => {
  it('drops the claim once the prompt is unrelated to the one the remix seeded', () => {
    seedRemix();
    expect(resolveRemixOfId({ prompt: UNRELATED_PROMPT })).toBeUndefined();
  });

  it('keeps the claim while the user is still iterating on the seeded prompt', () => {
    seedRemix();
    expect(
      resolveRemixOfId({
        prompt: `${SEEDED_PROMPT}, masterpiece`,
      })
    ).toBe(SOURCE_ID);
  });

  it('keeps the claim for a media workflow whose prompt shares nothing with the source', () => {
    // img2vid / img2img:edit — the derivation is in the image, not the prompt.
    // This is the case the old >=0.75 gate broke, so it must not regress.
    seedRemix();
    expect(
      resolveRemixOfId({ prompt: 'pan left, slow zoom', images: [{ url: 'https://x/1.jpg' }] })
    ).toBe(SOURCE_ID);
    expect(resolveRemixOfId({ prompt: 'pan left', video: { url: 'https://x/1.mp4' } })).toBe(
      SOURCE_ID
    );
  });

  it('expires the claim past REMIX_CLAIM_TTL even when the prompt is untouched', () => {
    seedRemix(SEEDED_PROMPT, Date.now() - REMIX_CLAIM_TTL - 1);
    expect(resolveRemixOfId({ prompt: SEEDED_PROMPT })).toBeUndefined();
  });

  it('holds right up to the TTL boundary', () => {
    seedRemix(SEEDED_PROMPT, Date.now() - REMIX_CLAIM_TTL + 10_000);
    expect(resolveRemixOfId({ prompt: SEEDED_PROMPT })).toBe(SOURCE_ID);
  });

  it('claims nothing when there is no remix', () => {
    expect(resolveRemixOfId({ prompt: SEEDED_PROMPT })).toBeUndefined();
    expect(remixClaimHolds(null, { prompt: SEEDED_PROMPT })).toBe(false);
  });

  it('claims nothing when either side has no prompt to compare', () => {
    seedRemix('   ');
    expect(resolveRemixOfId({ prompt: UNRELATED_PROMPT })).toBeUndefined();

    seedRemix();
    expect(resolveRemixOfId({ prompt: '  ' })).toBeUndefined();
    expect(resolveRemixOfId({})).toBeUndefined();
  });
});

/** Four of the seed's nine tags survive — a real remix that moved on, scoring below the 0.75 cutoff. */
const PARTIAL_PROMPT =
  '1girl, 1boy, creampie, bed, forest, waterfall, sunlight, castle, epic fantasy';

/** Two of the seed's nine tags changed — a real edit that still scores at or above the 0.75 cutoff. */
const NEAR_PROMPT =
  'netorare, cuckold pov, 1girl, 1boy, creampie, bed, bedroom, day, plain background';

describe('remixClaimState', () => {
  const state = (form: Parameters<typeof remixClaimState>[1]) =>
    remixClaimState(useRemixStore.getState().data, form);

  /**
   * The WHOLE object on every branch, not the fields that seemed interesting.
   * Three review rounds each found one more field nobody had asserted on one
   * more branch — a different field each time — because assertions written
   * per-branch pin what their author was thinking about. `toEqual` pins every
   * field whether or not anyone thought about it.
   *
   * `score` is `expect.any(Number)` where the prompt carries the claim: its
   * VALUE is pinned by the ordering test below, which is the only thing that
   * survives a retuned similarity.
   */
  it.each([
    {
      when: 'there is no remix at all',
      arrange: () => undefined,
      form: { prompt: SEEDED_PROMPT },
      then: { holds: false, carrier: null, reason: 'none', score: null },
    },
    {
      when: 'the claim is older than its TTL',
      arrange: () => seedRemix(SEEDED_PROMPT, Date.now() - REMIX_CLAIM_TTL - 1),
      form: { prompt: SEEDED_PROMPT },
      then: { holds: false, carrier: null, reason: 'expired', score: null },
    },
    {
      when: 'the remix seeded no prompt to compare against',
      arrange: () => seedRemix('   '),
      form: { prompt: SEEDED_PROMPT },
      then: { holds: false, carrier: null, reason: 'uncarried', score: null },
    },
    {
      when: 'the person cleared the prompt box',
      arrange: () => seedRemix(),
      form: { prompt: '   ' },
      then: { holds: false, carrier: 'prompt', reason: 'uncarried', score: null },
    },
    {
      when: 'the prompt was rewritten past the cutoff',
      arrange: () => seedRemix(),
      form: { prompt: PARTIAL_PROMPT },
      then: { holds: false, carrier: 'prompt', reason: 'drifted', score: expect.any(Number) },
    },
    {
      when: 'the prompt changed but still scores above the cutoff',
      arrange: () => seedRemix(),
      form: { prompt: NEAR_PROMPT },
      then: { holds: true, carrier: 'prompt', reason: null, score: expect.any(Number) },
    },
    {
      when: 'the form still holds the source media',
      arrange: () => seedRemix(),
      form: { prompt: 'pan left', video: { url: 'https://x/1.mp4' } },
      then: { holds: true, carrier: 'media', reason: null, score: null },
    },
  ])('$when', ({ arrange, form, then }) => {
    arrange();
    expect(state(form)).toEqual(then);
  });

  /**
   * What the ordering closes and what it does not: it rules out a score that
   * collapses to a constant or ranks the fixtures wrongly. A monotone-but-wrong
   * score — raw cosine, any order-preserving scaling — still passes. That is the
   * ceiling of an ordering property, not a gap in this instance.
   */
  it('ranks a nearer prompt above a further one, and a disjoint one at the floor', () => {
    seedRemix();
    const near = state({ prompt: NEAR_PROMPT }).score ?? -1;
    const partial = state({ prompt: PARTIAL_PROMPT }).score ?? -1;
    const disjoint = state({ prompt: UNRELATED_PROMPT }).score ?? -1;

    expect(near).toBeGreaterThanOrEqual(0.75);
    expect(near).toBeGreaterThan(partial);
    expect(partial).toBeGreaterThan(disjoint);
    expect(partial).toBeLessThan(0.75);
    expect(disjoint).toBe(0);
  });
});
