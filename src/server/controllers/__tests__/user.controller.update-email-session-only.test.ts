import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as BlocklistService from '~/server/services/blocklist.service';

/**
 * `user.update` may set a first address on an account that has none, but only from a signed-in
 * session. From an API key or OAuth app token the address is dropped and the rest of the update
 * still applies.
 */

vi.mock('~/server/services/blocklist.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BlocklistService>()),
  assertEmailAllowed: vi.fn(async () => undefined),
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { updateUserHandler } from '~/server/controllers/user.controller';

const USER_ID = 4242;
const NEW_EMAIL = 'new@example.test';

const update = (apiKeyId: number | null) =>
  updateUserHandler({
    input: { id: USER_ID, email: NEW_EMAIL, showNsfw: true },
    ctx: { user: { id: USER_ID }, apiKeyId },
  } as never);

function writtenData() {
  const calls = dbMock.dbWrite.user.update.mock.calls;
  expect(calls).toHaveLength(1);
  return calls[0][0].data as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.user.findFirst.mockResolvedValue({ email: null });
  dbMock.dbRead.user.findFirst.mockResolvedValue(null);
  dbMock.dbRead.user.findUnique.mockResolvedValue({ id: USER_ID, profilePicture: null });
  dbMock.dbWrite.user.update.mockResolvedValue({ id: USER_ID });
});

describe('user.update and the account email', () => {
  it('sets a first address for a signed-in session', async () => {
    await update(null);
    expect(writtenData()).toMatchObject({ email: NEW_EMAIL, showNsfw: true });
  });

  it('drops the address for a token, and still applies the rest', async () => {
    await update(7);
    const data = writtenData();
    expect(data).not.toHaveProperty('email');
    expect(data).toMatchObject({ showNsfw: true });
  });
});
