import { describe, expect, it } from 'vitest';
import { buildMetadataPatch } from '~/pages/api/admin/temp/backfill-scheduled-challenge-themes';
import { challengeMetadataSchema, parseChallengeMetadata } from '~/server/schema/challenge.schema';

// 🔴 challengeMetadataSchema declares resourceConcept as an optional STRING. A null fails the whole
// safeParse, and parseChallengeMetadata then returns {} — which the metadata write-back sites
// persist, wiping every other key including reconciliation.paidUserIds, which gates participation
// back-pay. So the backfill must OMIT the key rather than null it. A dry run over the 29 queued
// challenges hit this: one resource produced no concept.
describe('buildMetadataPatch', () => {
  const siblings = {
    challengeType: 'daily',
    resourceModelId: 7,
    reconciliation: { paidUserIds: [1, 2] },
  };

  it('omits resourceConcept entirely when the concept step produced none', () => {
    for (const empty of [undefined, '', '   ']) {
      const patch = buildMetadataPatch(['coal texture'], empty);
      expect(patch).not.toHaveProperty('resourceConcept');
    }
  });

  it('a merged patch with no concept still parses, keeping every sibling key', () => {
    const merged = { ...siblings, ...buildMetadataPatch(['coal texture'], undefined) };
    const parsed = parseChallengeMetadata(merged);
    expect(parsed.themeElements).toEqual(['coal texture']);
    expect(parsed.reconciliation?.paidUserIds).toEqual([1, 2]);
    expect(parsed.resourceModelId).toBe(7);
  });

  // The failure this guards against, stated directly: null is not merely ignored, it is destructive.
  it('null WOULD have failed the schema and emptied the metadata', () => {
    const withNull = { ...siblings, themeElements: ['coal texture'], resourceConcept: null };
    expect(challengeMetadataSchema.safeParse(withNull).success).toBe(false);
    expect(parseChallengeMetadata(withNull)).toEqual({});
  });

  it('keeps and trims a real concept', () => {
    expect(buildMetadataPatch(['coal texture'], '  matte black coal  ')).toEqual({
      themeElements: ['coal texture'],
      resourceConcept: 'matte black coal',
    });
  });
});
