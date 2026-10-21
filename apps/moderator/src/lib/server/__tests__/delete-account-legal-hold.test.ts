import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteButtonState, deleteButtonView, type DeleteHold } from '$lib/legal-hold';

/**
 * The spoke's read of a legal hold, which disables Delete account. Only an explicit `held: false`
 * from the main app enables it; `held: true` is a hold, and every other answer is unknown.
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

const { deleteAccountHold } = await import('../user-actions.service');

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

describe('deleteAccountHold', () => {
  it('is clear only on an explicit held: false, read from the hold endpoint', async () => {
    respond = () => json({ userId: TARGET, held: false });
    expect(await deleteAccountHold(TARGET)).toBe('clear');
    expect(urls).toEqual([`https://civitai.com/api/mod/user/legal-hold?userId=${TARGET}`]);
  });

  it('is held on held: true', async () => {
    respond = () => json({ userId: TARGET, held: true });
    expect(await deleteAccountHold(TARGET)).toBe('held');
  });

  it.each([
    ['a status that could not be read', () => json({ userId: TARGET, held: null })],
    ['an answer without the field', () => json({ userId: TARGET })],
    ['a non-boolean', () => json({ userId: TARGET, held: 'false' })],
    ['a refusal', () => json({ message: 'nope' }, 403)],
    ['a server error', () => json({ message: 'boom' }, 500)],
    ['no answer', () => Promise.reject(new TypeError('fetch failed'))],
  ])('reads %s as unknown', async (_, response) => {
    respond = response;
    expect(await deleteAccountHold(TARGET)).toBe('unknown');
  });
});

describe('deleteButtonState', () => {
  const state = (hold: DeleteHold | null) =>
    deleteButtonState({ canDelete: true, deleted: false, hold });

  it('disables, never removes, the button unless the account is clear', () => {
    expect(state('held')).toBe('held');
    expect(state('unknown')).toBe('unknown');
    expect(state(null)).toBe('unknown');
    expect(state('clear')).toBe('enabled');
  });

  it('shows nothing to someone without the permission, or for an account already deleted', () => {
    expect(deleteButtonState({ canDelete: false, deleted: false, hold: 'held' })).toBe('absent');
    expect(deleteButtonState({ canDelete: true, deleted: true, hold: 'clear' })).toBe('absent');
  });
});

describe('deleteButtonView', () => {
  it('lets only an enabled button be pressed, and names a hold apart from a failed check', () => {
    expect(deleteButtonView('absent')).toBeNull();
    expect(deleteButtonView('enabled')).toEqual({ label: 'Delete account', disabled: false });
    expect(deleteButtonView('held')).toEqual({
      label: 'Account under legal hold. Contact Legal.',
      disabled: true,
    });
    expect(deleteButtonView('unknown')).toEqual({
      label: "Couldn't check legal hold status. Try again.",
      disabled: true,
    });
  });
});
