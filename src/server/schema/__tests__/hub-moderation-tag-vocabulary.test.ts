import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

import { HUB_TAG_SOURCE_FILTER } from '~/server/schema/user-hub.schema';
import { TagType } from '~/shared/utils/prisma/enums';

/**
 * Moderation labels are pickable as hub sources in BOTH directions. That is a
 * deliberate reversal (Justin, 2026-09-17) of the 2026-09-04 call that kept them out.
 * `HUB_TAG_SOURCE_FILTER`'s docblock carries the argument, including the half of the
 * original reasoning that is still true and was overridden rather than refuted.
 *
 * If you are here because this file blocks a narrowing: read that docblock and argue
 * the trade it names. Do not re-derive that a tag exclude is best-effort — it is, and
 * that was known when the call was made.
 */
describe('hub tag vocabulary: moderation labels are in, system tags are out', () => {
  it('admits Moderation tags as hub sources', () => {
    expect(HUB_TAG_SOURCE_FILTER.types).toContain(TagType.Moderation);
  });

  // Not a judgement about System tags — arithmetic. Both System image tags are
  // `unlisted`, and unlisted rows are dropped by a separate clause in `getTags` and in
  // `hubTagWhere`, so listing the type would offer 0 of 2. Prod, 2026-09-17.
  it('leaves System tags out, because every System image tag is unlisted anyway', () => {
    expect(HUB_TAG_SOURCE_FILTER.types).not.toContain(TagType.System);
  });

  /**
   * The picker must PASS the constant, not restate or reshape it. Resolved from this
   * file rather than `process.cwd()`, so a run whose cwd is not the repo root fails on
   * the assertion instead of on ENOENT.
   *
   * 🔴 Both halves are load-bearing, and the second is the one that catches the
   * plausible regression. Whoever narrows the picker back will start from the spread
   * line and edit it — `[...HUB_TAG_SOURCE_FILTER.types].filter(t => t !== Moderation)`
   * re-narrows the client to exactly the pre-reversal vocabulary while still CONTAINING
   * the spread, so the first assertion alone goes green over a silently reverted
   * feature. Retyping the array as a literal is the shape nobody actually uses.
   */
  it('keeps the picker passing the constant rather than restating or reshaping it', () => {
    const src = readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        '../../../components/Hubs/HubSourceSearch.tsx'
      ),
      'utf8'
    );
    expect(src).toContain('...HUB_TAG_SOURCE_FILTER.types');
    expect(src).not.toMatch(/types:\s*\[\s*TagType\./);
    expect(src).not.toMatch(/HUB_TAG_SOURCE_FILTER\.types\s*\]?\s*\.\s*(filter|slice|splice)/);
  });
});
