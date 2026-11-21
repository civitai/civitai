import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Clearing a user's profile text and removing one of their links go through the main app's
 * `/api/mod/user/clear-profile` and `/api/mod/user/remove-link`, which archive the profile first
 * where a CSAM report or hold names the user, refuse if that archive fails, and write their own
 * ModActivity row. Here: the spoke calls them as the acting moderator, never writes UserProfile or
 * UserLink itself, never adds a second ModActivity row, and keeps its own `/users` access check in
 * front of both.
 */

const recordModActivity = vi.hoisted(() => vi.fn(async () => undefined));
const recordModActivityBatch = vi.hoisted(() => vi.fn(async () => undefined));
const access = vi.hoisted(() => ({ allowed: true }));
const writes = vi.hoisted(() => ({ sql: [] as string[] }));

vi.mock('$lib/server/db', async () => {
  const { capturingDb } = await import('../../../test/capture-sql');
  return { dbRead: capturingDb([], []), dbWrite: capturingDb(writes.sql, []) };
});
vi.mock('../mod-activity', () => ({ recordModActivity, recordModActivityBatch }));
vi.mock('$env/dynamic/private', () => ({
  env: { CIVITAI_APP_URL: 'https://civitai.com', WEBHOOK_TOKEN: 'shared-secret' },
}));
vi.mock('$app/server', () => ({
  getRequestEvent: () => ({
    locals: {},
    request: { headers: new Headers({ cookie: 'civ-token=the-moderators-session' }) },
  }),
}));
vi.mock('../access', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  canAccess: () => access.allowed,
}));

const { clearProfileText, removeSocial } = await import('../user-actions.service');
const { accountEnforcementActions } = await import('../account-actions');
const { actions: lookupActions } = await import(
  '../../../routes/retool/user-lookup/[section]/+page.server'
);

const TARGET = 990100061;
const MOD = 990100062;
const LINK = 990100063;

type Call = { url: string; body: unknown; cookie?: string };
let calls: Call[];
let respond: () => Response;

beforeEach(() => {
  vi.unstubAllGlobals();
  calls = [];
  writes.sql.length = 0;
  access.allowed = true;
  recordModActivity.mockClear();
  respond = () => new Response(JSON.stringify({ updated: true, removed: true }), { status: 200 });
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    calls.push({
      url: String(url),
      body: JSON.parse(String(init.body)),
      cookie: (init.headers as Record<string, string> | undefined)?.cookie,
    });
    return Promise.resolve(respond());
  });
});

const touchedProfileTables = () =>
  writes.sql.filter((s) => /"UserProfile"|"UserLink"/.test(s) && !/^select/i.test(s.trim()));

describe('clearProfileText', () => {
  it('calls clear-profile as the moderator and writes nothing itself', async () => {
    const result = await clearProfileText({
      userId: TARGET,
      fields: ['bio', 'location'],
      moderatorId: MOD,
    });

    expect(result).toEqual({ ok: true });
    expect(calls).toEqual([
      {
        url: 'https://civitai.com/api/mod/user/clear-profile',
        body: { userId: TARGET, fields: ['bio', 'location'] },
        cookie: 'civ-token=the-moderators-session',
      },
    ]);
    expect(touchedProfileTables()).toEqual([]);
    expect(recordModActivity).not.toHaveBeenCalled();
  });

  it('reports a refused archive as a failed clear', async () => {
    respond = () => new Response(JSON.stringify({ error: 'archive failed' }), { status: 500 });
    const result = await clearProfileText({ userId: TARGET, fields: ['bio'], moderatorId: MOD });
    expect(result.ok).toBe(false);
  });

  it('says so when the account has no profile row', async () => {
    respond = () => new Response(JSON.stringify({ updated: false }), { status: 200 });
    const result = await clearProfileText({ userId: TARGET, fields: ['bio'], moderatorId: MOD });
    expect(result).toEqual({ ok: false, error: 'This account has no profile row to edit.' });
  });
});

describe('removeSocial', () => {
  it('calls remove-link as the moderator and writes nothing itself', async () => {
    const result = await removeSocial({ id: LINK, userId: TARGET, moderatorId: MOD });

    expect(result).toEqual({ ok: true });
    expect(calls).toEqual([
      {
        url: 'https://civitai.com/api/mod/user/remove-link',
        body: { userId: TARGET, linkId: LINK },
        cookie: 'civ-token=the-moderators-session',
      },
    ]);
    expect(touchedProfileTables()).toEqual([]);
    expect(recordModActivity).not.toHaveBeenCalled();
  });

  it('says so when the link is not that user’s', async () => {
    respond = () => new Response(JSON.stringify({ removed: false }), { status: 200 });
    const result = await removeSocial({ id: LINK, userId: TARGET, moderatorId: MOD });
    expect(result).toEqual({ ok: false, error: 'That link does not belong to this user.' });
  });
});

describe('the /users access check stays in front of both', () => {
  const event = (fields: Record<string, string | string[]>) => {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields))
      for (const value of [v].flat()) form.append(k, value);
    return {
      request: { formData: async () => form },
      locals: { user: { id: MOD }, grants: {} },
    } as never;
  };

  it('refuses a link removal without /users access, and calls nothing', async () => {
    access.allowed = false;
    const result = await lookupActions.removeSocial(
      event({ userId: String(TARGET), id: String(LINK) })
    );
    expect(result).toMatchObject({ status: 400 });
    expect(calls).toEqual([]);
  });

  it('control: with /users access the link removal reaches remove-link', async () => {
    await lookupActions.removeSocial(event({ userId: String(TARGET), id: String(LINK) }));
    expect(calls.map((c) => c.url)).toEqual(['https://civitai.com/api/mod/user/remove-link']);
  });

  it('refuses a profile clear without /users access, and calls nothing', async () => {
    access.allowed = false;
    const result = await accountEnforcementActions.clearProfileText(
      event({ userId: String(TARGET), fields: ['bio'] })
    );
    expect(result).toMatchObject({ status: 400 });
    expect(calls).toEqual([]);
  });

  it('control: with /users access the profile clear reaches clear-profile', async () => {
    await accountEnforcementActions.clearProfileText(
      event({ userId: String(TARGET), fields: ['bio'] })
    );
    expect(calls.map((c) => c.url)).toEqual(['https://civitai.com/api/mod/user/clear-profile']);
  });
});
