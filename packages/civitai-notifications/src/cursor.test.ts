import { describe, expect, it } from 'vitest';
import { encodeNotificationCursor, pageNotifications, parseNotificationCursor } from './cursor';
import { queryNotificationsInput } from './schema';

describe('parseNotificationCursor', () => {
  it('reads back what encodeNotificationCursor wrote', () => {
    const position = { createdAt: '2026-11-04T03:30:00.123456', id: '2586946432' };

    expect(parseNotificationCursor(encodeNotificationCursor(position))).toEqual(position);
  });

  it('accepts the largest bigint id', () => {
    expect(parseNotificationCursor('2026-11-04T03:30:00.123456|9223372036854775807')?.id).toBe(
      '9223372036854775807'
    );
  });

  it.each([
    '',
    'not-a-cursor',
    '2026-11-04T03:30:00.123456',
    '2026-11-04T03:30:00.123456|',
    '2026-11-04T03:30:00.123456|0',
    '2026-11-04T03:30:00.123456|01',
    '2026-11-04T03:30:00.123456|-1',
    '2026-11-04T03:30:00.123456|9223372036854775808',
    '2026-11-04T03:30:00.123456|1.5',
    '2026-11-04T03:30:00.123|1',
    '2026-11-04T03:30:00.123456Z|1',
    '2026-02-30T03:30:00.000000|1',
    '1999-12-31T23:59:59.999999|1',
    ' 2026-11-04T03:30:00.123456|1',
    "2026-11-04T03:30:00.123456|1' OR 1=1",
    '2026-11-04T03:30:00.123456|1|2',
  ])('rejects %j', (value) => {
    expect(parseNotificationCursor(value)).toBeUndefined();
  });
});

describe('pageNotifications', () => {
  // node-postgres hands a bigint id back as a string.
  const row = (id: number) => ({
    id: String(2586946400 + id),
    cursorAt: `2026-11-04T00:00:00.000${100 + id}`,
  });

  it('has no next cursor when the fetch came back short', () => {
    expect(pageNotifications([row(1), row(2)], 2)).toEqual({ items: [row(1), row(2)] });
  });

  it('drops the look-ahead row and points the cursor at the last row shown', () => {
    const page = pageNotifications([row(1), row(2), row(3)], 2);

    expect(page.items).toEqual([row(1), row(2)]);
    expect(parseNotificationCursor(page.nextCursor ?? '')).toEqual({
      createdAt: row(2).cursorAt,
      id: row(2).id,
    });
  });
});

describe('queryNotificationsInput cursor', () => {
  it('rejects a date Postgres cannot store, so the route answers 400', () => {
    const far = '+275760-09-13T00:00:00.000Z';

    expect(queryNotificationsInput.safeParse({ userId: 1, cursor: far }).success).toBe(false);
    expect(
      queryNotificationsInput.safeParse({
        userId: 1,
        cursor: { createdAt: '+275760-09-13T00:00:00.000000', id: '1' },
      }).success
    ).toBe(false);
  });
});
