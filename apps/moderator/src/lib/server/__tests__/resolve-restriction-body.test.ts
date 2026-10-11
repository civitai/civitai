import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The body `resolveRestriction` posts to the main app. The endpoint keeps `resolvedReason` optional
 * for older callers and the body is an untyped record, so a reason dropped here is stored as NULL on
 * every mute ruling with nothing else failing: no type error, no 400, no red route test (those mock
 * this module).
 */

vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('../mod-activity', () => ({
  recordModActivity: vi.fn(async () => undefined),
  recordModActivityBatch: vi.fn(async () => undefined),
}));
vi.mock('$env/dynamic/private', () => ({
  env: { CIVITAI_APP_URL: 'https://civitai.com', WEBHOOK_TOKEN: 'shared-secret' },
}));
vi.mock('$app/server', () => ({
  getRequestEvent: () => ({
    locals: {},
    request: { headers: new Headers({ cookie: 'civ-token=the-moderators-session' }) },
  }),
}));

const { resolveRestriction } = await import('../user-actions.service');

let bodies: unknown[];

beforeEach(() => {
  vi.unstubAllGlobals();
  bodies = [];
  vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return Promise.resolve(new Response(JSON.stringify({ resolved: 'Upheld' }), { status: 200 }));
  });
});

const base = { userRestrictionId: 5, userId: 42, moderatorId: 7 } as const;

describe('resolveRestriction — the body sent to /api/mod/restriction/resolve', () => {
  it('carries the reason and the note', async () => {
    await resolveRestriction({
      ...base,
      status: 'Upheld',
      resolvedReason: 'clear-intent',
      internalNotes: 'seen before',
      resolvedMessage: 'Your access stays restricted.',
    });

    expect(bodies).toEqual([
      {
        userRestrictionId: 5,
        status: 'Upheld',
        resolvedReason: 'clear-intent',
        resolvedMessage: 'Your access stays restricted.',
        internalNotes: 'seen before',
      },
    ]);
  });

  it('leaves out a note that was not written', async () => {
    await resolveRestriction({ ...base, status: 'Overturned', resolvedReason: 'word-match' });

    expect(bodies).toEqual([
      { userRestrictionId: 5, status: 'Overturned', resolvedReason: 'word-match' },
    ]);
  });
});
