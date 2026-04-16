# `syncAccount` Utility Migration

## Background

The `sync-account` query parameter signals to the destination domain which color
domain holds the user's session, so it can pull the token via
`/api/auth/sync` (see [`useDomainSync`](../src/hooks/useDomainSync.tsx)).
Until now, every cross-domain link constructed this param by hand, with the
color value either:

- **Hardcoded to `green`** (correct for .com → .red flows, no-op for .red → .com flows since the source matches the destination)
- **Hardcoded to `blue`** (legacy from when blue was the primary domain slot — `useDomainSync` resolves `serverDomains.blue` which may or may not match `serverDomains.red` per env config)
- **Hardcoded to `yellow`** in one site — invalid as a `ColorDomain`, silently bails inside `useDomainSync`

The new [`syncAccount(url, redirectUrl?)`](../src/utils/sync-account.ts) utility resolves both
the current host and the URL's host against the configured `serverDomains` map
and emits the correct source color automatically. The optional second arg
attaches a `sync-redirect` param so the destination can navigate to a clean
path after the auth swap. Same-color or relative URLs get the URL back unchanged.

## Scope

Migrate every call site that hand-rolls `sync-account=...` to use
`syncAccount(url)`. Bundle as one PR.

## Sites to migrate

### Bucket 1 — Same-value migrations (no behavior change)

User is on .com → linking to .red, hardcoded `?sync-account=green`. The
new utility emits `green` from .com. Pure refactor.

| File | Line | Change |
| --- | --- | --- |
| [MatureContentMigrationAlert.tsx](../src/components/Alerts/MatureContentMigrationAlert.tsx) | 63-64 | Wrap `` `//${redDomain}` `` and the `'https://civitai.red'` fallback with `syncAccount(...)`; drop hardcoded `?sync-account=green` |
| [YellowBuzzMigrationNotice.tsx](../src/components/Alerts/YellowBuzzMigrationNotice.tsx) | 51-55 | Replace `syncParams` + `redUrl` with ``syncAccount(`//${redDomain ?? 'civitai.red'}/`, '/user/buzz-dashboard')``. **Only site using `sync-redirect` — pass the post-sync path as the second arg.** |
| [SensitiveShield.tsx](../src/components/SensitiveShield/SensitiveShield.tsx) | 64 | Replace the manual separator + `sync-account=green` concat with `syncAccount(\`//${redDomain}${router.asPath}\`)` |

### Bucket 2 — Bug fixes (current value is a no-op)

Hardcoded `sync-account=green` while linking *to* the green domain. Inside
`useDomainSync`, `host === syncDomain` short-circuits and the param does
nothing today. After migration, the source resolves to `red` (the user's
actual domain) and the auth swap actually happens.

| File | Line | Change |
| --- | --- | --- |
| [QueueItem.tsx](../src/components/ImageGeneration/QueueItem.tsx) | 744 | `pricingHref = features.isGreen ? '/pricing' : syncAccount(\`//${serverDomains.green}/pricing\`)` |
| [NoCryptoUpsell.tsx](../src/components/Stripe/NoCryptoUpsell.tsx) | 33-34 | `greenBuzzUrl = syncAccount(\`//${greenDomain}/purchase/buzz\`)`; `greenPricingUrl = syncAccount(\`//${greenDomain}/pricing\`)` |

### Bucket 3 — `sync-account=blue` → current source color

Hardcoded `sync-account=blue` is legacy. Migrating shifts the value to the
user's current color — `green` from .com (which the same-host short-circuit
will then omit) or `red` from .red. The intent is unchanged: "use my current
session at the destination."

| File | Line | Change |
| --- | --- | --- |
| [buzz.utils.ts](../src/components/Buzz/buzz.utils.ts) | 27-36 (`useBuyBuzz`) | Drop `'sync-account': 'blue'` from the query object; wrap the final URL passed to `window.open` with `syncAccount(...)` |
| [pricing/index.tsx](../src/pages/pricing/index.tsx) | 50-61 (auto-redirect effect) | Same pattern — drop the param from the query object, wrap the final URL with `syncAccount(...)` |
| [YellowMembershipUnavailable.tsx](../src/components/Purchase/YellowMembershipUnavailable.tsx) | 10-13 | `greenPricingUrl = syncAccount(\`//${serverDomains.green}/pricing?\${QS.stringify({ buzzType: 'green' })}\`)` |
| [BuzzPurchaseImproved.tsx](../src/components/Buzz/BuzzPurchase/BuzzPurchaseImproved.tsx) | 360-373 | Drop `'sync-account': 'blue'` from query; wrap `window.open` URL with `syncAccount(...)` |
| [GreenEnvironmentRedirect.tsx](../src/components/Purchase/GreenEnvironmentRedirect.tsx) | 41-49 (`handleManualRedirect`) | Drop `'sync-account': 'blue'` from query; wrap `window.location.href` value with `syncAccount(...)` |
| [MembershipUpsell.tsx](../src/components/ImageGeneration/MembershipUpsell.tsx) | 107 (Become a member) | Replace the `?sync-account=blue` concat with `syncAccount(pricingUrl)` |

### Bucket 4 — Bug fix in `pages/user/membership.tsx`

`handleRedirectToOtherEnvironment` has two latent bugs:

1. Emits `sync-account=yellow` when going from .red → .com. `'yellow'` is
   not a `ColorDomain`, so `useDomainSync` silently bails — the auth swap
   never happens.
2. Uses `serverDomains.blue` for the .red destination, which is the legacy
   blue-means-red convention. Aligning with the .com→green / .red→red
   mapping means `serverDomains.red`.

| File | Line | Change |
| --- | --- | --- |
| [pages/user/membership.tsx](../src/pages/user/membership.tsx) | 132-141 | Replace function body with `const targetDomain = otherBuzzType === 'green' ? serverDomains.green : serverDomains.red; window.open(syncAccount(\`//${targetDomain}/user/membership\`), '_blank', 'noreferrer');` |

**Validation note:** the `serverDomains.blue` → `serverDomains.red` swap
assumes both keys point to the same host in production. If the env config
has them as distinct hosts, this changes the destination, not just the
sync param. Worth eyeballing the env vars before merging.

## Sites NOT to migrate

| File | Line | Reason |
| --- | --- | --- |
| [LoginContent.tsx](../src/components/Login/LoginContent.tsx) | 53 | The `?sync-account=green` is on a return URL whose host equals the current host — `syncAccount` would short-circuit and drop the param. Intent here is "after authenticating on green, sync from green," which is the post-auth source, not the user's current domain. The utility can't express that. |
| [pages/purchase/buzz.tsx](../src/pages/purchase/buzz.tsx) | 18 | Server-side check that *reads* the param, doesn't write it. |
| [useDomainSync.tsx](../src/hooks/useDomainSync.tsx) | — | The consumer of the param. |

## Acceptance

- All 12 sites in Buckets 1–4 use `syncAccount(...)`.
- No remaining `sync-account=green`, `sync-account=blue`, or `sync-account=yellow` literals (except the `LoginContent.tsx` exemption).
- `pnpm run typecheck` passes.
- Manual smoke: clicking a .com → .red link from .com still appends `?sync-account=green`; clicking the same-domain link no longer appends a param.
