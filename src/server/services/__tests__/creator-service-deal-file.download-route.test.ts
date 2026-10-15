import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The download route is thin: it must send an allowed user to a signed URL, answer every refusal
 * with the same 404, and never let an edge cache keep a per-user redirect.
 */

const service = vi.hoisted(() => ({
  resolveServiceDealFileDownload: vi.fn(),
  getServiceDealFileDownloadUrl: vi.fn(),
}));
vi.mock('~/server/services/creator-service-deal-file.service', () => service);
vi.mock('~/server/utils/endpoint-helpers', () => ({
  AuthedEndpoint: (handler: unknown) => handler,
}));

const { default: handler } = (await import(
  '../../../pages/api/service-deals/files/[fileId]/download'
)) as unknown as {
  default: (req: unknown, res: unknown, user: unknown) => Promise<unknown>;
};

const response = () => {
  const res = {
    headers: {} as Record<string, string>,
    statusCode: 0,
    body: undefined as unknown,
    redirected: undefined as string | undefined,
    setHeader(name: string, value: string) {
      res.headers[name] = value;
    },
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.body = body;
      return res;
    },
    redirect(url: string) {
      res.redirected = url;
      return res;
    },
  };
  return res;
};

const call = (fileId: unknown, user = { id: 7, isModerator: false }) => {
  const res = response();
  return handler({ query: { fileId } }, res, user).then(() => res);
};

beforeEach(() => {
  vi.clearAllMocks();
  service.resolveServiceDealFileDownload.mockReset();
  service.getServiceDealFileDownloadUrl.mockResolvedValue('https://signed/url');
});

describe('download route', () => {
  it('redirects an allowed user to the signed URL, uncached', async () => {
    service.resolveServiceDealFileDownload.mockResolvedValue({
      bucket: 'b',
      key: 'k',
      fileName: 'f.zip',
    });
    const res = await call('12');
    expect(res.redirected).toBe('https://signed/url');
    expect(res.headers['Cache-Control']).toMatch(/no-store/);
    expect(service.resolveServiceDealFileDownload).toHaveBeenCalledWith({
      fileId: 12,
      userId: 7,
      isModerator: false,
    });
  });

  it('passes the moderator flag through', async () => {
    service.resolveServiceDealFileDownload.mockResolvedValue({
      bucket: 'b',
      key: 'k',
      fileName: 'f',
    });
    await call('12', { id: 9, isModerator: true });
    expect(service.resolveServiceDealFileDownload).toHaveBeenCalledWith({
      fileId: 12,
      userId: 9,
      isModerator: true,
    });
  });

  it('answers a refusal with the same 404 as a file that does not exist, and signs nothing', async () => {
    service.resolveServiceDealFileDownload.mockResolvedValue(null);
    const res = await call('12');
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });
    expect(res.redirected).toBeUndefined();
    expect(service.getServiceDealFileDownloadUrl).not.toHaveBeenCalled();
  });

  it.each(['abc', '0', '-3', '1.5', undefined, ['1', '2']])(
    'answers a bad file id (%j) with 404 without looking anything up',
    async (bad) => {
      const res = await call(bad);
      expect(res.statusCode).toBe(404);
      expect(service.resolveServiceDealFileDownload).not.toHaveBeenCalled();
    }
  );
});
