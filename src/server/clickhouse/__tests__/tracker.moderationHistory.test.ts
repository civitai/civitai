import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `userActivities` and `modelEvents` are replicated tables, and replicated inserts drop a block
 * identical to an earlier one. With `time` left for the server to fill, the same action repeated
 * by the same actor on the same target (ban, unban, ban again) sent an identical row, and the
 * repeat was accepted and lost. Two identical calls must therefore produce different bodies.
 */

vi.mock('~/env/other', () => ({ isProd: false, isDev: true }));
vi.mock('~/server/auth/get-server-auth-session', () => ({
  getServerAuthSession: vi.fn(async () => null),
}));

import { Tracker } from '../client';

const T0 = '2026-11-01T19:04:20.000Z';

function bodies(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.map((call) => (call as [string, { body: string }])[1].body);
}

async function flush() {
  await new Promise((r) => setImmediate(r));
}

const cases = [
  {
    table: 'userActivities',
    emit: (t: Tracker, time?: Date) =>
      t.userActivity({ type: 'Banned', targetUserId: 42, ...(time ? { time } : {}) }),
  },
  {
    table: 'modelEvents',
    emit: (t: Tracker, time?: Date) =>
      t.modelEvent({ type: 'Takedown', modelId: 7, nsfw: true, ...(time ? { time } : {}) }),
  },
] as const;

describe.each(cases)('Tracker → $table time stamp', ({ table, emit }) => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(T0));
    fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => '' }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it(`POSTs to ${table}`, async () => {
    await emit(new Tracker());
    await flush();
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toMatch(new RegExp(`/track/${table}$`));
  });

  it('stamps time as a valid ISO timestamp taken at call time', async () => {
    await emit(new Tracker());
    await flush();
    const body = JSON.parse(bodies(fetchMock)[0]);
    expect(body.time).toBe(T0);
    expect(Number.isNaN(Date.parse(body.time))).toBe(false);
  });

  it('two identical calls produce different bodies, differing only in time', async () => {
    const tracker = new Tracker();
    await emit(tracker);
    await flush();
    vi.setSystemTime(new Date(Date.parse(T0) + 1000));
    await emit(tracker);
    await flush();

    const sent = bodies(fetchMock);
    expect(sent).toHaveLength(2);
    expect(sent[0]).not.toBe(sent[1]);
    const [{ time: a, ...restA }, { time: b, ...restB }] = sent.map((s) => JSON.parse(s));
    expect(restA).toEqual(restB);
    expect(Date.parse(b) - Date.parse(a)).toBe(1000);
  });

  it('keeps a time the caller passed instead of overwriting it with now', async () => {
    const given = new Date('2026-10-01T08:00:00.000Z');
    await emit(new Tracker(), given);
    await flush();
    expect(JSON.parse(bodies(fetchMock)[0]).time).toBe(given.toISOString());
  });
});
