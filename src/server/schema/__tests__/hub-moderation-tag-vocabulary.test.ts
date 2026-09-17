import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

import { HUB_TAG_SOURCE_FILTER } from '~/server/schema/user-hub.schema';
import { TagType } from '~/shared/utils/prisma/enums';

/**
 * Moderation labels are pickable as hub sources in BOTH directions. That is a
 * deliberate reversal (Justin, 2026-09-17) of the 2026-09-04 call that kept them out,
 * and the earlier reasoning — "the browsing level already enforces this" — reads as
 * correct until you check it. It is a coarse nsfwLevel bitmask ANDed across the feed,
 * so it cannot drop one label while keeping its band, which is the whole ask.
 *
 * If you are here because this file is in the way of narrowing the vocabulary: the
 * thing to re-litigate is that claim, not this assertion.
 */
describe('hub tag vocabulary: moderation labels are in, system tags are out', () => {
  it('admits Moderation tags as hub sources', () => {
    expect(HUB_TAG_SOURCE_FILTER.types).toContain(TagType.Moderation);
  });

  // Not a judgement about System tags — an arithmetic one. Both System image tags are
  // `unlisted`, and unlisted rows are dropped by a separate clause in `getTags` and in
  // `hubTagWhere`, so listing the type would offer 0 of 2. Measured against prod
  // 2026-09-17; Moderation was 51 of 53 by the same count.
  it('leaves System tags out, because every System image tag is unlisted anyway', () => {
    expect(HUB_TAG_SOURCE_FILTER.types).not.toContain(TagType.System);
  });

  // The picker reaches `tag.getAll` with these values. It spread the constant once and
  // was rewritten to name the two types verbatim, which made the client a second
  // statement of the rule — and the drift is one-directional: widen the constant and
  // the server accepts a tag the picker can no longer find. Textual because the
  // failure is a source-level one; the import above is what proves the values agree.
  it('keeps the picker reading the constant rather than restating it', () => {
    const src = readFileSync(
      path.join(process.cwd(), 'src/components/Hubs/HubSourceSearch.tsx'),
      'utf8'
    );
    expect(src).toContain('...HUB_TAG_SOURCE_FILTER.types');
    expect(src).not.toMatch(/types:\s*\[\s*TagType\./);
  });
});
