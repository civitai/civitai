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

/**
 * What the restricted account typed with four of the seed's eleven tags left —
 * a real remix that has moved on. Scores 0.2969 against the seed.
 */
const PARTIAL_PROMPT =
  '1girl, 1boy, creampie, bed, forest, waterfall, sunlight, castle, epic fantasy';

/** Two tags changed out of eleven. Scores 0.7601 — changed a lot, still counts. */
const NEAR_PROMPT =
  'netorare, cuckold pov, 1girl, 1boy, creampie, bed, bedroom, day, plain background';

describe('remixClaimState reasons', () => {
  const state = (form: Parameters<typeof remixClaimState>[1]) =>
    remixClaimState(useRemixStore.getState().data, form);

  it('reports no remix at all as none, carrying and scoring nothing', () => {
    const none = remixClaimState(null, { prompt: SEEDED_PROMPT });
    expect(none.reason).toBe('none');
    expect(none.carrier).toBeNull();
    expect(none.holds).toBe(false);
    expect(none.score).toBeNull();
  });

  it('reports a rewritten prompt as drifted, carried by the prompt', () => {
    seedRemix();
    const drifted = state({ prompt: PARTIAL_PROMPT });
    expect(drifted.reason).toBe('drifted');
    expect(drifted.carrier).toBe('prompt');
    expect(drifted.holds).toBe(false);
  });

  it('reports a cleared prompt as uncarried, NOT drifted, and does not score it', () => {
    seedRemix();
    const cleared = state({ prompt: '   ' });
    expect(cleared.reason).toBe('uncarried');
    expect(cleared.carrier).toBe('prompt');
    expect(cleared.holds).toBe(false);
    expect(cleared.score).toBeNull();
  });

  it('reports a remix that seeded no prompt as uncarried, carrying nothing', () => {
    seedRemix('   ');
    const unseeded = state({ prompt: SEEDED_PROMPT });
    expect(unseeded.reason).toBe('uncarried');
    expect(unseeded.carrier).toBeNull();
    expect(unseeded.holds).toBe(false);
    expect(unseeded.score).toBeNull();
  });

  it('separates an expired claim from a drifted one, neither scored', () => {
    seedRemix(SEEDED_PROMPT, Date.now() - REMIX_CLAIM_TTL - 1);
    const expired = state({ prompt: SEEDED_PROMPT });
    expect(expired.reason).toBe('expired');
    expect(expired.holds).toBe(false);
    expect(expired.score).toBeNull();
  });

  it('leaves a media claim unscored and unreasoned', () => {
    seedRemix();
    const media = state({ prompt: 'pan left', video: { url: 'https://x/1.mp4' } });
    expect(media.carrier).toBe('media');
    expect(media.reason).toBeNull();
    expect(media.holds).toBe(true);
    expect(media.score).toBeNull();
  });

  it('keeps a prompt that changed a lot but not enough, and scores it', () => {
    seedRemix();
    const near = state({ prompt: NEAR_PROMPT });
    expect(near.reason).toBeNull();
    expect(near.carrier).toBe('prompt');
    expect(near.holds).toBe(true);
    expect(near.score).toBeGreaterThanOrEqual(0.75);
  });

  it('scores a nearer prompt above a further one, and a disjoint one at the floor', () => {
    seedRemix();
    // `toBeLessThan(0.75)` on a disjoint prompt passed for free: it shares no
    // token with the seed, so every term is 0 and any bounded wrong answer
    // satisfies it. Ordering is the property that cannot be satisfied by
    // accident — `?? -1` so a null breaks the chain rather than reading as 0.
    const near = state({ prompt: NEAR_PROMPT }).score ?? -1;
    const partial = state({ prompt: PARTIAL_PROMPT }).score ?? -1;
    const disjoint = state({ prompt: UNRELATED_PROMPT }).score ?? -1;

    expect(near).toBeGreaterThan(partial);
    expect(partial).toBeGreaterThan(disjoint);
    expect(partial).toBeLessThan(0.75);
    expect(disjoint).toBe(0);
  });
});
