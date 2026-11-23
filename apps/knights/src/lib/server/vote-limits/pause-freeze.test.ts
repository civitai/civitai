// The vote action, the real gate (its Lua over fake Redis) and the real `voteLockout`, with the ledger read
// (`voteLockUntil`) standing on an in-memory list of vote times: what a player is shown while paused.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { limitsFromConfig } from './config';
import { fakeRedis } from './fake-redis';
import { createVoteGate, type VoteGate } from './gate';

const T0 = new Date('2026-12-15T12:00:00Z').getTime();
const MIN = 60_000;
const clock = vi.hoisted(() => ({ ms: 0 }));
// `reads` counts the ledger reads behind `lockoutFor`; `failing` makes them throw (a degraded database).
const ledger = vi.hoisted(() => ({ rows: [] as number[], reads: 0, failing: false }));
const live = vi.hoisted(() => ({ config: null as unknown }));
const redisCtl = vi.hoisted(() => ({ down: false }));
const castVote = vi.hoisted(() => vi.fn());
const getStanding = vi.hoisted(() => vi.fn());
const gate = vi.hoisted(() => ({ current: null as unknown as VoteGate }));

vi.mock('$lib/server/standing', async (original) => ({
  ...(await original<typeof import('$lib/server/standing')>()),
  getStanding,
}));
vi.mock('$lib/server/skip-runtime', () => ({
  skipStore: { add: vi.fn(), list: vi.fn(async () => []) },
}));
vi.mock('$lib/server/db', () => ({ db: {}, dbRead: {} }));
vi.mock('$lib/server/image-url', () => ({ imageUrl: (key: string) => key }));
vi.mock('$lib/server/queue/runtime', () => ({ queueDeps: { now: () => new Date(clock.ms) } }));
vi.mock('$lib/server/daily/daily.service', () => ({}));
vi.mock('$lib/server/smites/runtime', () => ({ feedSecret: () => 'secret', resetDeps: {} }));
vi.mock('$lib/server/hidden/runtime', () => ({ hiddenSettings: () => ({ rate: 1 }) }));
vi.mock('$lib/server/smites/smites.service', () => ({}));
vi.mock('$lib/server/hidden/hidden.service', () => ({
  hiddenItemId: (id: number) => -id,
  answerHiddenCheck: vi.fn(),
  pickHiddenCheck: vi.fn(),
  readHiddenNotices: vi.fn(),
  dismissHiddenNotices: vi.fn(),
}));
vi.mock('$lib/server/queue/queue.service', () => ({ castVote, getFeed: vi.fn() }));
vi.mock('$lib/server/yesno/vote', () => ({ castYesNoVote: vi.fn() }));
vi.mock('$lib/server/yesno/feed', () => ({ pickYesNo: vi.fn() }));
vi.mock('$lib/server/yesno/runtime', () => ({ yesNoConfig: () => ({ share: 0, stretch: 8 }) }));

// The same arithmetic as `voteLockUntil`, over the in-memory ledger.
function ledgerLock(now: number, limits: { windowSeconds: number; max: number }[]) {
  let latest = 0;
  for (const { windowSeconds, max } of limits) {
    const filling = ledger.rows.filter((t) => t > now - windowSeconds * 1000).sort((a, b) => b - a)[
      max - 1
    ];
    if (filling !== undefined) latest = Math.max(latest, filling + windowSeconds * 1000);
  }
  return latest ? new Date(latest) : null;
}
vi.mock('$lib/server/queue/vote-rate', async (original) => ({
  ...(await original<typeof import('$lib/server/queue/vote-rate')>()),
  voteLockUntil: async (
    _db: unknown,
    _player: number,
    now: Date,
    limits: { windowSeconds: number; max: number }[]
  ) => {
    ledger.reads++;
    if (ledger.failing) throw new Error('database unavailable');
    return ledgerLock(now.getTime(), limits);
  },
}));
vi.mock('$lib/server/vote-limits/runtime', async () => {
  const { voteLockout } = await import('$lib/server/vote-limits/lockout');
  const { limitsFromConfig } = await import('$lib/server/vote-limits/config');
  return {
    lockoutFor: (db: unknown, userId: number, now: Date, floor: Date | null = null) =>
      voteLockout(
        db as never,
        userId,
        now,
        { gate: gate.current, limits: { load: async () => limitsFromConfig(live.config) } },
        floor
      ),
    voteGate: new Proxy({}, { get: (_, key) => gate.current[key as keyof VoteGate] }),
  };
});

const { sealItem } = await import('$lib/server/feed-token');
const { actions } = await import('../../../routes/play/+page.server');
const { lockoutFor } = await import('$lib/server/vote-limits/runtime');

type Answer =
  | { status?: number; data?: { lockoutSeconds?: number; busy?: true } }
  | { success: true };

let store: ReturnType<typeof fakeRedis>;
const setNow = (ms: number) => {
  clock.ms = ms;
  store.clock.now = ms;
};
const COUNTER = (window: string) => `knights:vote-limit:{7}:${window}`;

const submit = (user: Record<string, unknown> = {}) => {
  const body = new FormData();
  body.set('item', sealItem('secret', 7, { kind: 'queue', id: 3 }));
  body.set('answer', '4');
  return actions.vote({
    request: new Request('http://knights.test/play', { method: 'POST', body }),
    locals: { user: { id: 7, ...user } },
  } as never) as Promise<Answer>;
};
/** The end a pace refusal gave, in ms, or null for any other answer. */
const endOf = (res: Answer) =>
  'status' in res && res.status === 429 && res.data?.lockoutSeconds !== undefined && !res.data.busy
    ? clock.ms + res.data.lockoutSeconds * 1000
    : null;
/** The end `/play` would show now, in ms. */
const show = async () => (await lockoutFor({} as never, 7, new Date(clock.ms)))?.getTime() ?? null;

beforeEach(() => {
  store = fakeRedis();
  setNow(T0);
  ledger.rows = [];
  ledger.reads = 0;
  ledger.failing = false;
  redisCtl.down = false;
  live.config = null;
  const real = store.client;
  gate.current = createVoteGate({
    client: () =>
      ({
        eval: (...args: Parameters<typeof real.eval>) =>
          redisCtl.down ? Promise.reject(new Error('down')) : real.eval(...args),
        pTTL: (key: string) => (redisCtl.down ? Promise.reject(new Error('down')) : real.pTTL(key)),
      } as never),
    limits: async () => limitsFromConfig(live.config),
    timeoutMs: 2000,
  });
  castVote.mockReset();
  getStanding.mockReset();
  getStanding.mockResolvedValue({ banned: false, muted: false });
  // The ledger check inside the vote transaction: refuse while the trailing windows are full, else record.
  castVote.mockImplementation(async (_db: unknown, args: { isModerator?: boolean }) => {
    if (!args.isModerator) {
      const until = ledgerLock(clock.ms, limitsFromConfig(live.config));
      if (until) return { status: 'limited', until };
    }
    ledger.rows.push(clock.ms);
    return { status: 'recorded' };
  });
});

const HOUR3 = { perMinute: 1000, perHour: 3, perDay: 3000 };
// Three votes 38 minutes ago: the ledger's trailing hour is full until T0 + 22 min.
const seedFullHour = () => {
  for (let i = 0; i < 3; i++) ledger.rows.push(T0 - 38 * MIN);
};
const SLACK = 1000;

describe('the countdown never moves later during a pause', () => {
  it('holds through many refused votes after the pause is shown, with the fixed hour counter empty', async () => {
    live.config = HOUR3;
    seedFullHour();
    const first = (await show())!;
    expect(first).toBe(T0 + 22 * MIN);
    const ends: number[] = [];
    for (let i = 0; i < 40; i++) {
      setNow(clock.ms + 1000);
      const end = endOf(await submit());
      if (end) ends.push(end);
      const shown = await show();
      if (shown) ends.push(shown);
    }
    expect(Math.max(...ends)).toBeLessThanOrEqual(first + SLACK);
  });

  it('holds when the fixed hour counter is already at its cap', async () => {
    live.config = HOUR3;
    seedFullHour();
    store.seed(COUNTER('w3600'), '3', 50 * MIN);
    const first = (await show())!;
    const ends: number[] = [];
    for (let i = 0; i < 10; i++) {
      setNow(clock.ms + 1000);
      const end = endOf(await submit());
      if (end) ends.push(end);
      const shown = await show();
      if (shown) ends.push(shown);
    }
    expect(Math.max(...ends)).toBeLessThanOrEqual(first + SLACK);
  });

  it('holds when the first the player sees of the pause is a refusal', async () => {
    live.config = HOUR3;
    seedFullHour();
    store.seed(COUNTER('w3600'), '2', 50 * MIN);
    const first = endOf(await submit())!;
    const ends: number[] = [];
    for (let i = 0; i < 10; i++) {
      setNow(clock.ms + 1000);
      const end = endOf(await submit());
      if (end) ends.push(end);
      const shown = await show();
      if (shown) ends.push(shown);
    }
    expect(Math.max(...ends)).toBeLessThanOrEqual(first + SLACK);
  });

  it('answers every refused vote with the first refusal’s end, and stops counting them', async () => {
    live.config = HOUR3;
    seedFullHour();
    for (let i = 0; i < 6; i++) {
      expect(await submit()).toMatchObject({ status: 429, data: { lockoutSeconds: 22 * 60 } });
    }
    expect(castVote).toHaveBeenCalledOnce();
    expect(store.get(COUNTER('w3600'))).toBe('1');
  });

  it.each([0, 1, 2, 3])(
    'never shows a later end to a vote or read that starts after another finished (hour counter at %i)',
    async (seed) => {
      live.config = HOUR3;
      seedFullHour();
      if (seed) store.seed(COUNTER('w3600'), String(seed), 50 * MIN);
      const log: { start: number; end: number; at: number }[] = [];
      let seq = 0;
      const observe = async (read: () => Promise<number | null>) => {
        const start = seq++;
        const at = await read();
        const end = seq++;
        if (at) log.push({ start, end, at });
      };
      const vote = async () => endOf(await submit());
      const round = () =>
        Promise.all([observe(vote), observe(vote), observe(vote), observe(show), observe(vote)]);
      await round();
      for (let i = 0; i < 4; i++) {
        setNow(clock.ms + 500);
        await round();
      }
      expect(log.length).toBeGreaterThan(0);
      for (const later of log)
        for (const earlier of log)
          if (earlier.end < later.start) expect(later.at).toBeLessThanOrEqual(earlier.at + SLACK);
    }
  );

  it('keeps the shown ledger end when a shorter fixed window trips during it', async () => {
    live.config = { perMinute: 2, perHour: 3, perDay: 3000 };
    seedFullHour();
    // The minute counter is at its cap: the next vote would trip a ten-minute cooldown, shorter than the ledger lock.
    store.seed(COUNTER('w60'), '2', 30_000);
    const first = (await show())!;
    const ends: number[] = [];
    await Promise.all(
      [0, 1, 2].map(async () => {
        const end = endOf(await submit());
        if (end) ends.push(end);
      })
    );
    const shown = await show();
    if (shown) ends.push(shown);
    expect(Math.max(...ends)).toBeLessThanOrEqual(first + SLACK);
    expect(Math.min(...ends)).toBeGreaterThanOrEqual(T0 + 10 * MIN - SLACK);
  });

  it('answers a window that trips inside a longer ledger lock with the ledger end, and keeps it', async () => {
    live.config = { perMinute: 2, perHour: 3, perDay: 3000 };
    seedFullHour();
    store.seed(COUNTER('w60'), '2', 30_000);

    expect(await submit()).toMatchObject({ status: 429, data: { lockoutSeconds: 22 * 60 } });
    expect(await submit()).toMatchObject({ status: 429, data: { lockoutSeconds: 22 * 60 } });
  });

  it('answers a ledger refusal with a longer cooldown already running', async () => {
    live.config = HOUR3;
    seedFullHour();
    castVote.mockImplementation(async () => {
      // Another of the player's votes tripped an hour's cooldown while this one was in flight.
      store.seed(COUNTER('cooldown'), '1', 60 * MIN);
      return { status: 'limited', until: new Date(T0 + 22 * MIN) };
    });
    expect(await submit()).toMatchObject({ status: 429, data: { lockoutSeconds: 60 * 60 } });
  });

  it('answers the ledger end when Redis is down', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    live.config = HOUR3;
    seedFullHour();
    redisCtl.down = true;
    expect(await submit()).toMatchObject({ status: 429, data: { lockoutSeconds: 22 * 60 } });
    expect(await show()).toBe(T0 + 22 * MIN);
  });

  it('answers a vote refused during a running cooldown from the cooldown, without reading the ledger', async () => {
    live.config = HOUR3;
    seedFullHour();
    expect(await show()).toBe(T0 + 22 * MIN);
    ledger.reads = 0;

    expect(await submit()).toMatchObject({ status: 429, data: { lockoutSeconds: 22 * 60 } });
    expect(ledger.reads).toBe(0);
    expect(castVote).not.toHaveBeenCalled();
  });

  it('answers a ledger refusal with its own end when the lockout cannot be read', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    live.config = HOUR3;
    seedFullHour();
    ledger.failing = true;

    expect(await submit()).toMatchObject({ status: 429, data: { lockoutSeconds: 22 * 60 } });
    expect(log).toHaveBeenCalledWith('knights: could not read the vote lockout', expect.anything());
  });

  it('records no vote while paused', async () => {
    live.config = HOUR3;
    seedFullHour();
    for (let i = 0; i < 25; i++) {
      setNow(clock.ms + 1000);
      await submit();
    }
    expect(ledger.rows).toHaveLength(3);
  });
});

describe('voting resumes when the pause ends', () => {
  it.each([0, 30, 1])(
    'takes the first vote at the shown end (a refused vote every %is; 0: none until the page clears)',
    async (every) => {
      live.config = HOUR3;
      seedFullHour();
      const first = (await show())!;
      let accepted: number | null = null;
      for (let t = 0; t < 40 * 60 && accepted === null; t++) {
        setNow(T0 + t * 1000);
        if (every ? t % every === 0 : t >= 21 * 60 && (await show()) === null) {
          if ('success' in (await submit())) accepted = clock.ms;
        }
      }
      expect(accepted).not.toBeNull();
      expect(accepted!).toBeLessThanOrEqual(first + SLACK + 1000);
    }
  );

  it('resumes after a minute-window cooldown', async () => {
    live.config = { perMinute: 2, perHour: 600, perDay: 3000 };
    for (let i = 0; i < 2; i++) expect(await submit()).toEqual({ success: true });
    const end = endOf(await submit())!;
    expect(end).toBe(T0 + 10 * MIN);
    setNow(end - 1000);
    expect(endOf(await submit())).toBeLessThanOrEqual(end);
    setNow(end + 1000);
    expect(await submit()).toEqual({ success: true });
  });

  it('never paces a moderator, and writes nothing to Redis for one', async () => {
    live.config = { perMinute: 1, perHour: 1, perDay: 1 };
    for (let i = 0; i < 10; i++) {
      expect(await submit({ isModerator: true })).toEqual({ success: true });
    }
    expect(store.values.size).toBe(0);
  });
});
