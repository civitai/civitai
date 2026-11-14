import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

const { addSystemPermission, removeSystemPermission, refreshSession } = vi.hoisted(() => ({
  addSystemPermission: vi.fn(),
  removeSystemPermission: vi.fn(),
  refreshSession: vi.fn(),
}));

vi.mock('~/server/utils/endpoint-helpers', () => ({
  WebhookEndpoint: (handler: unknown) => handler,
}));
vi.mock('~/server/services/system-cache', () => ({ addSystemPermission, removeSystemPermission }));
vi.mock('~/server/auth/session-invalidation', () => ({ refreshSession }));

import handler from '~/pages/api/admin/permission';

async function grant(key: string) {
  let body: unknown;
  const res = {
    status: () => res,
    json: (b: unknown) => {
      body = b;
      return res;
    },
  } as unknown as NextApiResponse;
  await handler({ query: { key, usernames: 'mod-a' } } as unknown as NextApiRequest, res);
  return body as { keys: string[]; skipped: string[] };
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.user.findMany.mockResolvedValue([{ id: 4 }]);
});

// The endpoint drops any key it does not know with a 200, so a grant of an unknown permission
// reads as success and the user never gets it.
describe('/api/admin/permission', () => {
  it('grants textScanPromptPublish instead of skipping it', async () => {
    const body = await grant('textScanPromptPublish');

    expect(body.skipped).toEqual([]);
    expect(addSystemPermission).toHaveBeenCalledWith('textScanPromptPublish', [4]);
  });

  it('skips a key that is not a permission (control)', async () => {
    const body = await grant('notARealPermissionKey');

    expect(body.skipped).toEqual(['notARealPermissionKey']);
    expect(addSystemPermission).not.toHaveBeenCalled();
  });
});
