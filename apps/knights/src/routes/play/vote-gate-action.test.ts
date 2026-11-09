import { beforeEach, describe, expect, it, vi } from 'vitest';
import { limitsFromConfig } from '$lib/server/vote-limits/config';
import { fakeRedis } from '$lib/server/vote-limits/fake-redis';

const NOW = new Date('2026-12-15T12:00:00Z');
const redis = vi.hoisted(() => ({ current: null as unknown }));
const live = vi.hoisted(() => ({ config: null as unknown }));
const castVote = vi.hoisted(() => vi.fn());
const answerHiddenCheck = vi.hoisted(() => vi.fn());
const castYesNoVote = vi.hoisted(() => vi.fn());
const getStanding = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/standing', async (original) => ({
  ...(await original<typeof import('$lib/server/standing')>()),
  getStanding,
}));
vi.mock('$lib/server/skip-runtime', () => ({
  skipStore: { add: vi.fn(), list: vi.fn(async () => []) },
}));
vi.mock('$lib/server/db', () => ({ db: {} }));
vi.mock('$lib/server/image-url', () => ({ imageUrl: (key: string) => key }));
vi.mock('$lib/server/queue/runtime', () => ({ queueDeps: { now: () => NOW } }));
vi.mock('$lib/server/daily/daily.service', () => ({}));
vi.mock('$lib/server/smites/runtime', () => ({ feedSecret: () => 'secret', resetDeps: {} }));
vi.mock('$lib/server/hidden/runtime', () => ({ hiddenSettings: () => ({ rate: 1 }) }));
vi.mock('$lib/server/smites/smites.service', () => ({}));
vi.mock('$lib/server/hidden/hidden.service', () => ({
  answerHiddenCheck,
  pickHiddenCheck: vi.fn(),
  readHiddenNotices: vi.fn(),
  dismissHiddenNotices: vi.fn(),
}));
vi.mock('$lib/server/queue/queue.service', () => ({ castVote, getFeed: vi.fn() }));
vi.mock('$lib/server/yesno/vote', () => ({ castYesNoVote }));
vi.mock('$lib/server/yesno/feed', () => ({ pickYesNo: vi.fn() }));
vi.mock('$lib/server/yesno/runtime', () => ({ yesNoConfig: () => ({ share: 0, stretch: 8 }) }));
vi.mock('$lib/server/vote-limits/runtime', async () => {
  const { createVoteGate } = await import('$lib/server/vote-limits/gate');
  const { limitsFromConfig } = await import('$lib/server/vote-limits/config');
  return {
    lockoutFor: vi.fn(),
    voteGate: createVoteGate({
      client: () => redis.current as never,
      limits: async () => limitsFromConfig(live.config),
      timeoutMs: 2000,
    }),
  };
});

const { sealItem } = await import('$lib/server/feed-token');
const { actions } = await import('./+page.server');

const KINDS = ['queue', 'hidden', 'yesno'] as const;
const submit = (kind: (typeof KINDS)[number] = 'queue', user: Record<string, unknown> = {}) => {
  const body = new FormData();
  body.set('item', sealItem('secret', 7, { kind, id: 3 }));
  body.set('answer', '4');
  return actions.vote({
    request: new Request('http://knights.test/play', { method: 'POST', body }),
    locals: { user: { id: 7, ...user } },
  } as never);
};
const recorded = () => ({ status: 'recorded' });
let store: ReturnType<typeof fakeRedis>;

beforeEach(() => {
  store = fakeRedis();
  redis.current = store.client;
  live.config = null;
  for (const mock of [castVote, answerHiddenCheck, castYesNoVote, getStanding]) mock.mockReset();
  getStanding.mockResolvedValue({ banned: false, muted: false });
  for (const mock of [castVote, answerHiddenCheck, castYesNoVote])
    mock.mockResolvedValue(recorded());
});

describe('vote action Redis limits', () => {
  it.each(KINDS)('answers a burst of %s votes as too quick, never as an error', async (kind) => {
    const release: (() => void)[] = [];
    const slow = () => new Promise((done) => release.push(() => done(recorded())));
    for (const mock of [castVote, answerHiddenCheck, castYesNoVote]) mock.mockImplementation(slow);

    const held = [submit(kind), submit(kind), submit(kind)];
    await vi.waitFor(() => expect(release).toHaveLength(3));
    const over = await submit(kind);

    expect(over).toMatchObject({ status: 429, data: { busy: true } });
    expect(over).not.toHaveProperty('data.lockoutSeconds');
    release.forEach((done) => done());
    await Promise.all(held);
    for (const mock of [castVote, answerHiddenCheck, castYesNoVote])
      mock.mockResolvedValue(recorded());
    expect(await submit(kind)).toEqual({ success: true });
  });

  it('frees the slot when a vote fails, so later votes are not refused', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    castVote.mockRejectedValue(new Error('connection reset'));
    for (let i = 0; i < 6; i++) expect(await submit()).toMatchObject({ status: 500 });
  });

  it('refuses every vote for ten minutes once the minute window trips, without starting a vote', async () => {
    for (let i = 0; i < 40; i++) expect(await submit()).toEqual({ success: true });
    castVote.mockClear();

    expect(await submit()).toMatchObject({ status: 429, data: { lockoutSeconds: 600 } });
    expect(await submit('hidden')).toMatchObject({ status: 429, data: { lockoutSeconds: 600 } });
    expect(castVote).not.toHaveBeenCalled();
    expect(answerHiddenCheck).not.toHaveBeenCalled();
  });

  it('counts only real vote attempts: a malformed form never uses up the limits', async () => {
    for (let i = 0; i < 60; i++) {
      const body = new FormData();
      body.set('answer', '4');
      const bad = await actions.vote({
        request: new Request('http://knights.test/play', { method: 'POST', body }),
        locals: { user: { id: 7 } },
      } as never);
      expect(bad).toMatchObject({ status: 400 });
    }
    expect(await submit()).toEqual({ success: true });
    expect(store.values.size).toBeGreaterThan(0);
    expect(store.get('knights:vote-limit:{7}:w60')).toBe('1');
  });

  it('trips where the live config says', async () => {
    live.config = { perMinute: 2, perHour: 600, perDay: 3000 };
    await submit();
    await submit();
    expect(await submit()).toMatchObject({ status: 429, data: { lockoutSeconds: 600 } });
    expect(castVote).toHaveBeenCalledTimes(2);
  });

  it('trips at the built-in limits when the live config is absent', async () => {
    live.config = null;
    expect(limitsFromConfig(live.config)[0].max).toBe(40);
    for (let i = 0; i < 40; i++) await submit();
    expect(castVote).toHaveBeenCalledTimes(40);
    expect(await submit()).toMatchObject({ status: 429 });
  });

  it('never paces a moderator', async () => {
    live.config = { perMinute: 1, perHour: 1, perDay: 1 };
    for (let i = 0; i < 5; i++)
      expect(await submit('queue', { isModerator: true })).toEqual({ success: true });
    expect(store.values.size).toBe(0);
  });

  it('lets votes through to the ledger check when Redis is down', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    redis.current = new Proxy({}, { get: () => async () => Promise.reject(new Error('down')) });
    expect(await submit()).toEqual({ success: true });
    expect(castVote).toHaveBeenCalledOnce();
  });
});
