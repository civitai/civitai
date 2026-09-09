import { useLocalStorage, usePrevious } from '@mantine/hooks';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { authProxy } from '~/utils/auth-proxy';
import { useSession } from '~/providers/SessionProvider';
import { handleSignOut } from '~/utils/auth-helpers';
import { getLoginLink } from '~/utils/login-helpers';
import { useRouter } from 'next/router';
import type { ReactNode } from 'react';
import { createContext, useContext, useEffect, useMemo } from 'react';
import { deleteCookies } from '~/utils/cookies-helpers';

// DEVICE-LEVEL account switching (docs/main-app-auth-cutover.md, section E). Two stores, by design:
//   • ROSTER (localStorage `civitai-account-roster`) — the DURABLE, credential-free list of accounts used on
//     this browser: { id, username, avatarUrl }. This is how the user always sees which accounts they've added,
//     even after a session expires. Holds NO tokens.
//   • HUB DEVICE SET (Redis, 30d rolling) — which of those accounts can be switched to WITHOUT re-login. An
//     account that ages out of this window stays in the roster but, when clicked, re-authenticates at the hub.
// The pre-cutover `civitai-accounts` store (token-per-account) is RETIRED — see purgeLegacyAccountStore.
export type CivitaiAccount = {
  id: number;
  active: boolean;
  username: string;
  avatarUrl?: string;
  email?: string;
  needsLogin?: boolean; // aged out of the seamless-switch window → clicking re-authenticates at the hub
};
type CivitaiAccounts = Record<string, CivitaiAccount>;

// Durable, credential-free display roster.
type RosterEntry = { id: number; username: string; avatarUrl?: string };
type Roster = Record<string, RosterEntry>;
const rosterKey = 'civitai-account-roster';

// RETIRED pre-cutover token-per-account store. Nothing redeems it any more — its seamless redeem went with
// next-auth, so `swapAccount` has honoured the hub device set alone since the cutover (2026-06-22, more than
// three 30-day session lifetimes ago). Leaving it in the `seamless` test only made an entry LOOK switchable
// while clicking it bounced to the hub login: the display/behaviour mismatch behind ClickUp 868kxch09
// report 1. PURGED rather than merely ignored, because it holds per-account tokens that would otherwise sit
// in localStorage indefinitely for credentials nothing can use.
const legacyAccountsKey = 'civitai-accounts';

/** Remove the retired store from this browser. Safe to call on every mount; a no-op once it is gone. */
function purgeLegacyAccountStore() {
  try {
    if (localStorage.getItem(legacyAccountsKey) !== null)
      localStorage.removeItem(legacyAccountsKey);
  } catch {
    // private mode / storage disabled — nothing to clean up that we could reach anyway
  }
}

const accountsQueryKey = ['device-accounts'] as const;
// Stable empty reference for the device-account set — using a `= {}` destructuring default would mint a NEW
// object every render, so any effect depending on it would re-run (and re-setState) forever.
const EMPTY_ROSTER: Roster = {};

const deleteCookieList = ['ref_code', 'ref_source'];

type AccountState = {
  accounts: CivitaiAccounts;
  logout: () => Promise<void>;
  logoutAll: () => Promise<void>;
  // Switch by userId: seamless device switch if fresh in the hub set, else re-authenticate at the hub.
  // (Cross-domain .red goes through the server auth-code flow, not here.)
  swapAccount: (userId: number, callbackUrl?: string) => Promise<void>;
  removeAccount: (id: number) => Promise<void>;
  // Moderator impersonation (F) — start acting as `userId` / return to your own account. Both reload on success
  // and throw with a message on failure (the caller surfaces it). Hub-native: no client-held token, no ogAccount.
  impersonate: (userId: number) => Promise<void>;
  exitImpersonation: () => Promise<void>;
};

const AccountContext = createContext<AccountState | null>(null);

export const useAccountContext = () => {
  const context = useContext(AccountContext);
  if (!context) throw new Error('AccountContext not in tree');
  return context;
};

export const AccountProvider = ({ children }: { children: ReactNode }) => {
  const { data: userData, status } = useSession();
  const previousUserData = usePrevious(userData);
  const router = useRouter();
  const queryClient = useQueryClient();
  const currentUserId = userData?.user?.id;
  // The session-derived values the roster effect below reads, hoisted out as PRIMITIVES on purpose.
  // `userData` itself is a fresh object on every session refetch, so depending on the OBJECT would re-run a
  // state-writing effect on every poll (the `EMPTY_ROSTER` note above is the same hazard, one store over).
  // Depending on the VALUES gets the effect re-run exactly when the data it copies actually changed.
  const hasSessionUser = !!userData?.user;
  const isImpersonating = !!userData?.impersonatedBy;
  const sessionUsername = userData?.user?.username;
  const sessionAvatarUrl = userData?.user?.image;

  // The seamlessly-switchable set (hub device set, 30d rolling). Empty until authenticated. `?? EMPTY_ROSTER`
  // (not a `= {}` default) keeps the reference STABLE across renders so the effects below don't loop.
  const { data: deviceAccountsData } = useQuery<Record<string, RosterEntry>>({
    queryKey: accountsQueryKey,
    enabled: status === 'authenticated',
    staleTime: 60_000,
    queryFn: async () => {
      const rows = await authProxy.listAccounts();
      return Object.fromEntries(
        rows.map((a) => [
          String(a.userId),
          { id: a.userId, username: a.username ?? '', avatarUrl: a.image },
        ])
      );
    },
  });
  const deviceAccounts = deviceAccountsData ?? EMPTY_ROSTER;

  // Durable display roster (no credentials). getInitialValueInEffect:false so it shows on first paint.
  const [roster, setRoster] = useLocalStorage<Roster>({
    key: rosterKey,
    defaultValue: {},
    getInitialValueInEffect: false,
  });
  // Drop the retired store from this browser, once. Deleting only the code that reads it would leave the
  // per-account tokens sitting in localStorage forever.
  useEffect(() => {
    purgeLegacyAccountStore();
  }, []);

  // Remember the current user + every seamlessly-switchable account in the durable roster. Returns the SAME
  // object when nothing changed so setState bails (no re-render / no localStorage churn / no render loop).
  useEffect(() => {
    setRoster((prev) => {
      const next = { ...prev };
      let changed = false;
      const upsert = (id: string, entry: RosterEntry) => {
        const cur = prev[id];
        if (
          !cur ||
          cur.id !== entry.id ||
          cur.username !== entry.username ||
          cur.avatarUrl !== entry.avatarUrl
        ) {
          next[id] = entry;
          changed = true;
        }
      };
      // Which id the SESSION branch owns, if any — computed ONCE, from the hoisted session primitives,
      // because the deviceAccounts loop below has to skip it. NB: `null` while IMPERSONATING — the "current
      // user" is then the impersonated target, not a real account linked on this device, so it must never
      // enter the switcher roster (impersonation also never touches the hub device set, so the loop below
      // won't reintroduce it either way).
      const sessionOwnedId =
        currentUserId && hasSessionUser && !isImpersonating ? String(currentUserId) : null;
      // The `currentUserId` re-test is only there to narrow `number | undefined` for the `id` field below;
      // `sessionOwnedId` is already the authority on whether this branch runs.
      if (sessionOwnedId && currentUserId) {
        upsert(sessionOwnedId, {
          id: currentUserId,
          // Session first; the device set and the remembered roster are only consulted when the session
          // carries no username (`SessionUser.username` is optional). `||` past the first term because the
          // device set stores `''` for an unknown username, and '' is not a username.
          username:
            sessionUsername ??
            (deviceAccounts[sessionOwnedId]?.username || prev[sessionOwnedId]?.username || ''),
          // NO fallback of ANY kind for the avatar here (unlike the username above and the deviceAccounts
          // loop below) — not the remembered roster value, not the device set. In THIS branch the session
          // user is known-present, so its `image` is authoritative: `undefined` means "this user has no
          // profile picture", not "no data". Falling back made removing a profile picture impossible to
          // reflect (the switcher kept rendering the deleted avatar forever), and the device set is a 30-day
          // cache that would happily hand back the deleted url in the read-after-write window.
          avatarUrl: sessionAvatarUrl,
        });
      }
      for (const [id, a] of Object.entries(deviceAccounts)) {
        // 🔴 The signed-in user's own entry belongs to the session branch above — never let the device set
        // overwrite it. `upsert` compares each candidate against `prev` (the state this effect started from),
        // NOT against the `next` it is accumulating, so when both branches touch one id the LAST writer wins
        // regardless of which value is fresher. The hub device set is a cache (30-day rolling, 60s client
        // staleTime) and can still be serving the PREVIOUS avatar url in the read-after-write window right
        // after a profile-picture change — and changing a picture hard-deletes the old image, so the loser of
        // that race is a url that 404s. The session is the copy the rest of the app already renders from.
        // Skipping the id also means every id is written at most ONCE, which is what keeps comparing against
        // `prev` correct — and keeps `changed` exact, so a no-op pass still returns the SAME object and
        // setRoster bails (no re-render / no localStorage churn / no render loop).
        if (id === sessionOwnedId) continue;
        upsert(id, {
          id: a.id,
          username: a.username || prev[id]?.username || '',
          avatarUrl: a.avatarUrl ?? prev[id]?.avatarUrl,
        });
      }
      return changed ? next : prev;
    });
    // Every value this effect reads is listed — no `exhaustive-deps` suppression, deliberately. The
    // suppression that used to sit here hid a real defect: the deps were `[currentUserId, deviceAccounts]`,
    // and NEITHER changes when a user updates their profile picture, so the roster went on serving the
    // previous avatar url until the device-account query happened to refetch (60s staleTime). Changing a
    // profile picture HARD-DELETES the previous image, so that url 404s for the whole window — and the CDN
    // caches the failure well beyond it. `setRoster` is stable (useLocalStorage memoizes it on `key`), and
    // the rest are primitives, so a complete dep list cannot loop.
  }, [
    currentUserId,
    deviceAccounts,
    hasSessionUser,
    isImpersonating,
    sessionUsername,
    sessionAvatarUrl,
    setRoster,
  ]);

  // Display list = the durable roster, with active/needsLogin resolved against the live session + device set.
  const accounts = useMemo<CivitaiAccounts>(() => {
    const out: CivitaiAccounts = {};
    for (const [id, r] of Object.entries(roster)) {
      // The hub device set alone: it is exactly what swapAccount honours, so the badge matches the click.
      out[id] = {
        id: r.id,
        username: r.username,
        avatarUrl: r.avatarUrl,
        active: String(currentUserId) === id,
        needsLogin: !(id in deviceAccounts),
      };
    }
    return out;
  }, [roster, deviceAccounts, currentUserId]);

  // Log out of the CURRENT account only — never auto-switch into another. The roster keeps the others listed.
  const logout = async () => {
    deleteCookies(deleteCookieList);
    await handleSignOut();
  };

  // "Sign out everywhere on this browser": forget the ENTIRE device account set, not just the current session.
  //
  // The hub has no single "forget this device's whole account set" endpoint yet (it only exposes
  // DELETE /api/auth/accounts?userId=N for one account at a time — see apps/auth/.../api/auth/accounts), so we
  // fan that out over every account in the live device set. We await the hub removals BEFORE handleSignOut()
  // navigates away (a full-page redirect that would otherwise cancel in-flight fetches). We also drop the local
  // roster + legacy token store so the switcher shows nothing, and logout() below clears the HttpOnly device
  // cookie server-side — so even an account that raced the removeAccount call can't be switched back into.
  //
  // TODO(E): replace the per-account fan-out with a single hub "forget this device" endpoint
  // (e.g. DELETE /api/auth/accounts with no userId, clearing the whole device set + busting the device cookie)
  // so this is atomic and doesn't depend on the client-visible account list being complete.
  const logoutAll = async () => {
    // Best-effort: remove every seamlessly-switchable account from the hub device set. Awaited so the requests
    // land before the logout redirect tears the page down. `authProxy.removeAccount` already swallows errors.
    await Promise.all(Object.keys(deviceAccounts).map((id) => authProxy.removeAccount(Number(id))));
    // Drop the durable display roster — the user asked to forget all accounts on this browser.
    setRoster({});
    await logout();
  };

  const swapAccount = async (userId: number, callbackUrl?: string) => {
    const cb = callbackUrl ?? window.location.href;
    const idStr = String(userId);
    // 1. Fresh in the device set → seamless switch (the hub mints a fresh civ-token; the proxy sets it).
    //    A false result means it raced out of the 30-day window since the list loaded → fall to re-login.
    if (idStr in deviceAccounts && (await authProxy.switchAccount(userId))) {
      window.location.assign(cb);
      return;
    }
    // 2. Not seamlessly switchable (aged out of the device set, or a legacy account whose seamless next-auth
    //    redeem was removed with next-auth) → re-authenticate this account at the hub.
    window.location.assign(getLoginLink({ returnUrl: cb, reason: 'switch-accounts' }));
  };

  // Explicit "remove this account from this browser" — drops it from the roster, the legacy store, and the hub
  // device set. Best-effort; we refetch the seamless set afterward.
  const removeAccount = async (id: number) => {
    setRoster((prev) => {
      const next = { ...prev };
      delete next[String(id)];
      return next;
    });
    await authProxy.removeAccount(id).catch(() => undefined);
    await queryClient.invalidateQueries({ queryKey: accountsQueryKey });
  };

  // Impersonation (F) — via the package browser client → same-origin proxy → hub. The proxy gates on moderator
  // status, mints the session (stamped impersonatedBy), and sets the cookie; we just reload as that user.
  const impersonate = async (userId: number) => {
    await authProxy.impersonate(userId); // throws with the proxy's message on failure
    window.location.reload(); // re-resolve the current page as the impersonated user — keep the mod's place
  };

  // Exit impersonation — the hub reads `impersonatedBy` off the current session token and re-mints the mod's.
  const exitImpersonation = async () => {
    await authProxy.exitImpersonation();
    window.location.reload(); // re-resolve in place as the moderator
  };

  // - reload page when account has changed (cross-tab switch)
  useEffect(() => {
    const reloadIfInactiveAccount = () => {
      if (document.visibilityState === 'visible') {
        const previousUserId = previousUserData?.user?.id;
        if (currentUserId !== previousUserId && previousUserData !== undefined && router.isReady) {
          router.reload();
        }
      }
    };
    document.addEventListener('visibilitychange', reloadIfInactiveAccount);
    return () => {
      document.removeEventListener('visibilitychange', reloadIfInactiveAccount);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUserId, router]);

  return (
    <AccountContext.Provider
      value={{
        accounts,
        logout,
        logoutAll,
        swapAccount,
        removeAccount,
        impersonate,
        exitImpersonation,
      }}
    >
      {children}
    </AccountContext.Provider>
  );
};
