import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Every assistant user reads the request list, but only a holder of the audit grant answers it: an
 * answer moves a request to built or declined for everyone.
 */

const { listToolRequests, resolveToolRequest } = vi.hoisted(() => ({
  listToolRequests: vi.fn(),
  resolveToolRequest: vi.fn(),
}));

vi.mock('$lib/server/assistant/store', () => ({ listToolRequests, resolveToolRequest }));
vi.mock('$lib/server/access', () => ({
  canAccess: (user: { paths: string[] }, path: string) => user.paths.includes(path),
  canSeeAddresses: () => true,
}));
// `$lib/server/db` demands its replica URL at module scope; see routes/abuse/__tests__/load-status.test.ts.
vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));

const { actions, load } = await import('../+page.server');

const MODERATOR = { id: 7, paths: ['/assistant'] };
const AUDITOR = { id: 9, paths: ['/assistant', '/assistant/audit'] };

const resolve = (user: typeof MODERATOR, fields: Record<string, string>) => {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.set(k, v);
  return (actions.resolve as unknown as (e: unknown) => Promise<unknown>)({
    request: new Request('https://moderator.example/assistant/requests?/resolve', {
      method: 'POST',
      body,
    }),
    locals: { user, grants: {} },
  });
};

beforeEach(() => {
  listToolRequests.mockReset().mockResolvedValue([]);
  resolveToolRequest.mockReset().mockResolvedValue(true);
});

describe('/assistant/requests resolve', () => {
  it('refuses a moderator who can read the list but does not hold the audit', async () => {
    const result = await resolve(MODERATOR, { id: '3', status: 'built', response: 'done' });
    expect(result).toMatchObject({ status: 403 });
    expect(resolveToolRequest).not.toHaveBeenCalled();
  });

  it('records the answer and who gave it for an audit holder', async () => {
    expect(await resolve(AUDITOR, { id: '3', status: 'built', response: '  shipped  ' })).toEqual({
      success: true,
    });
    expect(resolveToolRequest).toHaveBeenCalledWith({
      id: 3,
      status: 'built',
      response: 'shipped',
      resolverId: 9,
    });
  });

  it('shows the answer form only to an audit holder', async () => {
    const canResolve = async (user: typeof MODERATOR) =>
      (
        (await (load as unknown as (e: unknown) => Promise<unknown>)({ locals: { user } })) as {
          canResolve: boolean;
        }
      ).canResolve;
    expect(await canResolve(MODERATOR)).toBe(false);
    expect(await canResolve(AUDITOR)).toBe(true);
  });
});
