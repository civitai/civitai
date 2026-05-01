# Debug Instrumentation Cleanup

This doc tracks **temporary diagnostic logs** added during two related
investigations so they can be cleanly reverted once no longer needed:

1. **Session-refresh diagnostics** — identifying the source of unexpected
   `POST /api/auth/session` calls observed during a staged production deploy.
2. **Signal/metric render diagnostics** — auditing how often signal-driven
   updates cause React re-renders.

It also lists the **permanent fixes** that came out of the same investigations,
so they're not reverted by mistake.

---

## Permanent fixes — DO NOT revert

These are real bug/perf fixes that should stay in the codebase. Listed here
only so they aren't bundled into a "revert all the debug stuff" pass.

| File | What changed | Why it stays |
| --- | --- | --- |
| [src/components/AppLayout/FeatureLayout.tsx](../src/components/AppLayout/FeatureLayout.tsx) | Loader gate changed from `status === 'loading'` to `status === 'loading' && !data` | Prevents the page from blanking during in-flight `update()` calls when a session is already loaded. |
| [src/store/signal-topics.store.ts](../src/store/signal-topics.store.ts) | New Zustand store holding registered signal topics | Moves topic-list state out of `SignalsProvider` so subscription changes don't fan out re-renders to every `useSignalContext` consumer. |
| [src/components/Signals/SignalsProvider.tsx](../src/components/Signals/SignalsProvider.tsx) | Removed `registeredTopics` `useState` + context exposure; `register/release` now call the store imperatively | Same as above — eliminates the cascade where mounting one `MetricsLive` re-rendered every other one. |
| [src/components/Auction/AuctionUtils.tsx](../src/components/Auction/AuctionUtils.tsx), [src/components/Auction/AuctionInfo.tsx](../src/components/Auction/AuctionInfo.tsx), [src/pages/testing/metrics-refcount.tsx](../src/pages/testing/metrics-refcount.tsx), [src/pages/testing/live-card-parity.tsx](../src/pages/testing/live-card-parity.tsx) | Read `registeredTopics` from `useSignalTopicsStore` instead of `useSignalContext` | Required follow-through from the `SignalsProvider` refactor above. |
| [src/components/Signals/MetricSignalsRegistrar.tsx](../src/components/Signals/MetricSignalsRegistrar.tsx) | Skips `applyDelta` when the normalized payload has no truthy values | Server emits empty topic-only notifications; without this, every empty signal triggered selector runs across all `MetricsLive` consumers. |
| [src/store/metric-signals.store.ts](../src/store/metric-signals.store.ts) | `applyDelta` returns the existing state object when no fields actually changed | Defense-in-depth for the same issue — preserves reference identity so Zustand subscribers don't re-run their selectors. |

---

## Files to revert (diagnostics only)

### 1. `src/server/auth/session-invalidation.ts`

Inside `refreshSession()`, remove the stack capture + Redis write block.

**Remove:**

```ts
// Temporary: capture caller stack so we can surface it via response header.
// Skips the internal JWT 'update' callback path (next-auth-options.ts) which
// re-marks tokens by design and clears its own marker immediately after.
const stack = new Error().stack ?? '';
if (!stack.includes('next-auth-options')) {
  console.warn(`[refreshSession] userId=${userId} sendSignal=${sendSignal}\n${stack}`);
  try {
    // Compact the stack into a single-line, header-safe string and stash in
    // Redis. The session callback will read this and surface it to the
    // client via x-session-refresh-cause.
    const compact = stack
      .split('\n')
      .slice(1, 8)
      .map((s) => s.trim())
      .join(' | ')
      .replace(/[^\x20-\x7E]/g, ' ')
      .slice(0, 1500);
    await sysRedis.set(`${REDIS_SYS_KEYS.SESSION.REFRESH_CAUSE}:${userId}`, compact, {
      EX: 60 * 60,
    });
  } catch {}
}
```

The function should end with the original `log(...)` line and the closing brace.

### 2. `src/server/auth/token-refresh.ts`

Remove the three `console.warn` calls inside `refreshToken()`:

- After `tokenState === 'invalid'` branch (around line 67-69):

  ```ts
  console.warn(
    `[refreshToken] needsCookieRefresh=true reason=invalid userId=${user.id} tokenId=${tokenId}`
  );
  ```

- Inside `if (tokenState === 'refresh')` block (around line 88-90):

  ```ts
  console.warn(
    `[refreshToken] needsCookieRefresh=true reason=token-state-refresh userId=${user.id} tokenId=${tokenId}`
  );
  ```

- Inside the `SESSION:ALL` global-invalidation branch (around line 106-108):

  ```ts
  console.warn(
    `[refreshToken] needsCookieRefresh=true reason=session-all userId=${user.id} tokenId=${tokenId} asOf=${allInvalidationDateStr} signedAt=${new Date(token.signedAt as number).toISOString()}`
  );
  ```

### 3. `src/server/auth/get-server-auth-session.ts`

Three changes to undo:

- Drop `REDIS_SYS_KEYS` from the import (keep `sysRedis` — but if no other
  references remain after revert, remove the whole import line):

  ```ts
  import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
  ```

- Revert `checkAndSetSessionHeaders` to its synchronous form (drop the `async`,
  return type back to `Session | null`, and remove the Redis-read block):

  ```ts
  function checkAndSetSessionHeaders(session: Session | null, res: AuthResponse): Session | null {
    if (session?.needsCookieRefresh) {
      res.setHeader(SESSION_REFRESH_HEADER, 'true');
      res.setHeader(
        'Set-Cookie',
        `${SESSION_REFRESH_COOKIE}=true; Path=/; Max-Age=300; SameSite=Lax`
      );
      delete session.needsCookieRefresh;
    }
    return session;
  }
  ```

- Drop the `await` on the call site:

  ```ts
  req.context.session = checkAndSetSessionHeaders(session, res);
  ```

### 4. `src/server/redis/client.ts`

Remove the `REFRESH_CAUSE` entry added to `REDIS_SYS_KEYS.SESSION`:

```ts
SESSION: {
  ALL: 'session:all',
  TOKEN_STATE: 'session:token-state',
  REFRESH_CAUSE: 'session:refresh-cause', // ← remove this line
},
```

### 5. `src/components/UpdateRequiredWatcher/UpdateRequiredWatcher.tsx`

Remove the three `console.warn` lines inside the fetch interceptor's session-refresh
header handler:

```ts
// eslint-disable-next-line no-console
console.warn('[session-refresh] triggered by response from', response.url);
const cause = response.headers.get('x-session-refresh-cause');
// eslint-disable-next-line no-console
if (cause) console.warn('[session-refresh] cause:', cause);
```

The handler should return to its original form starting with
`sessionRefreshPending = true;`.

### 6. `src/components/Signals/MetricSignalsRegistrar.tsx`

Two diagnostic-only changes (the empty-payload short-circuit itself stays —
it's a permanent fix listed above):

- Drop the `signalDebug` import added for diagnostics:

  ```ts
  import { signalDebug } from '~/components/Signals/signalDebug';
  ```

- Inside `handleMetricUpdate`, drop the diagnostic line and the `hasChange`
  flag passed to it. Simplify back to:

  ```ts
  const hasChange = Object.values(updates).some((v) => !!v);
  if (!hasChange) return;
  applyDelta(entityType, entityId, updates);
  ```

  …removing only the `signalDebug('metric:update received', { ... });` line
  between `hasChange` and the early return. Keep the short-circuit.

### 7. `src/components/Metrics/Metrics.tsx` (optional, recommended)

These render-time debug logs predate this investigation but were exercised
heavily during it. They're noisy in steady state and good candidates to remove
once you're done verifying.

- Remove `signalDebug('Metrics render', ...)` and the `renders` ref it depends
  on at the top of the `Metrics` component.
- Remove the `signalDebug('MetricsLive mount/unmount', ...)` `useEffect` and
  the `signalDebug('MetricsLive render', ...)` call in the `MetricsLive`
  component, plus its `renders` ref.
- If nothing else in this file calls `signalDebug`, drop the import.

The recommended **keep-set** for ongoing diagnostics — modest volume, useful
signal — is: `metric:update received` (after the diagnostic line is removed,
this one specifically is gone too — remove only if you also want to keep the
short-circuit's silent behavior), `registerTopic` / `releaseTopic` (low-volume
subscription transitions in [SignalsProvider.tsx](../src/components/Signals/SignalsProvider.tsx)),
and the `useMetricSubscription effect: subscribe/unsubscribe` lines.

## Redis cleanup (optional)

The session-refresh instrumentation writes per-user keys at
`session:refresh-cause:{userId}` with a 1-hour TTL. They expire on their own;
no cleanup is required. If you want to flush them immediately after revert:

```bash
redis-cli --scan --pattern 'session:refresh-cause:*' | xargs redis-cli del
```
