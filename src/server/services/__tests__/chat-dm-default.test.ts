import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { env } from '~/env/server';
import type * as FeatureFlagsService from '~/server/services/feature-flags.service';
import type * as UserPreferencesService from '~/server/services/user-preferences.service';
import type * as UserService from '~/server/services/user.service';
import type { SessionUser } from '~/types/session';

/**
 * The `following` default for a recipient with no saved DM policy, and the
 * `chatRedesign` gate on it: only recipients who can see Requests get it.
 */

const { getUserSettings, getFeatureFlagsLazy } = vi.hoisted(() => ({
  getUserSettings: vi.fn(),
  getFeatureFlagsLazy: vi.fn(),
}));

vi.mock('~/server/services/user.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserService>()),
  getUserSettings,
}));
vi.mock('~/server/services/feature-flags.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsService>()),
  getFeatureFlagsLazy,
}));
vi.mock('~/server/services/user-preferences.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserPreferencesService>()),
  BlockedUsers: { getCached: vi.fn().mockResolvedValue([]) },
  BlockedByUsers: { getCached: vi.fn().mockResolvedValue([]) },
}));
vi.mock('~/server/signals/wrapper', () => ({ withSignals: vi.fn() }));

const { resolveChatRecipients } = await import('~/server/services/chat.service');

const SENDER = 10;
const RECIPIENT = 20;

type Recipient = {
  dmPolicy?: 'everyone' | 'following' | 'mutuals' | 'nobody';
  inRedesign?: boolean;
  followsSender?: boolean;
  isEarlyAdopter?: boolean;
  tier?: string;
};

function setup({
  dmPolicy,
  inRedesign = true,
  followsSender = false,
  isEarlyAdopter,
  tier,
}: Recipient = {}) {
  getUserSettings.mockResolvedValue({
    ...(dmPolicy ? { chat: { dmPolicy } } : {}),
    ...(isEarlyAdopter !== undefined ? { isEarlyAdopter } : {}),
  });
  getFeatureFlagsLazy.mockImplementation(() => ({ chatRedesign: inRedesign || undefined }));
  dbMock.dbRead.user.findUnique.mockResolvedValue({ createdAt: new Date('2020-01-01') });
  dbMock.dbRead.userEngagement.findMany.mockResolvedValue(
    followsSender ? [{ userId: RECIPIENT, targetUserId: SENDER }] : []
  );
  dbMock.dbRead.user.findMany.mockResolvedValue([
    {
      id: RECIPIENT,
      isModerator: false,
      onboarding: 0,
      subscriptions: tier
        ? [{ status: 'active', product: { metadata: { [env.TIER_METADATA_KEY ?? 'tier']: tier } } }]
        : [],
      membershipOverride: null,
    },
  ]);
}

const route = async () => {
  const { allowed, filteredIds } = await resolveChatRecipients({
    userId: SENDER,
    recipientIds: [RECIPIENT],
  });
  if (!allowed.includes(RECIPIENT)) return 'refused';
  return filteredIds.has(RECIPIENT) ? 'requests' : 'inbox';
};

beforeEach(() => {
  getUserSettings.mockReset();
  getFeatureFlagsLazy.mockReset();
});

describe('resolveChatRecipients: no saved DM policy', () => {
  it("sends a stranger's invite to Requests for a redesign recipient", async () => {
    setup();
    expect(await route()).toBe('requests');
  });

  it('sends a followed sender to the inbox', async () => {
    setup({ followsSender: true });
    expect(await route()).toBe('inbox');
  });

  it('keeps the inbox for a recipient outside the redesign, who has no Requests tab', async () => {
    setup({ inRedesign: false });
    expect(await route()).toBe('inbox');
  });

  it('keeps the inbox when the flag evaluation throws', async () => {
    setup();
    getFeatureFlagsLazy.mockImplementation(() => {
      throw new Error('flipt down');
    });
    expect(await route()).toBe('inbox');
  });

  it('keeps the inbox when the recipient lookup fails', async () => {
    setup();
    dbMock.dbRead.user.findMany.mockRejectedValue(new Error('db down'));
    expect(await route()).toBe('inbox');
  });
});

describe('resolveChatRecipients: saved DM policy', () => {
  it("keeps a saved 'everyone' in the inbox for a redesign recipient", async () => {
    setup({ dmPolicy: 'everyone' });
    expect(await route()).toBe('inbox');
  });

  it("keeps a saved 'everyone' in the inbox outside the redesign", async () => {
    setup({ dmPolicy: 'everyone', inRedesign: false });
    expect(await route()).toBe('inbox');
  });

  it("honours a saved 'following' outside the redesign", async () => {
    setup({ dmPolicy: 'following', inRedesign: false });
    expect(await route()).toBe('requests');
  });
});

describe('resolveChatRecipients: recipients with mixed settings', () => {
  const SAVED = 30;
  const UNSET = 40;

  const routeBoth = async (recipientIds: number[]) => {
    getUserSettings.mockImplementation(async (id: number) =>
      id === SAVED ? { chat: { dmPolicy: 'everyone' } } : {}
    );
    getFeatureFlagsLazy.mockImplementation(() => ({ chatRedesign: true }));
    dbMock.dbRead.user.findUnique.mockResolvedValue({ createdAt: new Date('2020-01-01') });
    dbMock.dbRead.userEngagement.findMany.mockResolvedValue([]);
    dbMock.dbRead.user.findMany.mockImplementation((async (args: {
      where: { id: { in: number[] } };
    }) =>
      args.where.id.in.map((id) => ({
        id,
        isModerator: false,
        onboarding: 0,
        subscriptions: [],
        membershipOverride: null,
      }))) as never);

    const { allowed, filteredIds } = await resolveChatRecipients({ userId: SENDER, recipientIds });
    expect(allowed).toEqual(expect.arrayContaining([SAVED, UNSET]));
    return { saved: filteredIds.has(SAVED), unset: filteredIds.has(UNSET) };
  };

  it("routes a saved 'everyone' to the inbox and an unset redesign recipient to Requests", async () => {
    expect(await routeBoth([SAVED, UNSET])).toEqual({ saved: false, unset: true });
  });

  it('routes each recipient by their own settings in either order', async () => {
    expect(await routeBoth([UNSET, SAVED])).toEqual({ saved: false, unset: true });
  });
});

describe('chatRedesign evaluation for a recipient', () => {
  const evaluatedUser = () => getFeatureFlagsLazy.mock.calls[0]?.[0]?.user as SessionUser;

  it('hands Flipt the properties a real session carries', async () => {
    setup({ tier: 'gold', isEarlyAdopter: true });
    await route();
    expect(evaluatedUser()).toMatchObject({
      id: RECIPIENT,
      isModerator: false,
      tier: 'gold',
      isEarlyAdopter: true,
      onboarding: 0,
    });
  });

  it('keeps a tier missing from the rank table, as a real session does', async () => {
    setup({ tier: 'platinum' });
    await route();
    expect(evaluatedUser()).toMatchObject({ tier: 'platinum' });
  });

  it('is skipped for a recipient whose saved policy already decides', async () => {
    setup({ dmPolicy: 'mutuals' });
    await route();
    expect(getFeatureFlagsLazy).not.toHaveBeenCalled();
  });
});
