import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The gate that decides whether a mute is RECORDED, which is a different layer from the
 * service flag it reads. `toggleAnnouncementMute` returning `changed` correctly is tested
 * beside the service; nothing tested the consumer, so deleting `if (result.changed)` — or
 * swapping the two event types — printed nothing anywhere.
 *
 * These events are the only record of a mute over time (an unmute deletes the Postgres row),
 * so both mistakes corrupt a creator's chart rather than merely losing a sample.
 */

import type * as MiddlewareTrpc from '~/server/middleware.trpc';
import type * as FeatureFlags from '~/server/services/feature-flags.service';

const { mockToggle } = vi.hoisted(() => ({ mockToggle: vi.fn() }));

vi.mock('~/server/services/creator-announcement.service', () => ({
  toggleAnnouncementMute: (...args: unknown[]) => mockToggle(...args),
}));
// The router imports the whole announcement surface; the rest of it is not under test and
// pulls in Prisma, Redis and the image services on import.
vi.mock('~/server/services/announcement.service', () => ({}));
// Only `rateLimit` is stubbed, and only because it reaches Redis. The flag gate is left REAL
// and satisfied through `ctx.features` below, so this exercises the procedure a browser gets.
// Spread rather than hand-listed: naming exports couples the file to the router's whole
// import graph, and a missing one fails at LOAD — which reports as zero tests collected.
// The flag gate reads `getFeatureFlags(ctx)`, not `ctx.features`, and that resolves through
// Flipt. Turned on here so the test exercises the enabled procedure rather than the refusal.
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

// Returns a promise because the router attaches `.catch` — a bare `vi.fn()` makes every case
// fail on the tracker call rather than on the assertion.
const action = vi.fn(() => Promise.resolve(true));

function callerFor(userId: number) {
  return announcementRouter.createCaller({
    user: { id: userId, isModerator: false, tier: 'free', username: 'muter' },
    // `publicProcedure` refuses a caller without this and points at the public API instead,
    // so every case below would fail UNAUTHORIZED before reaching the mutation.
    acceptableOrigin: true,
    // A browser session, which is what performs a mute: full scope, no api key.
    tokenScope: TokenScope.Full,
    apiKeyId: null,
    req: { headers: {} },
    res: { setHeader: () => undefined },
    cache: { edgeTTL: 0 },
    features: { creatorAnnouncements: true },
    track: { action },
  } as never);
}

beforeEach(() => {
  action.mockClear();
  mockToggle.mockReset();
});

describe('announcement.toggleAnnouncementMute — what reaches ClickHouse', () => {
  it('records a mute that actually changed the row, once', async () => {
    mockToggle.mockResolvedValue({ muted: true, changed: true });

    await callerFor(7).toggleAnnouncementMute({ creatorId: 99, muted: true });

    expect(action).toHaveBeenCalledTimes(1);
    expect(action).toHaveBeenCalledWith(
      { type: 'Announcement_Mute', details: { creatorId: 99 } },
      // Without this the row keeps the muter's ip and userAgent forever, in a table with no
      // TTL, for an action the product presents as reversible and private.
      { skipActorMeta: true }
    );
  });

  it('records an unmute as an unmute — not the type of the state it left', async () => {
    mockToggle.mockResolvedValue({ muted: false, changed: true });

    await callerFor(7).toggleAnnouncementMute({ creatorId: 99, muted: false });

    expect(action).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'Announcement_Unmute' }),
      expect.anything()
    );
  });

  it('records NOTHING when the toggle changed nothing', async () => {
    mockToggle.mockResolvedValue({ muted: true, changed: false });

    await callerFor(7).toggleAnnouncementMute({ creatorId: 99, muted: true });

    expect(action).toHaveBeenCalledTimes(0);
  });

  it('still returns the service result to the caller', async () => {
    mockToggle.mockResolvedValue({ muted: true, changed: false });

    await expect(
      callerFor(7).toggleAnnouncementMute({ creatorId: 99, muted: true })
    ).resolves.toEqual({ muted: true, changed: false });
  });
});
