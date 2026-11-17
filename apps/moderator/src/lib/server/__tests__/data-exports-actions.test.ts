import { beforeEach, describe, expect, it, vi } from 'vitest';

const callModEndpoint = vi.hoisted(() => vi.fn());
vi.mock('../db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('../user-actions.service', () => ({ callModEndpoint }));

const { actions } = await import('../../../routes/users/data-exports/+page.server');

/** The dashboard's release button: the path that sends an account owner their data. */
const release = (
  fields: Record<string, string> = { exportId: '5' },
  grants: Record<string, true> = { 'user.personalDataExport.release': true }
) => {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return actions.release({
    request: new Request('https://x.test/users/data-exports', { method: 'POST', body: form }),
    locals: { user: { id: 4, username: 'alice' }, grants },
  } as never);
};

beforeEach(() => {
  callModEndpoint.mockReset().mockResolvedValue({
    ok: true,
    status: 200,
    body: { linkExpiresAt: '2026-11-09T00:00:00.000Z' },
  });
});

describe('data-exports release action', () => {
  it('releases through the main app with the export id (control)', async () => {
    expect(await release()).toEqual({
      success: true,
      linkExpiresAt: '2026-11-09T00:00:00.000Z',
    });
    expect(callModEndpoint).toHaveBeenCalledWith(
      'user/personal-data-export-release',
      { exportId: 5 },
      expect.any(String)
    );
  });

  it('is refused without the release permission, and sends nothing', async () => {
    expect(
      await release({ exportId: '5' }, { 'user.personalDataExport.queue': true })
    ).toMatchObject({ status: 403 });
    expect(callModEndpoint).not.toHaveBeenCalled();
  });

  it.each(['', 'abc', '0', '-1', '2147483648'])(
    'refuses a bad export id (%j) with a 400, and sends nothing',
    async (exportId) => {
      expect(await release({ exportId })).toMatchObject({ status: 400 });
      expect(callModEndpoint).not.toHaveBeenCalled();
    }
  );

  it("shows the main app's reason when it refuses the release", async () => {
    callModEndpoint.mockResolvedValue({ ok: false, status: 409, error: 'held' });
    expect(await release()).toMatchObject({ status: 400, data: { error: 'held' } });
  });
});
