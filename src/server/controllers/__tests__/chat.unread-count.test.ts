import { expect, it } from 'vitest';

import { dbMock } from '~/__tests__/mocks/db.mock';

const { getUnreadMessagesForUserHandler } = await import('../chat.controller');

it('the badge gets the inbox and the Request rows together', async () => {
  dbMock.dbRead.$queryRaw
    .mockResolvedValueOnce([{ chatId: 1, cnt: 2 }] as never)
    .mockResolvedValueOnce([{ chatId: 9, cnt: 3 }] as never);

  const rows = await getUnreadMessagesForUserHandler({ ctx: { user: { id: 7 } } as never });

  expect(rows).toEqual([
    { chatId: 1, cnt: 2 },
    { chatId: 9, cnt: 3 },
  ]);
});
