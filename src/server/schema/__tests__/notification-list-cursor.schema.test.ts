import { describe, expect, it } from 'vitest';
import { encodeNotificationCursor } from '@civitai/notifications';
import { getUserNotificationsSchema } from '~/server/schema/notification.schema';

// The `notification.getAllByUser` input, as the router applies it.
const input = getUserNotificationsSchema.partial();

describe('notification list cursor input', () => {
  it('accepts the cursor the previous page returned', () => {
    const position = { createdAt: '2026-11-04T03:30:00.123456', id: '2586946432' };

    expect(input.parse({ cursor: encodeNotificationCursor(position) }).cursor).toEqual(position);
  });

  it('accepts a date cursor from a tab opened before the keyset cursor', () => {
    const date = new Date('2026-11-04T03:30:00.123Z');

    expect(input.parse({ cursor: date }).cursor).toEqual(date);
  });

  it.each(['garbage', '2026-11-04T03:30:00.123456', new Date('+275760-09-13T00:00:00.000Z')])(
    'rejects a malformed cursor %j',
    (cursor) => {
      expect(input.safeParse({ cursor }).success).toBe(false);
    }
  );
});
