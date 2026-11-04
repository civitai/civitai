import { describe, expect, it } from 'vitest';
import { encodeNotificationCursor, pageNotifications, parseNotificationCursor } from './cursor';
import { queryNotificationsInput } from './schema';

describe('parseNotificationCursor', () => {
  it('reads back what encodeNotificationCursor wrote', () => {
    const position = { createdAt: new Date('2026-11-04T03:30:00.123Z'), id: 2421362569 % 2 ** 31 };

    expect(parseNotificationCursor(encodeNotificationCursor(position))).toEqual(position);
  });

  it.each([
    '',
    'not-a-cursor',
    '2026-11-04T03:30:00.123Z',
    '2026-11-04T03:30:00.123Z|',
    '2026-11-04T03:30:00.123Z|0',
    '2026-11-04T03:30:00.123Z|-1',
    '2026-11-04T03:30:00.123Z|2147483648',
    '2026-11-04T03:30:00.123Z|1.5',
    '2026-11-04T03:30:00Z|1',
    '2026-02-30T03:30:00.000Z|1',
    ' 2026-11-04T03:30:00.123Z|1',
    "2026-11-04T03:30:00.123Z|1' OR 1=1",
    '2026-11-04T03:30:00.123Z|1|2',
  ])('rejects %j', (value) => {
    expect(parseNotificationCursor(value)).toBeUndefined();
  });
});

describe('pageNotifications', () => {
  const row = (id: number) => ({ id, createdAt: new Date(Date.UTC(2026, 10, 4, 0, 0, 0, id)) });

  it('has no next cursor when the fetch came back short', () => {
    expect(pageNotifications([row(1), row(2)], 2)).toEqual({ items: [row(1), row(2)] });
  });

  it('drops the look-ahead row and points the cursor at the last row shown', () => {
    const page = pageNotifications([row(1), row(2), row(3)], 2);

    expect(page.items).toEqual([row(1), row(2)]);
    expect(parseNotificationCursor(page.nextCursor ?? '')).toEqual(row(2));
  });
});

describe('queryNotificationsInput cursor', () => {
  it('rejects a date Postgres cannot store, so the route answers 400', () => {
    const far = '+275760-09-13T00:00:00.000Z';

    expect(queryNotificationsInput.safeParse({ userId: 1, cursor: far }).success).toBe(false);
    expect(
      queryNotificationsInput.safeParse({ userId: 1, cursor: { createdAt: far, id: 1 } }).success
    ).toBe(false);
  });
});
