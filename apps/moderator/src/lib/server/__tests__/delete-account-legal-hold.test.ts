import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteButtonState } from '$lib/legal-hold';

/**
 * The spoke's read of a legal hold, which disables Delete account. Only an explicit `held: false`
 * from the main app enables it; every other answer, and no answer, reads as held.
 */

vi.mock('$lib/server/db', async () => {
  const { capturingDb } = await import('../../../test/capture-sql');
  return { dbRead: capturingDb([], []), dbWrite: capturingDb([], []) };
});
vi.mock('$env/dynamic/private', () => ({
  env: { CIVITAI_APP_URL: 'https://civitai.com', WEBHOOK_TOKEN: 'shared-secret' },
}));
vi.mock('$app/server', () => ({
  getRequestEvent: () => ({
    locals: {},
    request: { headers: new Headers({ cookie: 'civ-token=the-moderators-session' }) },
  }),
}));

const { deleteAccountHeld } = await import('../user-actions.service');

const TARGET = 8675309;
let urls: string[];
let respond: () => Response | Promise<Response>;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  vi.unstubAllGlobals();
  urls = [];
  vi.stubGlobal('fetch', (url: string) => {
    urls.push(String(url));
    return Promise.resolve(respond());
  });
});

describe('deleteAccountHeld', () => {
  it('is clear only on an explicit held: false, read from the hold endpoint', async () => {
    respond = () => json({ userId: TARGET, held: false });
    expect(await deleteAccountHeld(TARGET)).toBe(false);
    expect(urls).toEqual([`https://civitai.com/api/mod/user/legal-hold?userId=${TARGET}`]);
  });

  it.each([
    ['held', () => json({ userId: TARGET, held: true })],
    ['an answer without the field', () => json({ userId: TARGET })],
    ['a non-boolean', () => json({ userId: TARGET, held: 'false' })],
    ['a refusal', () => json({ message: 'nope' }, 403)],
    ['a server error', () => json({ message: 'boom' }, 500)],
    ['no answer', () => Promise.reject(new TypeError('fetch failed'))],
  ])('reads %s as held', async (_, response) => {
    respond = response;
    expect(await deleteAccountHeld(TARGET)).toBe(true);
  });
});

describe('deleteButtonState', () => {
  it('disables, never removes, the button under a hold or an unknown status', () => {
    expect(deleteButtonState({ canDelete: true, deleted: false, held: true })).toBe('held');
    expect(deleteButtonState({ canDelete: true, deleted: false, held: null })).toBe('held');
    expect(deleteButtonState({ canDelete: true, deleted: false, held: false })).toBe('enabled');
  });

  it('shows nothing to someone without the permission, or for an account already deleted', () => {
    expect(deleteButtonState({ canDelete: false, deleted: false, held: true })).toBe('absent');
    expect(deleteButtonState({ canDelete: true, deleted: true, held: false })).toBe('absent');
  });
});
