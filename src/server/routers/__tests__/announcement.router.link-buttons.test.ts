import { beforeEach, describe, expect, it, vi } from 'vitest';

// The service gates the second and third link button on `isMember`, and fails closed when it is
// absent — so a router that stopped passing it would quietly take the feature away from members,
// and one that passed it from anywhere but the session would hand it to everyone.

import type * as MiddlewareTrpc from '~/server/middleware.trpc';
import type * as FeatureFlags from '~/server/services/feature-flags.service';

const { mockUpsert } = vi.hoisted(() => ({ mockUpsert: vi.fn() }));

vi.mock('~/server/services/creator-announcement.service', () => ({
  upsertCreatorAnnouncement: (...args: unknown[]) => mockUpsert(...args),
}));
vi.mock('~/server/services/announcement.service', () => ({}));
vi.mock('~/server/services/feature-flags.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlags>()),
  getFeatureFlags: () => ({ creatorAnnouncements: true }),
}));
vi.mock('~/server/middleware.trpc', async (importOriginal) => {
  const { middleware } = await import('~/server/trpc');
  return {
    ...(await importOriginal<typeof MiddlewareTrpc>()),
    rateLimit: () => middleware(async ({ next }) => next()),
  };
});

import { announcementRouter } from '../announcement.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';

function callerFor(user: Record<string, unknown>) {
  return announcementRouter.createCaller({
    user: { id: 7, isModerator: false, username: 'creator', onboarding: 0xff, ...user },
    acceptableOrigin: true,
    tokenScope: TokenScope.Full,
    apiKeyId: null,
    req: { headers: {} },
    res: { setHeader: () => undefined },
    cache: { edgeTTL: 0 },
    features: { creatorAnnouncements: true },
    track: { action: vi.fn(() => Promise.resolve(true)) },
  } as never);
}

const input = {
  title: 'New LoRA',
  content: 'Body text',
  domain: ['all'] as ['all'],
  actions: [1, 2].map((n) => ({ link: `/models/${n}`, linkText: `Button ${n}` })),
};

const isMemberFor = async (user: Record<string, unknown>) => {
  mockUpsert.mockClear();
  await callerFor(user).upsertCreatorAnnouncement(input);
  return (mockUpsert.mock.calls[0][0] as { isMember: unknown }).isMember;
};

beforeEach(() => {
  mockUpsert.mockReset();
  mockUpsert.mockResolvedValue({ id: 1 });
});

describe('announcement.upsertCreatorAnnouncement — membership for link buttons', () => {
  it('passes a paying member through as a member', async () => {
    expect(await isMemberFor({ tier: 'silver' })).toBe(true);
  });

  it('passes a free account and a failed-payment member as non-members', async () => {
    expect(await isMemberFor({ tier: 'free' })).toBe(false);
    expect(await isMemberFor({ tier: 'gold', memberInBadState: true })).toBe(false);
  });
});
