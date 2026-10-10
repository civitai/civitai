import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MarkWatchDeps, WatchRedis } from '~/server/events/points/watch';

const {
  markWatched,
  readWatched,
  MAX_TOPICS_PER_MARK,
  MAX_WATCHED_PER_EVENT,
  TEAMS_WATCH,
  WATCH_TTL_MS,
} = await import('~/server/events/points/watch');
const { eventPointKeys, previewTopicId } = await import('~/server/events/points/keys');

// A sorted set with real ZADD / ZMSCORE / ZCARD / ZREMRANGEBYSCORE semantics, and a log of writes.
function fakeZset() {
  const sets = new Map<string, Map<string, number>>();
  const writes: string[] = [];
  const expiries = new Map<string, number>();
  const set = (key: string) => {
    let s = sets.get(key);
    if (!s) sets.set(key, (s = new Map()));
    return s;
  };
  const redis = {
    async zRemRangeByScore(key: string, _min: string, max: number) {
      let n = 0;
      for (const [m, score] of set(key)) if (score <= max) set(key).delete(m), n++;
      return n;
    },
    async zCard(key: string) {
      return set(key).size;
    },
    async zmScore(key: string, members: string[]) {
      return members.map((m) => set(key).get(m) ?? null);
    },
    async zAdd(key: string, entries: { score: number; value: string }[]) {
      for (const { score, value } of entries) set(key).set(value, score);
      writes.push(...entries.map((e) => e.value));
      return entries.length;
    },
    async pExpireAt(key: string, at: number) {
      expiries.set(key, at);
      return 1;
    },
  };
  return { redis: redis as unknown as WatchRedis, sets, writes, expiries, set };
}

const NOW = new Date('2026-11-05T12:00:00.000Z').getTime();
const EVENT = {
  name: 'birthday2026',
  previewFrom: new Date('2026-10-20T00:00:00.000Z'),
  startDate: new Date('2026-11-01T00:00:00.000Z'),
  endDate: new Date('2026-12-01T00:00:00.000Z'),
  finalizeAfterMs: 24 * 60 * 60 * 1000,
};
const KEY = eventPointKeys(EVENT.name).watch;
const hatId = (n: number) => n.toString(16).padStart(16, '0');
const KNOWN = new Set([hatId(1), hatId(2), hatId(3)]);
// The preview's ids, as keys.ts makes them for hats 1 and 2, and for the team totals.
const previewHatId = (n: number) => previewTopicId(EVENT.name, `${n}:1:claim`);
const KNOWN_PREVIEW = new Set([previewHatId(1), previewHatId(2)]);
const PREVIEW_TEAMS = previewTopicId(EVENT.name, TEAMS_WATCH);
const PREVIEW_NOW = new Date('2026-10-25T12:00:00.000Z').getTime();

let fake: ReturnType<typeof fakeZset>;
let now: number;
let enabled: boolean;
let previewer: boolean;
function deps(overrides: Partial<MarkWatchDeps> = {}): MarkWatchDeps {
  return {
    redis: fake.redis,
    now: () => now,
    isEnabled: async () => enabled,
    getEvent: async (name) => (name === EVENT.name ? EVENT : undefined),
    isKnownHatTopic: async (_e, id, season) => (season === 'live' ? KNOWN : KNOWN_PREVIEW).has(id),
    canWatchPreview: async () => previewer,
    ...overrides,
  };
}
const mark = (topics: string[], d = deps()) => markWatched({ event: EVENT.name, topics }, d);

beforeEach(() => {
  fake = fakeZset();
  now = NOW;
  enabled = true;
  previewer = false;
});

describe('markWatched', () => {
  it('marks known hats and the teams topic until WATCH_TTL_MS from now', async () => {
    expect(await mark([hatId(1), TEAMS_WATCH])).toBe(2);
    expect([...fake.set(KEY)]).toEqual([
      [hatId(1), NOW + WATCH_TTL_MS],
      [TEAMS_WATCH, NOW + WATCH_TTL_MS],
    ]);
    // The set goes once the event's pushes are over.
    expect(fake.expiries.get(KEY)).toBe(
      EVENT.endDate.getTime() + EVENT.finalizeAfterMs + WATCH_TTL_MS
    );
  });

  it('writes nothing for malformed or unknown topic ids', async () => {
    const malformed = ['', 'teams2', '000000000000000A', `${hatId(1)}0`, 'x'.repeat(16)];
    expect(await mark([...malformed, hatId(99)])).toBe(0);
    expect(fake.writes).toEqual([]);
    // Valid ones beside them still go in.
    expect(await mark([...malformed, hatId(2)])).toBe(1);
    expect(fake.writes).toEqual([hatId(2)]);
  });

  it('refuses a malformed id on its shape, without asking the hat map', async () => {
    const isKnownHatTopic = vi.fn(async () => true);
    const malformed = ['', 'teams2', '000000000000000A', `${hatId(1)}0`, 'x'.repeat(16)];
    expect(await mark(malformed, deps({ isKnownHatTopic }))).toBe(0);
    expect(isKnownHatTopic).not.toHaveBeenCalled();
    expect(fake.writes).toEqual([]);
    // The control: a well-formed id is asked about, and marked.
    expect(await mark([hatId(7)], deps({ isKnownHatTopic }))).toBe(1);
    expect(isKnownHatTopic).toHaveBeenCalledWith(EVENT.name, hatId(7), 'live');
  });

  it('writes nothing with the engine switched off', async () => {
    enabled = false;
    expect(await mark([hatId(1), TEAMS_WATCH])).toBe(0);
    expect(fake.writes).toEqual([]);
    expect(fake.sets.size).toBe(0);
  });

  it('writes nothing before the start for a caller the preview does not let in, after scoring finalizes, or for no event', async () => {
    now = EVENT.startDate.getTime() - 1;
    expect(await mark([TEAMS_WATCH])).toBe(0);
    expect(await mark([PREVIEW_TEAMS])).toBe(0);
    now = EVENT.endDate.getTime() + EVENT.finalizeAfterMs + 1;
    expect(await mark([TEAMS_WATCH])).toBe(0);
    now = NOW;
    expect(await markWatched({ event: 'nope', topics: [TEAMS_WATCH] }, deps())).toBe(0);
    expect(fake.writes).toEqual([]);
    // The control: inside the window it writes.
    expect(await mark([TEAMS_WATCH])).toBe(1);
  });

  it(`takes at most ${MAX_TOPICS_PER_MARK} topics a call`, async () => {
    const isKnownHatTopic = vi.fn(async () => true);
    const many = Array.from({ length: MAX_TOPICS_PER_MARK + 10 }, (_, i) => hatId(i + 1));
    expect(await mark(many, deps({ isKnownHatTopic }))).toBe(MAX_TOPICS_PER_MARK);
    expect(fake.set(KEY).size).toBe(MAX_TOPICS_PER_MARK);
  });

  it(`refuses new topics at ${MAX_WATCHED_PER_EVENT}, but still refreshes marked ones`, async () => {
    for (let i = 0; i < MAX_WATCHED_PER_EVENT - 1; i++) fake.set(KEY).set(`m${i}`, NOW + 60_000);
    // One slot left: the first new topic takes it, the second is refused.
    expect(await mark([hatId(1), hatId(2)])).toBe(1);
    expect(fake.set(KEY).has(hatId(1))).toBe(true);
    expect(fake.set(KEY).has(hatId(2))).toBe(false);
    // Full: a marked topic still refreshes, a new one is refused.
    now += 10_000;
    expect(await mark([hatId(1), hatId(3)])).toBe(1);
    expect(fake.set(KEY).get(hatId(1))).toBe(now + WATCH_TTL_MS);
    expect(fake.set(KEY).has(hatId(3))).toBe(false);
  });

  it('always has room for the team totals, and reports what the cap refused', async () => {
    const logCapReached = vi.fn();
    for (let i = 0; i < MAX_WATCHED_PER_EVENT; i++) fake.set(KEY).set(`m${i}`, NOW + 60_000);
    expect(await mark([hatId(1), TEAMS_WATCH], deps({ logCapReached }))).toBe(1);
    expect(fake.set(KEY).get(TEAMS_WATCH)).toBe(NOW + WATCH_TTL_MS);
    expect(fake.set(KEY).has(hatId(1))).toBe(false);
    expect(logCapReached).toHaveBeenCalledWith(EVENT.name, 1);
  });

  it('marks exactly at the start and at the end of finalization', async () => {
    now = EVENT.startDate.getTime();
    expect(await mark([TEAMS_WATCH])).toBe(1);
    now = EVENT.endDate.getTime() + EVENT.finalizeAfterMs;
    expect(await mark([TEAMS_WATCH])).toBe(1);
  });

  it('treats a switch that cannot be read as off', async () => {
    const isEnabled = vi.fn(() => Promise.reject(new Error('flipt down')));
    expect(await mark([TEAMS_WATCH], deps({ isEnabled }))).toBe(0);
    expect(fake.writes).toEqual([]);
  });

  it('trims lapsed marks before counting, so they free room', async () => {
    for (let i = 0; i < MAX_WATCHED_PER_EVENT; i++) fake.set(KEY).set(`m${i}`, NOW - 1);
    expect(await mark([hatId(1)])).toBe(1);
    expect(fake.set(KEY).size).toBe(1);
  });
});

describe('markWatched in the preview', () => {
  beforeEach(() => {
    now = PREVIEW_NOW;
  });

  // The threat: a public client guessing preview ids, or probing which ones exist.
  it('gives a caller it does not let in the same 0 for a real id as for a guess, and asks nothing', async () => {
    const isKnownHatTopic = vi.fn(async () => true);
    const canWatchPreview = vi.fn(async () => previewer);
    const d = deps({ isKnownHatTopic, canWatchPreview });
    const guess = 'ab'.repeat(16);
    expect(await mark([previewHatId(1)], d)).toBe(0);
    expect(await mark([guess], d)).toBe(0);
    expect(await mark([PREVIEW_TEAMS], d)).toBe(0);
    expect(await mark([TEAMS_WATCH, hatId(1)], d)).toBe(0);
    expect(isKnownHatTopic).not.toHaveBeenCalled();
    expect(canWatchPreview).toHaveBeenCalledWith(EVENT.name);
    expect(fake.writes).toEqual([]);
    expect(fake.sets.size).toBe(0);
    // The control: let in, the same call marks.
    previewer = true;
    expect(await mark([PREVIEW_TEAMS], d)).toBe(1);
  });

  it("marks a previewer's keyed ids, and refuses live ones and unknown keyed ones", async () => {
    previewer = true;
    const unknown = 'cd'.repeat(16);
    const topics = [PREVIEW_TEAMS, previewHatId(1), TEAMS_WATCH, hatId(1), unknown];
    expect(await mark(topics)).toBe(2);
    expect(fake.writes).toEqual([PREVIEW_TEAMS, previewHatId(1)]);
    expect(fake.set(KEY).get(previewHatId(1))).toBe(PREVIEW_NOW + WATCH_TTL_MS);
  });

  it('asks the hat map in the preview naming', async () => {
    previewer = true;
    const isKnownHatTopic = vi.fn(async () => true);
    expect(await mark([previewHatId(2)], deps({ isKnownHatTopic }))).toBe(1);
    expect(isKnownHatTopic).toHaveBeenCalledWith(EVENT.name, previewHatId(2), 'preview');
  });

  it('writes nothing before the preview opens, even for a previewer', async () => {
    previewer = true;
    now = EVENT.previewFrom.getTime() - 1;
    expect(await mark([PREVIEW_TEAMS])).toBe(0);
    now = EVENT.previewFrom.getTime();
    expect(await mark([PREVIEW_TEAMS])).toBe(1);
  });

  it('treats an access check that fails as no access', async () => {
    const canWatchPreview = vi.fn(() => Promise.reject(new Error('flipt down')));
    expect(await mark([PREVIEW_TEAMS], deps({ canWatchPreview }))).toBe(0);
    expect(fake.writes).toEqual([]);
  });

  it('always has room for the keyed team totals', async () => {
    previewer = true;
    for (let i = 0; i < MAX_WATCHED_PER_EVENT; i++) fake.set(KEY).set(`m${i}`, now + 60_000);
    expect(await mark([previewHatId(1), PREVIEW_TEAMS])).toBe(1);
    expect(fake.set(KEY).has(PREVIEW_TEAMS)).toBe(true);
  });

  it('once live, refuses keyed ids and never asks about access', async () => {
    now = NOW;
    previewer = true;
    const canWatchPreview = vi.fn(async () => true);
    expect(await mark([previewHatId(1), PREVIEW_TEAMS], deps({ canWatchPreview }))).toBe(0);
    expect(canWatchPreview).not.toHaveBeenCalled();
    expect(await mark([TEAMS_WATCH], deps({ canWatchPreview }))).toBe(1);
  });
});

describe('readWatched', () => {
  it('names the topics with a live mark: not unmarked ones, not lapsed ones', async () => {
    fake.set(KEY).set(hatId(1), NOW + 1);
    fake.set(KEY).set(hatId(2), NOW);
    fake.set(KEY).set(TEAMS_WATCH, NOW + 5);
    const watched = await readWatched(
      EVENT.name,
      [hatId(1), hatId(2), hatId(3), TEAMS_WATCH],
      NOW,
      fake.redis
    );
    expect([...watched]).toEqual([hatId(1), TEAMS_WATCH]);
  });
});
