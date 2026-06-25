import { useLocalStorage, usePrevious } from '@mantine/hooks';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { authProxy } from '~/utils/auth-proxy';
import { useSession } from '~/providers/SessionProvider';
import { handleSignOut } from '~/utils/auth-helpers';
import { getLoginLink } from '~/utils/login-helpers';
import { useRouter } from 'next/router';
import type { ReactNode } from 'react';
import { createContext, useContext, useEffect, useMemo } from 'react';
import type { EncryptedDataSchema } from '~/server/schema/civToken.schema';
import { deleteCookies } from '~/utils/cookies-helpers';

// DEVICE-LEVEL account switching (docs/main-app-auth-cutover.md, section E). Two stores, by design:
//   • ROSTER (localStorage `civitai-account-roster`) — the DURABLE, credential-free list of accounts used on
//     this browser: { id, username, avatarUrl }. This is how the user always sees which accounts they've added,
//     even after a session expires. Holds NO tokens.
//   • HUB DEVICE SET (Redis, 30d rolling) — which of those accounts can be switched to WITHOUT re-login. An
//     account that ages out of this window stays in the roster but, when clicked, re-authenticates at the hub.
// Plus a one-time MIGRATION read of the legacy `civitai-accounts` (token-per-account) so pre-existing users
// keep their links: it seeds the roster and lets us switch seamlessly until each account re-links to the set.
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

// Legacy token-per-account store (migration only — read, redeem, drain). No new writes.
type LegacyAccount = {
  token: EncryptedDataSchema;
  active: boolean;
  email: string;
  username: string;
  avatarUrl?: string;
};
type LegacyAccounts = Record<string, LegacyAccount>;
const legacyAccountsKey = 'civitai-accounts';

const accountsQueryKey = ['device-accounts'] as const;
// Stable empty reference for the device-account set — using a `= {}` destructuring default would mint a NEW
// object every render, so any effect depending on it would re-run (and re-setState) forever.
const EMPTY_ROSTER: Roster = {};

const deleteCookieList = ['ref_code', 'ref_source'];

type AccountState = {
  accounts: CivitaiAccounts;
  logout: () => Promise<void>;
  logoutAll: () => Promise<void>;
  // Switch by userId: seamless device switch if fresh in the set, legacy-token redeem if mid-migration, else
  // re-authenticate at the hub. (Cross-domain .red now goes through the server auth-code flow, not here.)
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

  // The seamlessly-switchable set (hub device set, 30d rolling). Empty until authenticated. `?? EMPTY_ROSTER`
  // (not a `= {}` default) keeps the reference STABLE across renders so the effects below don't loop.
  const { data: deviceAccountsData } = useQuery<Record<string, RosterEntry>>({
    queryKey: accountsQueryKey,
    enabled: status === 'authenticated',
    staleTime: 60_000,
    queryFn: async () => {
      const rows = await authProxy.listAccounts();
      return Object.fromEntries(
        rows.map((a) => [String(a.userId), { id: a.userId, username: a.username ?? '', avatarUrl: a.image }])
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
  // Legacy token store — read for seamless migration only.
  const [legacyAccounts, setLegacyAccounts] = useLocalStorage<LegacyAccounts>({
    key: legacyAccountsKey,
    defaultValue: {},
    getInitialValueInEffect: false,
  });
  // Seed the roster from the legacy store (one-time; copies identity only, never the token).
  useEffect(() => {
    const ids = Object.keys(legacyAccounts).filter((id) => !(id in roster));
    if (!ids.length) return;
    setRoster((prev) => {
      const next = { ...prev };
      for (const id of ids) {
        const a = legacyAccounts[id];
        next[id] = { id: Number(id), username: a.username, avatarUrl: a.avatarUrl };
      }
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [legacyAccounts]);

  // Remember the current user + every seamlessly-switchable account in the durable roster. Returns the SAME
  // object when nothing changed so setState bails (no re-render / no localStorage churn / no render loop).
  useEffect(() => {
    setRoster((prev) => {
      const next = { ...prev };
      let changed = false;
      const upsert = (id: string, entry: RosterEntry) => {
        const cur = prev[id];
        if (!cur || cur.id !== entry.id || cur.username !== entry.username || cur.avatarUrl !== entry.avatarUrl) {
          next[id] = entry;
          changed = true;
        }
      };
      // NB: skip the current user while IMPERSONATING — the "current user" is then the impersonated target, not
      // a real account linked on this device, so it must never enter the switcher roster (impersonation also
      // never touches the hub device set, so deviceAccounts below won't reintroduce it).
      if (currentUserId && userData?.user && !userData.impersonatedBy) {
        upsert(String(currentUserId), {
          id: currentUserId,
          username: userData.user.username ?? prev[String(currentUserId)]?.username ?? '',
          avatarUrl: userData.user.image ?? prev[String(currentUserId)]?.avatarUrl,
        });
      }
      for (const [id, a] of Object.entries(deviceAccounts)) {
        upsert(id, {
          id: a.id,
          username: a.username || prev[id]?.username || '',
          avatarUrl: a.avatarUrl ?? prev[id]?.avatarUrl,
        });
      }
      return changed ? next : prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUserId, deviceAccounts]);

  // Drop legacy tokens once that account is in the device set (migrated). The roster keeps the account.
  useEffect(() => {
    const migrated = Object.keys(legacyAccounts).filter((id) => id in deviceAccounts);
    if (!migrated.length) return;
    setLegacyAccounts((prev) => {
      const next = { ...prev };
      for (const id of migrated) delete next[id];
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceAccounts]);

  // Display list = the durable roster, with active/needsLogin resolved against the live session + device set.
  const accounts = useMemo<CivitaiAccounts>(() => {
    const out: CivitaiAccounts = {};
    for (const [id, r] of Object.entries(roster)) {
      const seamless = id in deviceAccounts || id in legacyAccounts; // switchable without re-login
      out[id] = {
        id: r.id,
        username: r.username,
        avatarUrl: r.avatarUrl,
        active: String(currentUserId) === id,
        needsLogin: !seamless,
      };
    }
    return out;
  }, [roster, deviceAccounts, legacyAccounts, currentUserId]);

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
    // Drop the durable display roster and the legacy token store — the user asked to forget all accounts here.
    setRoster({});
    setLegacyAccounts({});
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
    if (String(id) in legacyAccounts) {
      setLegacyAccounts((prev) => {
        const next = { ...prev };
        delete next[String(id)];
        return next;
      });
    }
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
