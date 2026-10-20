import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

/**
 * The moderator app's purge reads `keptUnderHold` off this response to warn that a wipe kept
 * images. Nothing else reads it, so a rename here would silently drop that warning.
 */

const { removeAllContent } = vi.hoisted(() => ({ removeAllContent: vi.fn() }));

vi.mock('~/server/services/user.service', () => ({ removeAllContent }));
vi.mock('~/server/clickhouse/client', () => ({
  Tracker: class {
    userActivity = vi.fn();
  },
}));
vi.mock('~/server/utils/endpoint-helpers', () => ({
  WebhookEndpoint: (handler: (req: NextApiRequest, res: NextApiResponse) => unknown) => handler,
}));

import handler from '~/pages/api/mod/remove-all-content';

const run = async (userId: string) => {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as NextApiResponse;
  await handler({ method: 'POST', query: { userId } } as unknown as NextApiRequest, res);
  return res;
};

beforeEach(() => vi.clearAllMocks());

describe('/api/mod/remove-all-content', () => {
  it('returns how many images the wipe kept', async () => {
    removeAllContent.mockResolvedValue({ keptUnderHold: 7 });

    const res = await run('42');

    expect(removeAllContent).toHaveBeenCalledWith({ id: 42 });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ userId: 42, keptUnderHold: 7 });
  });
});
