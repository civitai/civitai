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

// First-party replacement for next-auth/react's `SessionProvider` + `useSession` (cutover phase 4). The session
// is the hub's thin civ-token; the rich user is resolved server-side and exposed by GET /api/auth/session in
// next-auth's `{ user, expires }` shape — so this keeps the exact `useSession()` contract the ~13 call sites
// already use (`{ data, status, update }`), no per-site rewrites. NB: `Session` is still the next-auth type;
// phase 5 swaps it for a first-party type app-wide. signIn/signOut/getProviders remain on next-auth/react until
// phase 5 (they're coupled to the next-auth server endpoints).

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

export function SessionProvider({
  children,
  session: initial,
  refetchOnWindowFocus = true,
  // Accepted for next-auth API compatibility (call sites pass them); intervals/offline are no-ops here.
  refetchInterval,
}: {
  children: ReactNode;
  /** SSR seed: a Session when known-authed, `null` when known-unauthed (skip the fetch), `undefined` when
   *  unknown (fetch on mount). */
  session?: Session | null;
  refetchOnWindowFocus?: boolean;
  refetchWhenOffline?: boolean;
  refetchInterval?: number;
}) {
  // `data` IS the loading state: `undefined` = not yet resolved (loading), `null` = resolved signed-out,
  // `Session` = signed-in. So there's no separate loading flag — and a background refetch (focus / interval /
  // signal-driven update) never flips status back to 'loading', which would flash gated UI despite valid data.
  const [data, setData] = useState<Session | null | undefined>(initial);
  // True once we have an authoritative value (a non-undefined seed, or a completed fetch).
  const resolved = useRef(initial !== undefined);

  const update = useCallback(async () => {
    const next = await fetchSession();
    // `undefined` = couldn't determine: keep the current session, but resolve a still-loading INITIAL state to
    // signed-out so we never hang on 'loading'. `null`/Session are authoritative.
    setData((prev) => (next !== undefined ? next : prev ?? null));
    resolved.current = true;
    return next ?? null;
  }, []);

  // Initial fetch only when the seed was `undefined` (unknown).
  useEffect(() => {
    if (!resolved.current) void update();
  }, [update]);

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
  const value = useMemo<SessionContextValue>(() => ({ data, status, update }), [data, status, update]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

/** Drop-in for next-auth/react's `useSession()` — `{ data, status, update }`. Outside a provider it reports
 *  `loading` (matching next-auth's pre-hydration behavior) rather than throwing. */
export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) return { data: undefined, status: 'loading', update: async () => null };
  return ctx;
}
