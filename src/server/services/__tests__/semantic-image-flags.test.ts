import { describe, expect, it } from 'vitest';
import * as eventEngine from '../../../../apps/event-engine/src/vector-sync/image-flags';
import {
  semanticCoverImageCleanText,
  semanticImageCsamFlaggedText,
} from '~/server/services/semantic-image-flags.sql';

// The event-engine cannot import the site, so it carries a copy of these rules. A copy that drifts
// by one leg would embed CSAM-flagged content, so the two must produce the same SQL.
describe("the event-engine's image-flag SQL", () => {
  it("is the site's CSAM-flag rule", () => {
    expect(eventEngine.csamFlaggedImageSql('ri')).toBe(semanticImageCsamFlaggedText('ri'));
  });

  it("is the site's clean-cover rule", () => {
    expect(eventEngine.coverImageCleanSql('st."coverImageId"')).toBe(
      semanticCoverImageCleanText('st."coverImageId"')
    );
  });

  it('refuses a reference it would splice unchecked', () => {
    expect(() => eventEngine.csamFlaggedImageSql('ri.id')).toThrow(/alias/);
    expect(() => semanticImageCsamFlaggedText('ri.id')).toThrow(/alias/);
    expect(() => eventEngine.coverImageCleanSql('x); DROP TABLE "Image"; --')).toThrow(/reference/);
  });
});
