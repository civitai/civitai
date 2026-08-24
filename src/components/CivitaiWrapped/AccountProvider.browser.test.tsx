import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { AccountProvider, useAccountContext } from '~/components/CivitaiWrapped/AccountProvider';
import { SessionProvider, useSession } from '~/providers/SessionProvider';
import type { Session } from '~/types/session';

/**
 * ACCOUNT-SWITCHER ROSTER vs. A PROFILE-PICTURE CHANGE.
 *
 * 🔴 THE DEFECT THIS SUITE EXISTS FOR. The roster-upsert effect copies the session user's `image` into the
 * durable `civitai-account-roster` entry, but its dep array was `[currentUserId, deviceAccounts]` — and
 * NEITHER of those changes when a user updates their profile picture. The session refetches in place (same
 * user id), and the device-account query sits inside its 60s staleTime, so the effect never re-ran and the
 * roster kept serving the PREVIOUS avatar url. Changing a profile picture hard-deletes the previous image,
 * so the switcher then requests a url whose object is gone.
 *
 * This suite drives the REAL path: the real `SessionProvider` re-fetching `/api/auth/session` (which is what
 * the server-side session refresh triggers on the client), the real `AccountProvider`, the real
 * `useLocalStorage` roster and the real device-account query. Only `fetch` — the network boundary — is
 * stubbed.
 *
 * The load-bearing control is `accountFetches`: it proves the roster moved because the SESSION value moved,
 * not because the device-account query happened to refetch and mint a new `deviceAccounts` object. Without
 * it a green result would be indistinguishable from the pre-fix behaviour getting lucky.
 */

const USER_ID = 4242;
const ROSTER_KEY = 'civitai-account-roster';
const LEGACY_ACCOUNTS_KEY = 'civitai-accounts';
// Synthetic fixtures — never a real avatar url.
const OLD_AVATAR = 'roster-test-old-avatar.png';
const NEW_AVATAR = 'roster-test-new-avatar.png';
const USERNAME = 'roster-test-user';

type RosterEntry = { id: number; username: string; avatarUrl?: string };

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

/** The server-side session value, swapped mid-test to model a profile-picture change. */
let currentAvatar: string | undefined;
let accountFetches = 0;
let probeRenders = 0;
/** Captured from the probe so the test can drive a session refetch without a synthetic DOM event. */
let sessionUpdate: (() => Promise<unknown>) | null = null;

function Probe() {
  const { update } = useSession();
  const { accounts } = useAccountContext();
  sessionUpdate = update;
  probeRenders++;
  const entry = accounts[String(USER_ID)];
  // Mirror what UserMenu reads off the context for a switcher row.
  return <div data-testid="probe" data-avatar={entry?.avatarUrl ?? ''} />;
}

const probeAvatar = () =>
  document.querySelector('[data-testid="probe"]')?.getAttribute('data-avatar') ?? null;

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
  currentAvatar = OLD_AVATAR;
  accountFetches = 0;
  probeRenders = 0;
  sessionUpdate = null;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
          ? input.href
          : String((input as Request)?.url ?? input);
      if (url.includes('/api/auth/session')) return jsonOk(sessionWith(currentAvatar));
      if (url.includes('/api/auth/accounts')) {
        accountFetches++;
        // No seamlessly-switchable siblings — keeps `deviceAccounts` out of the picture entirely.
        return jsonOk({ accounts: [] });
      }
      throw new Error(`unexpected fetch in AccountProvider test: ${url}`);
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.removeItem(ROSTER_KEY);
  window.localStorage.removeItem(LEGACY_ACCOUNTS_KEY);
});

describe('AccountProvider roster — session avatar changes', () => {
  test('🔴 a new avatar reaches the roster while currentUserId and deviceAccounts stay put', async () => {
    renderProvider(sessionWith(OLD_AVATAR));

    await vi.waitFor(() => {
      expect(readRoster()[String(USER_ID)]?.avatarUrl).toBe(OLD_AVATAR);
      expect(probeAvatar()).toBe(OLD_AVATAR);
    });
    const accountFetchesAfterMount = accountFetches;
    expect(accountFetchesAfterMount).toBeGreaterThan(0); // positive control: the query really ran

    // The user changes their profile picture. Server-side the session is re-shaped and the client pulls the
    // fresh copy in place — same user id, and the device-account query is still inside its staleTime.
    currentAvatar = NEW_AVATAR;
    await sessionUpdate?.();

    await vi.waitFor(() => {
      expect(probeAvatar()).toBe(NEW_AVATAR);
    });
    expect(readRoster()[String(USER_ID)]?.avatarUrl).toBe(NEW_AVATAR);
    // 🔴 The control. Had `deviceAccounts` refetched, a NEW object identity would have re-run the effect and
    // the pre-fix code would have passed this test for the wrong reason.
    expect(accountFetches).toBe(accountFetchesAfterMount);
  });

  test('REMOVING the profile picture clears the roster avatar (no stale-value fallback)', async () => {
    renderProvider(sessionWith(OLD_AVATAR));

    await vi.waitFor(() => {
      expect(readRoster()[String(USER_ID)]?.avatarUrl).toBe(OLD_AVATAR);
    });
    const accountFetchesAfterMount = accountFetches;

    currentAvatar = undefined;
    await sessionUpdate?.();

    await vi.waitFor(() => {
      expect(probeAvatar()).toBe('');
    });
    expect(readRoster()[String(USER_ID)]?.avatarUrl).toBeUndefined();
    // Identity is still remembered — only the avatar was cleared.
    expect(readRoster()[String(USER_ID)]?.username).toBe(USERNAME);
    expect(accountFetches).toBe(accountFetchesAfterMount);
  });

  test('the effect settles — a widened dep list does not loop', async () => {
    renderProvider(sessionWith(OLD_AVATAR));
    await vi.waitFor(() => {
      expect(readRoster()[String(USER_ID)]?.avatarUrl).toBe(OLD_AVATAR);
    });

    currentAvatar = NEW_AVATAR;
    await sessionUpdate?.();
    await vi.waitFor(() => {
      expect(probeAvatar()).toBe(NEW_AVATAR);
    });

    // Quiescence: an unbounded re-render loop keeps committing after the value has settled.
    const settled = probeRenders;
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(probeRenders).toBe(settled);
    // And the whole mount + one avatar change costs a bounded number of commits, not dozens.
    expect(settled).toBeLessThan(25);
  });
});
