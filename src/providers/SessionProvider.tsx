import type { Session } from '~/types/session';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

// First-party replacement for the old next-auth/react `SessionProvider` + `useSession`. The session is the hub's
// thin civ-token; the rich user is resolved server-side and exposed by GET /api/auth/session in the `{ user,
// expires }` shape — keeping the exact `useSession()` contract (`{ data, status, update }`) the call sites use.
// next-auth is fully removed: login is hub-driven (popup / full-page redirect), sign-out hits /api/auth/logout,
// and `Session` is the first-party type from ~/types/session.

type SessionStatus = 'authenticated' | 'unauthenticated' | 'loading';

interface SessionContextValue {
  /** `undefined` while loading, `null` when signed out, the Session when signed in (mirrors next-auth). */
  data: Session | null | undefined;
  status: SessionStatus;
  /** Re-fetch /api/auth/session and update the context. Returns the fresh session (or null). */
  update: () => Promise<Session | null>;
}

const SessionContext = createContext<SessionContextValue | undefined>(undefined);

/**
 * GET /api/auth/session. Three-valued so a transient blip can't flash the user signed-out (next-auth is
 * similarly resilient):
 *   - `Session`   — 200 with a user (signed in)
 *   - `null`      — 200 with `{}` (AUTHORITATIVELY signed out)
 *   - `undefined` — non-2xx / network error (couldn't determine; caller keeps the current value)
 */
async function fetchSession(): Promise<Session | null | undefined> {
  try {
    const res = await fetch('/api/auth/session', { headers: { accept: 'application/json' } });
    if (!res.ok) return undefined;
    const json = (await res.json().catch(() => null)) as Partial<Session> | null;
    return json?.user ? (json as Session) : null;
  } catch {
    return undefined;
  }
}

// A reload that brings back a session the page then loses again must not reload a second time.
const LOST_SESSION_RELOAD_KEY = 'civitai:lost-session-reload';
const LOST_SESSION_RELOAD_COOLDOWN_MS = 5 * 60 * 1000;

/** Reloads the page once so it re-syncs with the server after the signed-in session ended elsewhere. */
function reloadForLostSession() {
  try {
    const last = Number(window.sessionStorage.getItem(LOST_SESSION_RELOAD_KEY));
    if (last && Date.now() - last < LOST_SESSION_RELOAD_COOLDOWN_MS) return;
    window.sessionStorage.setItem(LOST_SESSION_RELOAD_KEY, String(Date.now()));
  } catch {
    // Storage unavailable: the per-page guard in SessionProvider still limits this to one reload.
  }
  window.location.reload();
}

/** A session that arrives after mount (a shell page's page data), adopted once. */
export type SessionSeed = { session: Session | null };

export function SessionProvider({
  children,
  session: initial,
  seed,
  refetchOnWindowFocus = true,
  // Accepted for next-auth API compatibility (call sites pass them); intervals/offline are no-ops here.
  refetchInterval,
}: {
  children: ReactNode;
  /** SSR seed: a Session when known-authed, `null` when known-unauthed (skip the fetch), `undefined` when
   *  unknown (fetch on mount). */
  session?: Session | null;
  /** `null` while a seed is on its way (no fetch), then the seed. `undefined` when none is coming. */
  seed?: SessionSeed | null;
  refetchOnWindowFocus?: boolean;
  refetchWhenOffline?: boolean;
  refetchInterval?: number;
}) {
  // `data` IS the loading state: `undefined` = not yet resolved (loading), `null` = resolved signed-out,
  // `Session` = signed-in. So there's no separate loading flag — and a background refetch (focus / interval /
  // signal-driven update) never flips status back to 'loading', which would flash gated UI despite valid data.
  // A seed on its way (`null` at mount) outranks `initial`: a shell render's session props say
  // nothing about the viewer.
  const [data, setData] = useState<Session | null | undefined>(() =>
    seed === null ? undefined : initial
  );
  // True once we have an authoritative value (a non-undefined seed, or a completed fetch).
  const resolved = useRef(seed !== null && initial !== undefined);

  // Adopted while rendering, so the providers below see the session in the same render as the
  // rest of the seed (the per-user flag overlay query is enabled by it).
  const [seedAdopted, setSeedAdopted] = useState(false);
  if (seed && !seedAdopted) {
    setSeedAdopted(true);
    setData((prev) => (prev === undefined ? seed.session : prev));
  }

  const hadSession = useRef(false);
  if (data?.user) hadSession.current = true;
  const reloadedForLostSession = useRef(false);

  const update = useCallback(async () => {
    const next = await fetchSession();
    if (next === null && hadSession.current && !reloadedForLostSession.current) {
      reloadedForLostSession.current = true;
      reloadForLostSession();
    }
    // `undefined` = couldn't determine: keep the current session, but resolve a still-loading INITIAL state to
    // signed-out so we never hang on 'loading'. `null`/Session are authoritative.
    setData((prev) => (next !== undefined ? next : prev ?? null));
    resolved.current = true;
    return next ?? null;
  }, []);

  // Initial fetch only when the seed was `undefined` (unknown) and no later seed is coming.
  useEffect(() => {
    if (seed) resolved.current = true;
    if (!resolved.current && seed !== null) void update();
  }, [update, seed]);

  useEffect(() => {
    if (!refetchOnWindowFocus) return;
    const onFocus = () => void update();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refetchOnWindowFocus, update]);

  useEffect(() => {
    if (!refetchInterval) return;
    const id = setInterval(() => void update(), refetchInterval * 1000);
    return () => clearInterval(id);
  }, [refetchInterval, update]);

  const status: SessionStatus =
    data === undefined ? 'loading' : data?.user ? 'authenticated' : 'unauthenticated';

  // Memoize so the ~13 useSession consumers re-render only when the session actually changes — not on every
  // _app re-render (e.g. each route change), which a fresh value object would otherwise force.
  const value = useMemo<SessionContextValue>(
    () => ({ data, status, update }),
    [data, status, update]
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

/** Drop-in for next-auth/react's `useSession()` — `{ data, status, update }`. Outside a provider it reports
 *  `loading` (matching next-auth's pre-hydration behavior) rather than throwing. */
export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) return { data: undefined, status: 'loading', update: async () => null };
  return ctx;
}
