import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The two moderator reads behind the dispute queue. The endpoint wrapper (auth, rate limit, audit)
 * is the shared one and is passed through here; what is pinned is each handler's own behaviour.
 */

const service = vi.hoisted(() => ({
  listServiceDealFiles: vi.fn(),
  listServiceDealFileAccess: vi.fn(),
  getServiceDealFileAccessRecordedSince: vi.fn(),
  resolveServiceDealFileDownload: vi.fn(),
  getServiceDealFileDownloadUrl: vi.fn(),
}));
vi.mock('~/server/services/creator-service-deal-file.service', () => service);
vi.mock('~/server/utils/moderator-endpoint', () => ({
  defineModeratorEndpoint: (_name: string, def: unknown) => def,
}));

type Handler<I, O> = {
  handler: (input: I, ctx: { actor: { id: number }; tracker?: unknown }) => Promise<O>;
};
const files = (await import('../../../pages/api/mod/creator-services/deal-files'))
  .default as unknown as Handler<{ dealId?: number; dealIds?: string }, { items: any[] }>;
const url = (await import('../../../pages/api/mod/creator-services/deal-file-url'))
  .default as unknown as Handler<{ fileId: number }, { url: string; expiresAt: string }>;

const actor = { actor: { id: 99 } };
const notFound = () => new TRPCError({ code: 'NOT_FOUND' });

beforeEach(() => {
  service.listServiceDealFiles.mockReset();
  service.listServiceDealFileAccess.mockReset();
  service.listServiceDealFileAccess.mockResolvedValue([]);
  service.getServiceDealFileAccessRecordedSince.mockResolvedValue(null);
  service.resolveServiceDealFileDownload.mockReset();
  service.getServiceDealFileDownloadUrl.mockReset();
  service.listServiceDealFiles.mockImplementation(async ({ dealId }: { dealId: number }) => [
    { id: dealId * 10, kind: 'Final' },
  ]);
});

describe('deal-files', () => {
  it('lists one deal, tagging each row with its deal, as a moderator', async () => {
    expect(await files.handler({ dealId: 4 }, actor)).toEqual({
      items: [{ dealId: 4, id: 40, kind: 'Final', access: [] }],
      accessRecordedSince: null,
    });
    expect(service.listServiceDealFiles).toHaveBeenCalledWith({
      dealId: 4,
      userId: 99,
      isModerator: true,
    });
  });

  it("puts each file's recorded accesses on that file", async () => {
    const at = new Date('2026-10-01T00:00:00Z');
    const entry = (fileId: number, role: string, count: number) => ({
      dealId: fileId / 10,
      fileId,
      role,
      kind: 'Download',
      count,
      firstAt: at,
      lastAt: at,
    });
    service.listServiceDealFileAccess.mockResolvedValue([
      entry(30, 'Buyer', 2),
      entry(30, 'Seller', 1),
      entry(50, 'Buyer', 1),
    ]);
    const { items } = await files.handler({ dealIds: '3,5,7' }, actor);
    expect(service.listServiceDealFileAccess).toHaveBeenCalledWith([3, 5, 7]);
    expect(
      items.map((i) => [
        i.id,
        i.access.map((a: { role: string; count: number }) => `${a.role}:${a.count}`),
      ])
    ).toEqual([
      [30, ['Buyer:2', 'Seller:1']],
      [50, ['Buyer:1']],
      [70, []],
    ]);
  });

  it('still lists the files when the access log cannot be read, with no access on them', async () => {
    service.listServiceDealFileAccess.mockRejectedValue(new Error('relation does not exist'));
    const result = await files.handler({ dealId: 4 }, actor);
    expect(result).toEqual({
      items: [{ dealId: 4, id: 40, kind: 'Final' }],
      accessRecordedSince: null,
    });
  });

  it('lists a page of deals in one call, each row carrying its own dealId', async () => {
    const { items } = await files.handler({ dealIds: '3, 5,7' }, actor);
    expect(items.map((i) => [i.dealId, i.id])).toEqual([
      [3, 30],
      [5, 50],
      [7, 70],
    ]);
  });

  it('counts a repeated id once, and a dealId alongside dealIds', async () => {
    const { items } = await files.handler({ dealId: 3, dealIds: '3,3' }, actor);
    expect(items).toHaveLength(1);
  });

  it('skips a deal that is not there, and fails on any other error', async () => {
    service.listServiceDealFiles.mockImplementation(async ({ dealId }: { dealId: number }) => {
      if (dealId === 5) throw notFound();
      if (dealId === 6) throw new Error('db down');
      return [{ id: dealId * 10 }];
    });
    expect((await files.handler({ dealIds: '3,5' }, actor)).items.map((i) => i.dealId)).toEqual([
      3,
    ]);
    await expect(files.handler({ dealIds: '3,6' }, actor)).rejects.toThrow('db down');
  });

  it('takes 25 deals and refuses 26', async () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => i + 1).join(',');
    expect((await files.handler({ dealIds: ids(25) }, actor)).items).toHaveLength(25);
    await expect(files.handler({ dealIds: ids(26) }, actor)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it.each(['abc', '1,,2', '0', '-1', '1.5'])('refuses the bad id list %j', async (dealIds) => {
    await expect(files.handler({ dealIds }, actor)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(service.listServiceDealFiles).not.toHaveBeenCalled();
  });

  it('refuses a call that names no deal', async () => {
    await expect(files.handler({}, actor)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});

describe('deal-file-url', () => {
  it('signs the original for a moderator and says when it stops working', async () => {
    service.resolveServiceDealFileDownload.mockResolvedValue({
      bucket: 'b',
      key: 'k',
      fileName: 'f',
    });
    service.getServiceDealFileDownloadUrl.mockResolvedValue('https://signed/url');
    const before = Date.now();
    const tracker = { serviceDealFileAccess: vi.fn() };
    const result = await url.handler({ fileId: 12 }, { ...actor, tracker });
    expect(result.url).toBe('https://signed/url');
    const expires = new Date(result.expiresAt).getTime();
    expect(expires).toBeGreaterThanOrEqual(before + 299_000);
    expect(expires).toBeLessThanOrEqual(Date.now() + 301_000);
    expect(service.resolveServiceDealFileDownload).toHaveBeenCalledWith({
      fileId: 12,
      userId: 99,
      isModerator: true,
      moderatorFetch: true,
    });
    expect(service.getServiceDealFileDownloadUrl).toHaveBeenCalledWith(expect.anything(), tracker);
  });

  it('answers an unknown file with not-found and signs nothing', async () => {
    service.resolveServiceDealFileDownload.mockResolvedValue(null);
    await expect(url.handler({ fileId: 12 }, actor)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(service.getServiceDealFileDownloadUrl).not.toHaveBeenCalled();
  });
});
