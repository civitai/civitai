# Usage limits: adding a new limit

Every limit a user can hit is an entry in one registry,
`src/shared/constants/usage-limits.ts`. An entry gives a limit one id, shared by the 429 a client
receives, `GET /api/v1/me/limits` and the account **Usage limits** page. It also makes the limit
tunable per membership tier through the `usage-limits` KeyValue row, with no deploy.

## 1. Add the registry entry

```ts
{
  id: 'stickers.auto-track-daily', // what clients see; never rename once shipped
  area: 'stickers',                // groups rows on the Usage page
  kind: 'product',                 // 'product' (a plan limit) or 'abuse' (anti-abuse ceiling)
  label: 'Sticker auto-tracks per day',
  window: { type: 'utc-day' },     // rolling | utc-day | utc-month | standing
  base: 3,                         // the free-tier value
  byTier: { member: { multiplier: 2 } }, // optional; also byScore
  message: ({ limit }) => `You've used your ${limit} ... for today.`,
}
```

The values in code are the defaults. A KeyValue override replaces a field whole, so a `byTier`
override repeats every tier it keeps.

## 2. Enforce it

Which path depends on the window.

- **A rolling window of a day or less, on a tRPC procedure:** use the middleware. It counts,
  refuses with the standard 429 meta and lists the row on `/me/limits`, with nothing else to add:

  ```ts
  .use(rateLimit(usageLimits('auto-label.submit')))
  ```

  `usageLimits()` throws for a window the rate-limit bucket cannot count, so a wrong window fails
  as soon as the router module loads.

- **A calendar window (`utc-day`, `utc-month`), or a limit enforced in a service or REST route:**
  the service counts it itself. Read the value with `resolveUsageLimit(id, user)`
  (`src/server/services/usage-limit-config.service.ts`). When the user is over it, refuse with
  `throwRateLimited(meta, message)` (`src/server/utils/rate-limit-error.ts`), passing the id,
  limit, used, remaining, `retryAt` and `retryAfterSeconds`. That keeps the 429 body the same as
  every other limit's. `startStickerAutoTrack` (`src/server/services/sticker-auto-track.service.ts`)
  is the worked example.

## 3. Make it visible on /me/limits

Rolling limits enforced through `rateLimit()` need nothing here. A calendar-window limit gets a
row only once you register a counter in `usageLimitCounters`
(`src/server/services/usage-limit-counters.ts`). The counter returns how many times the user used
the limit in `[start, end)`, or `null` when the user cannot reach the feature (for example, its
flag is off). Count from the same store the enforcing code writes, so the page and the refusal
cannot disagree.

## 4. Decide what an override may do

`applies` is false when an override sets `disabled`. If disabling the entry would remove the only
bound on spend, do not skip enforcement on `!applies`: count it always, as sticker auto-track does,
and pin that choice with a test named for it.

## Checklist

- [ ] Registry entry with a stable id, area, kind, label, window and base.
- [ ] Enforced through `rateLimit(usageLimits(...))`, or through `resolveUsageLimit` plus `throwRateLimited`.
- [ ] A calendar window has a counter in `usageLimitCounters`.
- [ ] A test that a request over the limit gets a 429 carrying the id, and that it fails if the check is removed.
