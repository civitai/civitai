import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `retoolAuditLog` is a replicated table, and replicated inserts drop a block identical to an
 * earlier one. A scheduled caller repeating the same moderator call sent identical rows while
 * `createdAt` was server-filled, so every repeat after the first was accepted and lost. Two
 * identical calls must therefore produce different bodies.
 */

vi.mock('~/env/other', () => ({ isProd: false, isDev: true }));
vi.mock('~/server/auth/get-server-auth-session', () => ({
  getServerAuthSession: vi.fn(async () => null),
}));

import { Tracker } from '../client';

function fetchBodies(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.map((call) => {
    const [, init] = call as [string, { body: string }];
    return init.body;
  });
}

const call = {
  action: 'getFlaggedItems',
  privileged: false,
  outcome: 'ok' as const,
  payload: { limit: '50' },
};

async function emitTwice() {
  const tracker = new Tracker();
  await tracker.retoolAudit(call);
  await new Promise((r) => setImmediate(r));
  // Same-millisecond calls would share a timestamp; advance the clock rather than race it.
  vi.setSystemTime(new Date(Date.now() + 1000));
  await tracker.retoolAudit(call);
  await new Promise((r) => setImmediate(r));
}

describe('Tracker.retoolAudit wire payload', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-01T19:04:20.000Z'));
    fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => '' }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('POSTs to the retoolAuditLog table', async () => {
    await emitTwice();
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toMatch(/\/track\/retoolAuditLog$/);
  });

  it('stamps createdAt as a valid ISO timestamp taken at call time', async () => {
    await emitTwice();
    const first = JSON.parse(fetchBodies(fetchMock)[0]);
    expect(typeof first.createdAt).toBe('string');
    expect(first.createdAt).toBe('2026-11-01T19:04:20.000Z');
    expect(Number.isNaN(Date.parse(first.createdAt))).toBe(false);
  });

  it('two identical calls produce different bodies, so neither is deduplicated', async () => {
    await emitTwice();
    const bodies = fetchBodies(fetchMock);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).not.toBe(bodies[1]);

    // The only difference is the timestamp: everything else is the repeat.
    const [a, b] = bodies.map((s) => JSON.parse(s));
    const { createdAt: ca, ...restA } = a;
    const { createdAt: cb, ...restB } = b;
    expect(restA).toEqual(restB);
    expect(Date.parse(cb) - Date.parse(ca)).toBe(1000);
  });

  it('still carries the audit columns', async () => {
    await emitTwice();
    const body = JSON.parse(fetchBodies(fetchMock)[0]);
    expect(body).toMatchObject({
      action: 'getFlaggedItems',
      privileged: 0,
      outcome: 'ok',
      errorMsg: '',
      payload: '{"limit":"50"}',
      affected: '',
    });
  });
});
