import { describe, expect, it } from 'vitest';
import { buildRepublishImageIndexTouch } from '~/server/services/model-republish-image-index.sql';

/**
 * Structure gate for the republish image-index recovery bump.
 *
 * This statement is a fail-open recovery path: its only job is to move
 * `Image."updatedAt"` so a LATER delta scan rebuilds documents an unpublish
 * deleted. Every failure mode is silent — if the WHERE never matches, rows
 * just don't get bumped, the direct enqueue fails open too, and the documents
 * stay deleted while the model is public. There is no error to observe, so the
 * emitted statement is pinned here instead. Asserts the SQL text + bind values,
 * not `.mock.calls`, because both a correct and a scrambled statement would
 * satisfy a call-shape assertion.
 */
describe('buildRepublishImageIndexTouch', () => {
  it('emits numbered Postgres placeholders on .text', () => {
    const { text } = buildRepublishImageIndexTouch({ userId: 1, versionIds: [10] });
    expect(text).toContain('$1');
  });

  it('bumps Image.updatedAt, scoped by owner AND version list, joined through Post', () => {
    const statement = buildRepublishImageIndexTouch({ userId: 4944, versionIds: [10, 20, 30] });
    const text = statement.text.replace(/\s+/g, ' ').trim();

    // The table it writes and the column it moves. A wrong table/column is
    // silent — the delta scan keys on Image."updatedAt", so bumping anything
    // else re-derives nothing.
    expect(text).toMatch(/UPDATE "Image" i\b/);
    expect(text).toMatch(/SET "updatedAt" = NOW\(\)/);

    // The join and BOTH scoping predicates. Dropping the join or either
    // predicate widens the write to images the republish never affected
    // (other owners' images, other models' versions) — the exact over-broad
    // form a shape check exists to reject.
    expect(text).toMatch(/FROM "Post" p/);
    expect(text).toMatch(/i\."postId" = p\.id/);
    expect(text).toMatch(/p\."userId" = \$\d+/);
    expect(text).toMatch(/p\."modelVersionId" IN \(/);
  });

  it('binds userId then every version id, and nothing else', () => {
    // Order and contents pinned: userId is $1, the version ids follow. A swap
    // would scope by version-as-user (or vice versa); a dropped id would
    // silently under-scope the bump.
    const { values } = buildRepublishImageIndexTouch({ userId: 4944, versionIds: [10, 20, 30] });
    expect(values).toEqual([4944, 10, 20, 30]);
  });

  it('parameterizes the version ids rather than inlining them', () => {
    // Prisma.join must produce one placeholder per id. If the list were
    // interpolated as text it would both risk injection and defeat the bind
    // assertion above.
    const { text, values } = buildRepublishImageIndexTouch({
      userId: 7,
      versionIds: [101, 202],
    });
    expect(text).toContain('$1');
    expect(text).toContain('$2');
    expect(text).toContain('$3');
    expect(values).toEqual([7, 101, 202]);
  });
});
