import { describe, expect, it } from 'vitest';
import { CREATOR_SCORE_ANCHOR } from '~/components/Account/creator-score-copy';
import { CREATOR_SCORE_EXPLAINER_HREF } from '~/shared/constants/creator-journey.constants';

describe('CREATOR_SCORE_EXPLAINER_HREF', () => {
  // Kept a literal on purpose: account-sections.test.ts finds `/user/account#…` links by scanning
  // source text, and a template built from the anchor would hide this one from it. This pins the two
  // spellings together instead, so renaming the card's anchor cannot strand every explainer link.
  it('points at the account score card anchor', () => {
    expect(CREATOR_SCORE_EXPLAINER_HREF).toBe(`/user/account#${CREATOR_SCORE_ANCHOR}`);
  });
});
