import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The App Upload Batches audit view is for moderators granted its page, and only them: the page is
 * gated centrally by its `NAVIGATION` entry, and the blob route (which `/api/*` exempts from that
 * gate) carries the same page check itself. Every refusal also asserts no batch was read and no blob
 * fetched, so it cannot be credited to a later failure.
 */

const h = vi.hoisted(() => ({
  resolve: vi.fn(),
  probe: vi.fn(),
  fetchContent: vi.fn(),
}));

// No database here: the service's own reads are replaced below, and nothing else may connect.
vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('$lib/server/app-upload-batches.service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveUploadBatchBlob: (...a: unknown[]) => h.resolve(...a),
}));
vi.mock('$lib/server/orchestrator', () => ({
  probeOrchestratorBlob: (...a: unknown[]) => h.probe(...a),
  fetchOrchestratorBlobContent: (...a: unknown[]) => h.fetchContent(...a),
}));
vi.mock('$lib/server/axiom', () => ({ logToAxiom: async () => undefined }));

const { canAccess } = await import('$lib/server/access');
const { GET } = await import('../../../routes/api/app-upload-batch-blob/[batchId]/[index]/+server');

const ADMIN = { id: 1, roles: ['moderator:admin'] };
const UNGRANTED_MOD = { id: 7, roles: ['moderator:mod-high-access'] };

async function status(user: unknown, params = { batchId: '91', index: '0' }) {
  try {
    const res = await GET({ params, locals: { user, grants: {} } } as unknown as Parameters<
      typeof GET
    >[0]);
    return res.status;
  } catch (e) {
    return (e as { status?: number }).status;
  }
}

beforeEach(() => {
  h.resolve.mockReset().mockResolvedValue({ ok: false, status: 404, error: 'No such batch.' });
  h.probe.mockReset();
  h.fetchContent.mockReset();
});

describe('App Upload Batches — who may see it', () => {
  it('the page is in the gated navigation: an admin may open it, an ungranted moderator may not', () => {
    expect(canAccess(ADMIN, '/audit/app-upload-batches')).toBe(true);
    expect(canAccess(ADMIN, '/audit/app-upload-batches/91')).toBe(true);
    expect(canAccess(UNGRANTED_MOD, '/audit/app-upload-batches')).toBe(false);
    expect(canAccess(UNGRANTED_MOD, '/audit/app-upload-batches/91')).toBe(false);
    expect(canAccess(null, '/audit/app-upload-batches')).toBe(false);
  });

  it('the blob route refuses no session, and reads nothing', async () => {
    expect(await status(null)).toBe(403);
    expect(h.resolve).not.toHaveBeenCalled();
    expect(h.probe).not.toHaveBeenCalled();
  });

  it('the blob route refuses a moderator without the page, and reads nothing', async () => {
    expect(await status(UNGRANTED_MOD)).toBe(403);
    expect(h.resolve).not.toHaveBeenCalled();
    expect(h.probe).not.toHaveBeenCalled();
  });

  it('control: a moderator with the page reaches the batch read', async () => {
    expect(await status(ADMIN)).toBe(404);
    expect(h.resolve).toHaveBeenCalledWith(91, 0);
  });

  it('a blob the scan blocked is refused, not served as its placeholder', async () => {
    h.resolve.mockResolvedValue({ ok: true, blobKey: `${'a'.repeat(32)}.jpeg`, userId: 5 });
    h.probe.mockResolvedValue({ kind: 'blocked' });
    expect(await status(ADMIN)).toBe(451);
    expect(h.fetchContent).not.toHaveBeenCalled();
  });

  it.each([
    [{ batchId: 'x', index: '0' }],
    [{ batchId: '91', index: '-1' }],
    [{ batchId: '0', index: '0' }],
  ])('refuses a malformed position %j before any read', async (params) => {
    expect(await status(ADMIN, params)).toBe(400);
    expect(h.resolve).not.toHaveBeenCalled();
  });
});
