import { describe, expect, it } from 'vitest';
import {
  IMPRESSION_ENTITY_TYPES,
  trackActionSchema,
  trackImpressionSchema,
} from '~/server/schema/track.schema';
import { ActionType } from '~/server/clickhouse/tracker';

describe('announcement analytics wiring', () => {
  it('accepts an Announcement impression', () => {
    expect(IMPRESSION_ENTITY_TYPES).toContain('Announcement');
    const parsed = trackImpressionSchema.safeParse({
      sessionKey: 'abc',
      surface: 'user',
      entities: [{ entityType: 'Announcement', entityId: 1 }],
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts a click naming both ids', () => {
    expect(
      trackActionSchema.safeParse({
        type: 'Announcement_Click',
        details: { announcementId: 1, creatorId: 2 },
      }).success
    ).toBe(true);
  });

  it('rejects a click that names no announcement', () => {
    expect(
      trackActionSchema.safeParse({ type: 'Announcement_Click', details: { creatorId: 2 } }).success
    ).toBe(false);
  });

  // 🔴 The mute counts are the half of this feature that cannot be forged, and this is what
  // makes that true: `trackActionSchema` is what `/api/track/batch` accepts from a browser,
  // so an arm for these types would let anyone post mute events for any creator. They are
  // still `ActionType`s — the tracker writes them — they are just not client-postable.
  // `BuzzLimit_Set` is the existing server-only precedent.
  it.each(['Announcement_Mute', 'Announcement_Unmute'] as const)(
    '%s is writable by the server but NOT postable by a client',
    (type) => {
      expect(ActionType).toContain(type);
      expect(trackActionSchema.safeParse({ type, details: { creatorId: 2 } }).success).toBe(false);
    }
  );
});
