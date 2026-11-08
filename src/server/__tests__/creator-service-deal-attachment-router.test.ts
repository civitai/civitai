import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const service = vi.hoisted(() => ({
  requestServiceDealAttachment: vi.fn(),
  completeServiceDealAttachment: vi.fn(),
  deleteServiceDealAttachment: vi.fn(),
}));
vi.mock('~/server/services/creator-service-deal-file.service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...service,
}));

const { createCallerFactory } = await import('~/server/trpc');
const { creatorServiceDealFileRouter } = await import(
  '~/server/routers/creator-service-deal-file.router'
);

/**
 * Drives the real router, so what is asserted is the middleware chain and the input schema in
 * front of the service: with the attachments flag off nothing reaches it, and neither does a
 * request missing an attestation.
 */
const createCaller = createCallerFactory(creatorServiceDealFileRouter);
const ONBOARDED = 1 | 2 | 4 | 8;

const callerWith = (features: Record<string, boolean>) =>
  createCaller({
    user: {
      id: 7,
      onboarding: ONBOARDED,
      emailVerified: new Date('2026-01-01T00:00:00Z'),
      meta: {},
    },
    acceptableOrigin: true,
    tokenScope: TokenScope.Full,
    features: { trpcFlagGuardPerRequest: true, ...features },
    track: {},
    ip: '127.0.0.1',
    cache: {},
    req: undefined,
    res: undefined,
  } as never);

const ON = { creatorServices: true, creatorServicesAttachments: true };
const input = {
  dealId: 1,
  fileName: 'dataset.zip',
  mimeType: 'application/zip',
  size: 100,
  rightsAttested: true as const,
  likenessAttested: true as const,
};

beforeEach(() => {
  for (const fn of Object.values(service)) fn.mockReset().mockResolvedValue({ fileId: 1 });
});

describe('attachment procedures', () => {
  it.each([
    ['the attachments flag', { creatorServices: true, creatorServicesAttachments: false }],
    ['creatorServices', { creatorServices: false, creatorServicesAttachments: true }],
  ])('are refused on the server with %s off', async (_, features) => {
    const caller = callerWith(features);
    await expect(caller.requestAttachment({ ...input })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(caller.completeAttachment({ fileId: 1 })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(caller.deleteAttachment({ fileId: 1 })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled();
  });

  it.each(['rightsAttested', 'likenessAttested'] as const)(
    'refuse a request without %s before it reaches the service',
    async (field) => {
      const caller = callerWith(ON);
      await expect(
        caller.requestAttachment({ ...input, [field]: false } as never)
      ).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
      const { [field]: _, ...missing } = input;
      await expect(caller.requestAttachment(missing as typeof input)).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
      expect(service.requestServiceDealAttachment).not.toHaveBeenCalled();
    }
  );

  it('pass both attestations and the caller to the service', async () => {
    await callerWith(ON).requestAttachment({ ...input });
    expect(service.requestServiceDealAttachment).toHaveBeenCalledWith({
      dealId: 1,
      userId: 7,
      fileName: 'dataset.zip',
      mimeType: 'application/zip',
      size: 100,
      rightsAttested: true,
      likenessAttested: true,
    });
  });
});
