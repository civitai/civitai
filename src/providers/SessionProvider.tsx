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

/** Why a session fetch ran. Callers of `update` may name `refresh-signal`; anything else is `update`. */
export type SessionFetchTrigger = 'mount' | 'focus' | 'interval' | 'update' | 'refresh-signal';

interface SessionContextValue {
  /** `undefined` while loading, `null` when signed out, the Session when signed in (mirrors next-auth). */
  data: Session | null | undefined;
  status: SessionStatus;
  /** Re-fetch /api/auth/session and update the context. Returns the fresh session (or null). The
   *  argument only labels the fetch in `SessionDiagnostics`. */
  update: (trigger?: SessionFetchTrigger) => Promise<Session | null>;
}

const SessionContext = createContext<SessionContextValue | undefined>(undefined);

/**
 * How this document's session got to its current value — read by the login-gate diagnostic
 * (`~/utils/faro/loginGate`). A mutable record kept in a ref: writing it renders nothing and changes
 * no behaviour. Literal values only; never the session itself.
 */
export type SessionDiagnostics = {
  /** What the provider was mounted with: a server-rendered session, a server-rendered "signed
   *  out", an unknown (fetch on mount), or a shell page waiting for its page data. */
  boot: 'ssr-session' | 'ssr-null' | 'ssr-unknown' | 'shell';
  /** Whether the hard load's request carried a session cookie, as the server saw it (`_app`'s
   *  `sessionCookie` page prop); `undefined` when not told (a shell render reads no viewer cookie). */
  sessionCookie: boolean | undefined;
  /** True when the hard load was made with a session cookie: told so, a server-rendered session,
   *  an unknown session (`_app` passes that only with a cookie), or a shell (served only with one). */
  authCookieAtLoad: boolean;
  /** Distinct consecutive statuses since mount, oldest first (capped). */
  history: SessionStatus[];
  /** What produced the current value: the mount props, the shell seed, or a fetch (by trigger;
   *  `:undetermined` when a fetch that could not decide resolved a still-loading state). */
  source:
    | 'ssr'
    | 'shell-seed'
    | `fetch:${SessionFetchTrigger}`
    | `fetch:${SessionFetchTrigger}:undetermined`;
  /** The shell seed's session, once adopted. */
  seedSession?: 'present' | 'null';
  fetchCount: number;
  /** The last completed `/api/auth/session` fetch. `httpStatus` 0 = network error. */
  lastFetch?: {
    trigger: SessionFetchTrigger;
    outcome: 'ok-session' | 'ok-null' | 'undetermined';
    httpStatus: number;
  };
};

const SESSION_HISTORY_CAP = 12;

const SessionDiagnosticsContext = createContext<SessionDiagnostics | undefined>(undefined);

/**
 * GET /api/auth/session. Three-valued so a transient blip can't flash the user signed-out (next-auth is
 * similarly resilient):
 *   - `Session`   — 200 with a user (signed in)
 *   - `null`      — 200 with `{}` (AUTHORITATIVELY signed out)
 *   - `undefined` — non-2xx / network error (couldn't determine; caller keeps the current value)
 */
async function fetchSession(): Promise<{
  session: Session | null | undefined;
  httpStatus: number;
}> {
  try {
    const res = await fetch('/api/auth/session', { headers: { accept: 'application/json' } });
    if (!res.ok) return { session: undefined, httpStatus: res.status };
    const json = (await res.json().catch(() => null)) as Partial<Session> | null;
    return { session: json?.user ? (json as Session) : null, httpStatus: res.status };
  } catch {
    return { session: undefined, httpStatus: 0 };
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
  sessionCookie,
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
  /** Diagnostics only (`SessionDiagnostics.sessionCookie`): whether the hard load's request carried
   *  a session cookie. Read once, at mount. */
  sessionCookie?: boolean;
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
  // Read by `update` when its fetch returns, so it sees the seed as it is THEN, not at the call.
  const seedPending = useRef(seed === null);
  seedPending.current = seed === null;

  const diagnostics = useRef<SessionDiagnostics | null>(null);
  if (!diagnostics.current) {
    const boot =
      seed === null
        ? 'shell'
        : initial === undefined
        ? 'ssr-unknown'
        : initial
        ? 'ssr-session'
        : 'ssr-null';
    diagnostics.current = {
      boot,
      sessionCookie,
      authCookieAtLoad: sessionCookie === true || boot !== 'ssr-null',
      history: [],
      source: 'ssr',
      fetchCount: 0,
    };
  }
  const dataRef = useRef(data);
  dataRef.current = data;

  // Adopted while rendering, so the providers below see the session in the same render as the
  // rest of the seed (the per-user flag overlay query is enabled by it).
  const [seedAdopted, setSeedAdopted] = useState(false);
  if (seed && !seedAdopted) {
    setSeedAdopted(true);
    diagnostics.current.seedSession = seed.session ? 'present' : 'null';
    if (data === undefined) diagnostics.current.source = 'shell-seed';
    setData((prev) => (prev === undefined ? seed.session : prev));
  }

  const hadSession = useRef(false);
  if (data?.user) hadSession.current = true;
  const reloadedForLostSession = useRef(false);

  // Fetches still running, so an undetermined answer can tell whether another one may yet decide.
  const inflight = useRef(0);

  const update = useCallback(async (trigger?: SessionFetchTrigger) => {
    // Untyped callers (`refresh: update` handed on as an event handler) can pass anything.
    const label: SessionFetchTrigger =
      trigger === 'mount' ||
      trigger === 'focus' ||
      trigger === 'interval' ||
      trigger === 'refresh-signal'
        ? trigger
        : 'update';
    inflight.current++;
    const { session: next, httpStatus } = await fetchSession().finally(() => inflight.current--);
    const diag = diagnostics.current;
    if (diag) {
      diag.fetchCount++;
      diag.lastFetch = {
        trigger: label,
        outcome: next === undefined ? 'undetermined' : next ? 'ok-session' : 'ok-null',
        httpStatus,
      };
    }
    if (next === null && hadSession.current && !reloadedForLostSession.current) {
      reloadedForLostSession.current = true;
      reloadForLostSession();
    }
    if (next === undefined && (seedPending.current || inflight.current > 0)) {
      // Couldn't determine, and a seed or another fetch is still on its way: that one decides.
      // Resolving to signed-out here would outrank it — a seed is adopted only into a
      // still-loading state — and flash gated UI for a viewer who is signed in.
      return null;
    }
    // `undefined` = couldn't determine: keep the current session, but resolve a still-loading state to
    // signed-out so we never hang on 'loading'. `null`/Session are authoritative.
    if (diag) {
      if (next !== undefined) diag.source = `fetch:${label}`;
      else if (dataRef.current === undefined) diag.source = `fetch:${label}:undetermined`;
    }
    setData((prev) => (next !== undefined ? next : prev ?? null));
    resolved.current = true;
    return next ?? null;
  }, []);

  // Initial fetch only when the seed was `undefined` (unknown) and no later seed is coming.
  useEffect(() => {
    if (seed) resolved.current = true;
    if (!resolved.current && seed !== null) void update('mount');
  }, [update, seed]);

  useEffect(() => {
    if (!refetchOnWindowFocus) return;
    const onFocus = () => void update('focus');
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refetchOnWindowFocus, update]);

  useEffect(() => {
    if (!refetchInterval) return;
    const id = setInterval(() => void update('interval'), refetchInterval * 1000);
    return () => clearInterval(id);
  }, [refetchInterval, update]);

  const status: SessionStatus =
    data === undefined ? 'loading' : data?.user ? 'authenticated' : 'unauthenticated';
  // Idempotent (only a change appends), so a discarded or repeated render records nothing extra.
  const history = diagnostics.current.history;
  if (history[history.length - 1] !== status && history.length < SESSION_HISTORY_CAP)
    history.push(status);

  // Memoize so the ~13 useSession consumers re-render only when the session actually changes — not on every
  // _app re-render (e.g. each route change), which a fresh value object would otherwise force.
  const value = useMemo<SessionContextValue>(
    () => ({ data, status, update }),
    [data, status, update]
  );

  return (
    <SessionDiagnosticsContext.Provider value={diagnostics.current}>
      <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
    </SessionDiagnosticsContext.Provider>
  );
}

/** The provider's `SessionDiagnostics` record (`undefined` outside a provider). Read it in an effect
 *  or handler: it changes without re-rendering anyone. */
export function useSessionDiagnostics(): SessionDiagnostics | undefined {
  return useContext(SessionDiagnosticsContext);
}

/** Drop-in for next-auth/react's `useSession()` — `{ data, status, update }`. Outside a provider it reports
 *  `loading` (matching next-auth's pre-hydration behavior) rather than throwing. */
export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) return { data: undefined, status: 'loading', update: async () => null };
  return ctx;
}
