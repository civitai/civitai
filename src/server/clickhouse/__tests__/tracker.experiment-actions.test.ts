import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { trackActionSchema } from '~/server/schema/track.schema';

vi.mock('~/env/other', () => ({ isProd: false, isDev: true }));
vi.mock('~/server/auth/get-server-auth-session', () => ({
  getServerAuthSession: vi.fn(async () => null),
}));

import { Tracker } from '../tracker';

const req = {
  headers: {},
  socket: { remoteAddress: '203.0.113.9' },
} as never;

let fetchMock: ReturnType<typeof vi.fn>;

async function writtenRow(type: 'Experiment_Exposure' | 'HatTurf_Action' | 'UserMenu_Click') {
  const tracker = new Tracker(req, undefined, { user: { id: 42 } } as never);
  const before = fetchMock.mock.calls.length;
  await tracker.action({ type, details: {} });
  expect(fetchMock.mock.calls.length).toBe(before + 1);
  const [, init] = fetchMock.mock.calls.at(-1) as [string, { body: string }];
  return JSON.parse(init.body) as Record<string, unknown>;
}

describe('experiment actions on the actions table', () => {
  beforeEach(() => {
    fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => '' }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it.each(['Experiment_Exposure', 'HatTurf_Action'] as const)(
    '%s keeps the user id and stores no ip or userAgent, from any caller',
    async (type) => {
      const row = await writtenRow(type);
      expect(row).toMatchObject({ type, userId: 42 });
      expect(row).not.toHaveProperty('ip');
      expect(row).not.toHaveProperty('userAgent');
    }
  );

  it('leaves actor metadata on other action types', async () => {
    expect(await writtenRow('UserMenu_Click')).toHaveProperty('userAgent');
  });
});

describe('what a browser may post', () => {
  const exposure = (details: Record<string, unknown>) =>
    trackActionSchema.safeParse({ type: 'Experiment_Exposure', details }).success;
  const base = {
    exp: 'hatTurfFeedCard',
    variant: 'count-button',
    assignment: 'rule',
    surface: 'feed-card',
  };

  it('accepts an exposure to an arm the registry lists', () => {
    expect(exposure(base)).toBe(true);
  });

  it.each([
    ['an arm the experiment does not have', { variant: 'invite-inline' }],
    ['an unknown experiment', { exp: 'somethingElse' }],
    ['an unknown assignment', { assignment: 'forced' }],
  ])('rejects %s', (_label, change) => {
    expect(exposure({ ...base, ...change })).toBe(false);
  });

  it('accepts Hat Turf UI actions but never a join or leave, which only the server writes', () => {
    const post = (action: string) =>
      trackActionSchema.safeParse({
        type: 'HatTurf_Action',
        details: { action, event: 'birthday2026', surface: 'image-detail' },
      }).success;
    expect(post('invite_dismiss')).toBe(true);
    expect(post('opt_in')).toBe(false);
    expect(post('opt_out')).toBe(false);
  });
});
