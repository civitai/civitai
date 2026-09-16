import { beforeEach, describe, expect, it } from 'vitest';

import { REMIX_CLAIM_TTL, useRemixStore } from '~/store/remix.store';
import { remixClaimHolds, resolveRemixOfId } from '~/utils/remix-claim';

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
