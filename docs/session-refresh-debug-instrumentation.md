# Session Refresh Debug Instrumentation

Temporary diagnostic logging added to identify the source of unexpected
`POST /api/auth/session` calls observed during a staged production deploy.
The instrumentation surfaces the call stack of any `refreshSession()` invocation
to the browser console via response headers, so it can be diagnosed from
DevTools without server-log access.

Once the source has been identified, **revert all of the following changes**.
None of them are part of the permanent fix.

> **Note:** [`src/components/AppLayout/FeatureLayout.tsx`](../src/components/AppLayout/FeatureLayout.tsx)
> was also touched during this investigation. That change (gating the loader on
> `status === 'loading' && !data`) is the **real fix** for the page-blanking
> symptom and should **not** be reverted.

## Files to revert

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
    await sysRedis.set(`session-refresh-cause:${userId}`, compact, { EX: 60 * 60 });
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

- Remove the `sysRedis` import:

  ```ts
  import { sysRedis } from '~/server/redis/client';
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

### 4. `src/components/UpdateRequiredWatcher/UpdateRequiredWatcher.tsx`

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

## Redis cleanup (optional)

The instrumentation writes per-user keys at `session-refresh-cause:{userId}`
with a 1-hour TTL. They expire on their own; no cleanup is required. If you
want to flush them immediately after revert:

```
redis-cli --scan --pattern 'session-refresh-cause:*' | xargs redis-cli del
```
