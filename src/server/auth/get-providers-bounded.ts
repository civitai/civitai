import { getProviders } from 'next-auth/react';

/**
 * Bounded wrapper around next-auth's `getProviders()`.
 *
 * `getProviders()` from `next-auth/react`, when called in a SERVER context
 * (tRPC query / `getServerSideProps`), resolves the OAuth provider list by
 * doing an outbound HTTP SELF-FETCH to this pod's own
 * `${NEXTAUTH_URL_INTERNAL}/api/auth/providers`. next-auth's internal fetch
 * (`fetchData` in `next-auth/client/_utils`) has **no timeout** and **no
 * AbortSignal hook**, so during an outbound-HTTP slowdown it hangs until the
 * socket finally resolves — which on api-primary means it pins past Traefik's
 * 30s forwarding ceiling and the whole request returns HTTP 504. This is the
 * same failure CLASS that PR #2502 fixed on the SSR `/api/user/settings`
 * self-fetch, and the same class as the chronic `/api/auth/session`
 * `CLIENT_FETCH_ERROR` self-fetch wedge.
 *
 * Because the underlying fetch ignores any caller-supplied signal, we can't
 * abort the socket — but we CAN free the request handler by racing the call
 * against a bounded timer and fast-failing to `null` (next-auth's OWN failure
 * return value, so the shape stays in-band and type-safe). The provider list is
 * a low-stakes UI concern: a transient miss degrades to "no extra OAuth buttons
 * this render", never an auth/session mutation, so this can NEVER log a user out.
 *
 * Timeout is env-tunable (`AUTH_PROVIDERS_FETCH_TIMEOUT_MS`, default 8s, mirrors
 * #2502's `APP_SETTINGS_FETCH_TIMEOUT_MS`) and clamped to a 1s floor so a
 * negative/fat-fingered override can't force a permanent fast-fail.
 */
const AUTH_PROVIDERS_FETCH_TIMEOUT_MS = Math.max(
  1000,
  Number(process.env.AUTH_PROVIDERS_FETCH_TIMEOUT_MS) || 8000
);

export async function getProvidersBounded(): ReturnType<typeof getProviders> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      // Greppable, alertable marker (no 5xx is emitted — we degrade quietly).
      console.warn(
        `[auth] getProviders self-fetch exceeded ${AUTH_PROVIDERS_FETCH_TIMEOUT_MS}ms, degrading to no-providers`
      );
      resolve(null);
    }, AUTH_PROVIDERS_FETCH_TIMEOUT_MS);
  });

  try {
    return await Promise.race([
      getProviders().catch((e) => {
        console.warn(
          `[auth] getProviders self-fetch failed, degrading to no-providers: ${
            e instanceof Error ? e.message : String(e)
          }`
        );
        return null;
      }),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
