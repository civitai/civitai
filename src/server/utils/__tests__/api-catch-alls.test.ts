import { describe, it, expect, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import modCatchAll from '~/pages/api/mod/[...path]';
import adminCatchAll from '~/pages/api/admin/[...path]';

async function statusFor(
  router: (req: NextApiRequest, res: NextApiResponse) => unknown,
  key: string
) {
  const req = { method: 'GET', query: { path: [key] } } as unknown as NextApiRequest;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as NextApiResponse;
  await router(req, res);
  return vi.mocked(res.status).mock.calls[0]?.[0];
}

// Each catch-all must read its own generated map. If the two imports were swapped, a key from the other tree
// would resolve and its real handler would load, so the answer here would not be a 404.
describe('api catch-alls', () => {
  it('does not resolve a mod-only key under /api/admin', async () => {
    expect(await statusFor(adminCatchAll, 'whoami')).toBe(404);
  });

  it('does not resolve an admin-only key under /api/mod', async () => {
    expect(await statusFor(modCatchAll, 'cache-check')).toBe(404);
  });
});
