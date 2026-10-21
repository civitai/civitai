import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deleteButtonState,
  holdButtonView,
  HOLD_UNKNOWN_BUTTON_TEXT,
  HOLD_UNKNOWN_REFUSAL,
  LEGAL_HOLD_BUTTON_TEXT,
  LEGAL_HOLD_REFUSAL,
  LEGAL_HOLD_STOPPED,
} from '$lib/legal-hold';

/**
 * Purge content asks the main app whether the account is held before it sends anything, and reports a
 * purge whose answer was lost as started, never as failed: the wipe keeps running either way, and a
 * "failed" invites a second purge.
 */

const TARGET = 8675309;

vi.mock('$lib/server/db', async () => {
  const { capturingDb } = await import('../../../test/capture-sql');
  // Every lookup finds the account.
  return {
    dbRead: capturingDb([], [{ id: 8675309 }]),
    dbWrite: capturingDb([], [{ id: 8675309 }]),
  };
});
const { recordModActivity } = vi.hoisted(() => ({
  recordModActivity: vi.fn(async (_row: unknown) => undefined),
}));
vi.mock('../mod-activity', () => ({ recordModActivity }));
vi.mock('$env/dynamic/private', () => ({
  env: { CIVITAI_APP_URL: 'https://civitai.com', WEBHOOK_TOKEN: 'shared-secret' },
}));
vi.mock('$app/server', () => ({
  getRequestEvent: () => ({
    locals: {},
    request: { headers: new Headers({ cookie: 'civ-token=the-moderators-session' }) },
  }),
}));

const { purgeAllContent, PURGE_MAY_BE_RUNNING } = await import('../user-actions.service');

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let purgeUrls: string[];
let hold: () => Response | Promise<Response>;
let purge: () => Response | Promise<Response>;

beforeEach(() => {
  vi.unstubAllGlobals();
  recordModActivity.mockClear();
  purgeUrls = [];
  hold = () => json({ userId: TARGET, held: false });
  purge = () => json({ userId: TARGET });
  vi.stubGlobal('fetch', (url: string) => {
    if (String(url).includes('/api/mod/user/legal-hold')) return Promise.resolve(hold());
    purgeUrls.push(String(url));
    return Promise.resolve(purge());
  });
});

const run = () => purgeAllContent({ userId: TARGET, moderatorId: 9 });

describe('purgeAllContent and a legal hold', () => {
  it('purges an account that is clear, naming it in the query the endpoint reads', async () => {
    expect(await run()).toEqual({ ok: true });
    expect(purgeUrls).toEqual([
      `https://civitai.com/api/mod/remove-all-content?token=shared-secret&userId=${TARGET}`,
    ]);
  });

  it('refuses a held account without sending the purge', async () => {
    hold = () => json({ userId: TARGET, held: true });
    expect(await run()).toEqual({ ok: false, error: LEGAL_HOLD_REFUSAL });
    expect(purgeUrls).toEqual([]);
  });

  it.each([
    ['a status that could not be read', () => json({ userId: TARGET, held: null })],
    ['no answer', () => Promise.reject(new TypeError('fetch failed'))],
  ])('refuses when the hold check returns %s', async (_, response) => {
    hold = response;
    expect(await run()).toEqual({ ok: false, error: HOLD_UNKNOWN_REFUSAL });
    expect(purgeUrls).toEqual([]);
  });

  it('shows the hold refusal when the endpoint refuses the purge', async () => {
    purge = () => json({ message: LEGAL_HOLD_REFUSAL }, 403);
    expect(await run()).toEqual({ ok: false, error: LEGAL_HOLD_REFUSAL });
    expect(recordModActivity).not.toHaveBeenCalled();
  });

  it('shows any other 403 as the endpoint wrote it, not as a hold', async () => {
    purge = () => json({ message: 'Forbidden' }, 403);
    expect(await run()).toEqual({ ok: false, error: 'Purge: Forbidden' });
  });

  it('records a purge a hold stopped part-way, and says it stopped', async () => {
    purge = () => json({ message: LEGAL_HOLD_STOPPED }, 409);
    expect(await run()).toEqual({ ok: false, error: LEGAL_HOLD_STOPPED });
    expect(recordModActivity).toHaveBeenCalledWith({
      userId: 9,
      entityType: 'user',
      entityId: TARGET,
      activity: 'purgeAllContent',
    });
  });
});

describe('purgeAllContent with a lost answer', () => {
  it.each([
    ['a gateway timeout', () => json({ message: 'timeout' }, 504)],
    ['a server error', () => json({ message: 'boom' }, 500)],
    ['a request timeout', () => json({ message: 'timeout' }, 408)],
    [
      'our own timeout',
      () => Promise.reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' })),
    ],
  ])('reports %s as a purge that may still be running', async (_, response) => {
    purge = response;
    expect(await run()).toEqual({ ok: false, error: PURGE_MAY_BE_RUNNING });
  });

  it('reports a request that never left as a failure', async () => {
    purge = () =>
      Promise.reject(
        Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
      );
    expect(await run()).toEqual({ ok: false, error: 'Purge failed.' });
  });

  it('passes a refusal the endpoint wrote through to the operator', async () => {
    purge = () => json({ message: 'Invalid userId' }, 400);
    expect(await run()).toEqual({ ok: false, error: 'Purge: Invalid userId' });
  });
});

describe('the Purge content button', () => {
  const view = (hold: 'clear' | 'held' | 'unknown' | null, canPurge = true) =>
    holdButtonView(
      deleteButtonState({ canDelete: canPurge, deleted: false, hold }),
      'Purge content'
    );

  it('is enabled only for an account that is clear', () => {
    expect(view('clear')).toEqual({ label: 'Purge content', disabled: false });
    expect(view('held')).toEqual({ label: LEGAL_HOLD_BUTTON_TEXT, disabled: true });
    expect(view('unknown')).toEqual({ label: HOLD_UNKNOWN_BUTTON_TEXT, disabled: true });
    expect(view(null)).toEqual({ label: HOLD_UNKNOWN_BUTTON_TEXT, disabled: true });
  });

  it('is absent without the permission', () => {
    expect(view('clear', false)).toBeNull();
  });
});
