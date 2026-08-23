import { useQueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { AccountProvider, useAccountContext } from '~/components/CivitaiWrapped/AccountProvider';
import { SessionProvider } from '~/providers/SessionProvider';
import type { Session } from '~/types/session';

/**
 * ACCOUNT-SWITCHER ROSTER vs. THE HUB DEVICE SET (issue #4265).
 *
 * 🔴 THE DEFECT THIS SUITE EXISTS FOR. The roster-upsert effect upserts the SESSION user first and then loops
 * over `deviceAccounts`, but `upsert` compares each candidate against `prev` — the state the effect started
 * from — not against the `next` accumulator it is building. So when both branches touch the SAME id (the
 * signed-in user is also linked on this device) the loop, running second, wins regardless of which value is
 * fresher. The hub device set is a cache: right after a profile-picture change it can still be serving the
 * PREVIOUS avatar url, and changing a picture hard-deletes the old image, so the loop restores a url that
 * 404s. The fix makes the session authoritative for its own id and skips that id in the loop.
 *
 * This path is structurally invisible to `AccountProvider.browser.test.tsx`'s fixture, which uses
 * `accounts: []` — the dominant production shape. Everything here needs a NON-EMPTY device set that
 * CONTAINS the current user, which is why it lives in its own file.
 *
 * The load-bearing control in every case is `SIBLING_ID`: asserting that a second, non-current device account
 * DID reach the roster proves the device payload actually landed and the loop still runs. Without it, "the
 * avatar stayed fresh" would be indistinguishable from the device query never having resolved at all.
 */

const USER_ID = 4242;
const SIBLING_ID = 777;
const ROSTER_KEY = 'civitai-account-roster';
const LEGACY_ACCOUNTS_KEY = 'civitai-accounts';
// Synthetic fixtures — never a real avatar url.
const STALE_AVATAR = 'device-roster-test-stale-avatar.png';
const FRESH_AVATAR = 'device-roster-test-fresh-avatar.png';
const USERNAME = 'device-roster-test-user';
const SIBLING_USERNAME = 'device-roster-test-sibling';

type RosterEntry = { id: number; username: string; avatarUrl?: string };
type DeviceRow = { userId: number; username?: string; image?: string };

function sessionWith(image: string | undefined): Session {
  return {
    user: {
      id: USER_ID,
      username: USERNAME,
      image,
      showNsfw: false,
      blurNsfw: false,
      browsingLevel: 1,
      onboarding: 0,
    },
    expires: '2999-01-01T00:00:00.000Z',
  };
}

const jsonOk = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body } as unknown as Response);

/** What the durable roster actually holds in localStorage — the thing the switcher rows render from. */
function readRoster(): Record<string, RosterEntry> {
  const raw = window.localStorage.getItem(ROSTER_KEY);
  return raw ? (JSON.parse(raw) as Record<string, RosterEntry>) : {};
}

/** The hub device-set payload, swapped mid-test to model the cache moving while the avatar stays stale. */
let deviceRows: DeviceRow[] = [];
let accountFetches = 0;
let probeRenders = 0;
/** Captured from the probe so a test can force the device query to refetch past its 60s staleTime. */
let invalidateAccounts: (() => Promise<unknown>) | null = null;

function Probe() {
  const queryClient = useQueryClient();
  const { accounts } = useAccountContext();
  invalidateAccounts = () => queryClient.invalidateQueries({ queryKey: ['device-accounts'] });
  probeRenders++;
  const entry = accounts[String(USER_ID)];
  // Mirror what UserMenu reads off the context for a switcher row.
  return (
    <div
      data-testid="probe"
      data-avatar={entry?.avatarUrl ?? ''}
      data-sibling={accounts[String(SIBLING_ID)]?.username ?? ''}
    />
  );
}

const probeAttr = (name: 'avatar' | 'sibling') =>
  document.querySelector('[data-testid="probe"]')?.getAttribute(`data-${name}`) ?? null;

function renderProvider(initial: Session) {
  return renderWithProviders(
    <SessionProvider session={initial} refetchOnWindowFocus={false}>
      <AccountProvider>
        <Probe />
      </AccountProvider>
    </SessionProvider>
  );
}

beforeEach(() => {
  window.localStorage.removeItem(ROSTER_KEY);
  window.localStorage.removeItem(LEGACY_ACCOUNTS_KEY);
  accountFetches = 0;
  probeRenders = 0;
  invalidateAccounts = null;
  // The hub still reports the PREVIOUS avatar for the current user — the read-after-write window.
  deviceRows = [
    { userId: USER_ID, username: USERNAME, image: STALE_AVATAR },
    { userId: SIBLING_ID, username: SIBLING_USERNAME, image: undefined },
  ];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
          ? input.href
          : String((input as Request)?.url ?? input);
      // The session is seeded and never refetched here — the device set is the moving part.
      if (url.includes('/api/auth/session')) return jsonOk(sessionWith(FRESH_AVATAR));
      if (url.includes('/api/auth/accounts')) {
        accountFetches++;
        return jsonOk({ accounts: deviceRows });
      }
      throw new Error(`unexpected fetch in AccountProvider device-roster test: ${url}`);
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.removeItem(ROSTER_KEY);
  window.localStorage.removeItem(LEGACY_ACCOUNTS_KEY);
});

describe('AccountProvider roster — the device set must not clobber the current user', () => {
  test('🔴 a stale device-set avatar does not overwrite the session avatar on first load', async () => {
    // Empty roster: the session branch seeds the entry with the FRESH avatar on the first effect pass, then
    // the device query resolves and the loop runs over the same id with the hub's STALE copy.
    renderProvider(sessionWith(FRESH_AVATAR));

    // Positive control FIRST: wait for the device payload to have landed, so the assertion below is taken
    // AFTER the moment the loop would have clobbered — not before it.
    await vi.waitFor(() => {
      expect(readRoster()[String(SIBLING_ID)]?.username).toBe(SIBLING_USERNAME);
    });
    expect(accountFetches).toBeGreaterThan(0);

    expect(readRoster()[String(USER_ID)]?.avatarUrl).toBe(FRESH_AVATAR);
    expect(probeAttr('avatar')).toBe(FRESH_AVATAR);
  });

  test('🔴 a device payload whose identity moves while the avatar stays stale does not regress a corrected entry', async () => {
    // Start from an ALREADY-correct roster, so the only thing that can move the avatar is the device loop.
    window.localStorage.setItem(
      ROSTER_KEY,
      JSON.stringify({
        [String(USER_ID)]: { id: USER_ID, username: USERNAME, avatarUrl: FRESH_AVATAR },
      })
    );
    renderProvider(sessionWith(FRESH_AVATAR));

    await vi.waitFor(() => {
      expect(readRoster()[String(SIBLING_ID)]?.username).toBe(SIBLING_USERNAME);
    });
    expect(readRoster()[String(USER_ID)]?.avatarUrl).toBe(FRESH_AVATAR);

    // The hub payload changes — a sibling's username updates — while the current user's avatar is STILL the
    // deleted one. A deeply-equal payload would keep its reference (react-query structural sharing) and the
    // effect would not re-run at all; moving a field is what makes the identity change and the effect fire.
    const movedSiblingUsername = `${SIBLING_USERNAME}-renamed`;
    deviceRows = [
      { userId: USER_ID, username: USERNAME, image: STALE_AVATAR },
      { userId: SIBLING_ID, username: movedSiblingUsername, image: undefined },
    ];
    await invalidateAccounts?.();

    await vi.waitFor(() => {
      expect(readRoster()[String(SIBLING_ID)]?.username).toBe(movedSiblingUsername);
    });
    expect(readRoster()[String(USER_ID)]?.avatarUrl).toBe(FRESH_AVATAR);
    expect(probeAttr('avatar')).toBe(FRESH_AVATAR);
  });

  // Scoped to the DEVICE-LOOP vector on purpose: the roster is seeded with NO avatar, which neuters the
  // loop's `?? prev[id]?.avatarUrl` fallback, leaving the hub's own `a.avatarUrl` (STALE_AVATAR) as the only
  // thing that could put a deleted picture back — exactly what the `continue` on `sessionOwnedId` stops.
  // There is no session-branch avatar fallback left to exercise: #4260 removed its `?? prev`, and this change
  // deliberately adds no device-set one, so `session.user.image` is now the sole source for the current
  // user's roster avatar. (The username still falls back; the avatar does not.)
  test('🔴 the device set cannot resurrect an avatar the user removed', async () => {
    window.localStorage.setItem(
      ROSTER_KEY,
      JSON.stringify({
        [String(USER_ID)]: { id: USER_ID, username: USERNAME, avatarUrl: undefined },
      })
    );
    // The session says: no profile picture. The hub still has the old one.
    renderProvider(sessionWith(undefined));

    await vi.waitFor(() => {
      expect(readRoster()[String(SIBLING_ID)]?.username).toBe(SIBLING_USERNAME);
    });
    expect(readRoster()[String(USER_ID)]?.avatarUrl).toBeUndefined();
    expect(probeAttr('avatar')).toBe('');
  });

  // INVARIANT GUARD, not regression coverage — this one passes before the fix too. It exists so that skipping
  // an id in the loop can't quietly disable the loop, and so the `changed` bail-out (which is what keeps this
  // effect from re-rendering forever) stays intact.
  test('a non-current device account is still upserted, and the effect settles', async () => {
    renderProvider(sessionWith(FRESH_AVATAR));

    await vi.waitFor(() => {
      expect(probeAttr('sibling')).toBe(SIBLING_USERNAME);
    });
    // The sibling's identity is remembered in full, not just its key.
    expect(readRoster()[String(SIBLING_ID)]).toEqual({
      id: SIBLING_ID,
      username: SIBLING_USERNAME,
      avatarUrl: undefined,
    });

    // Quiescence: an unbounded re-render loop keeps committing after the value has settled.
    const settled = probeRenders;
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(probeRenders).toBe(settled);
    // And the whole mount costs a bounded number of commits, not dozens.
    expect(settled).toBeLessThan(25);
  });
});
