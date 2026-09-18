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
 * The `holds` boolean is what the footers submit; `reason` is what a surface
 * would tell someone. Every test above asserts only the boolean, so `reason`
 * could be swapped between any two values and stay green.
 *
 * The pair below is the one that matters, and it is a decision rather than an
 * implementation detail: **an empty prompt is someone mid-edit, not someone who
 * has drifted.** Both are `holds: false`, so nothing distinguishes them except
 * this. Report `drifted` for a cleared box and the copy accuses a person of
 * changing their mind at the moment they cleared it to retype.
 */
describe('remixClaimState reasons', () => {
  const state = (form: Parameters<typeof remixClaimState>[1]) =>
    remixClaimState(useRemixStore.getState().data, form);

  // Asserted field by field rather than with `toMatchObject`, which truncates
  // to `expected { holds: false, ...(3) } to match object { holds: false, ...(3) }`
  // and never names the value that was wrong. The point of these tests is the
  // reason string, so the failure has to print it.
  it('reports a rewritten prompt as drifted, scored, carried by the prompt', () => {
    seedRemix();
    const drifted = state({ prompt: UNRELATED_PROMPT });
    expect(drifted.reason).toBe('drifted');
    expect(drifted.carrier).toBe('prompt');
    expect(drifted.holds).toBe(false);
    expect(drifted.score).toBeLessThan(0.75);
  });

  it('reports a cleared prompt as uncarried, NOT drifted, and does not score it', () => {
    seedRemix();
    const cleared = state({ prompt: '   ' });
    expect(cleared.reason).toBe('uncarried');
    expect(cleared.carrier).toBe('prompt');
    expect(cleared.holds).toBe(false);
    expect(cleared.score).toBeNull();
  });

  it('separates an expired claim from a drifted one, neither scored', () => {
    seedRemix(SEEDED_PROMPT, Date.now() - REMIX_CLAIM_TTL - 1);
    const expired = state({ prompt: SEEDED_PROMPT });
    expect(expired.reason).toBe('expired');
    expect(expired.holds).toBe(false);
    expect(expired.score).toBeNull();
  });

  it('scores a surviving prompt claim and leaves a media claim unscored', () => {
    seedRemix();
    const kept = state({ prompt: `${SEEDED_PROMPT}, masterpiece` });
    expect(kept.reason).toBeNull();
    expect(kept.carrier).toBe('prompt');
    expect(kept.holds).toBe(true);
    expect(kept.score).toBeGreaterThanOrEqual(0.75);

    // `null` here means not applicable, never zero — a surface reading it as a
    // number would render a media remix as maximally drifted.
    const media = state({ prompt: 'pan left', video: { url: 'https://x/1.mp4' } });
    expect(media.carrier).toBe('media');
    expect(media.holds).toBe(true);
    expect(media.score).toBeNull();
  });
});
