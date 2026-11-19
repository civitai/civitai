import { describe, expect, it } from 'vitest';
import { heldUserSql } from '@civitai/shared/held-media';
import * as eventEngine from '../../../../apps/event-engine/src/vector-sync/held';
import { semanticImageHeldText } from '~/server/services/semantic-held-content.sql';

// The event-engine cannot import @civitai/shared, so it carries a copy of these rules. A copy that
// drifts by one leg would embed held content, so the two must produce the same SQL.
describe("the event-engine's held-content SQL", () => {
  it('is the shared held-user rule', () => {
    for (const column of ['m."userId"', 'st."userId"'])
      expect(eventEngine.heldUserSql(column)).toBe(heldUserSql(column));
  });

  it("is the site's held-image rule", () => {
    expect(eventEngine.heldImageSql('ri')).toBe(semanticImageHeldText('ri'));
  });

  it('refuses a reference it would splice unchecked', () => {
    expect(() => eventEngine.heldUserSql('x); DROP TABLE "User"; --')).toThrow(/reference/);
    expect(() => heldUserSql('x); DROP TABLE "User"; --')).toThrow(/reference/);
    expect(() => eventEngine.heldImageSql('ri.id')).toThrow(/alias/);
  });
});
