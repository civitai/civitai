# Multi-Host Per ColorDomain (Aliases)

## Background

Each `ColorDomain` (`green`, `blue`, `red`) historically mapped to exactly one
host via `SERVER_DOMAIN_<COLOR>`. We now allow each color to expose multiple
hostnames so that, for example, both `civitai.com` and `civitai.blue` can
resolve to the `blue` color on inbound requests.

## Model

Per color:

- **`primary`** — the canonical host. Used for every outbound URL
  (sync-account redirects, `getBaseUrl`, sitemap, region-redirect target,
  cookie-bounce links). Never an alias.
- **`aliases`** — additional hosts that resolve to the same color on inbound
  requests. Aliases never appear in outbound URLs.

## Env Configuration

```env
SERVER_DOMAIN_BLUE=civitai.com               # canonical (existing)
SERVER_DOMAIN_BLUE_ALIASES=civitai.blue      # comma-separated (new, optional)
SERVER_DOMAIN_GREEN=civitai.green
SERVER_DOMAIN_GREEN_ALIASES=                 # optional
SERVER_DOMAIN_RED=civitai.red
SERVER_DOMAIN_RED_ALIASES=                   # optional
```

## OAuth on Alias Hosts

Each OAuth provider has different per-host requirements. The redirect URI
sent to the provider includes the alias host, so an alias generally needs
its own client credentials registered with the provider.

**Resolution order:**

- **Primary host:** prefer `<PROVIDER>_CLIENT_ID_<COLOR>` /
  `<PROVIDER>_CLIENT_SECRET_<COLOR>` (per-color override). Fall back to the
  global `<PROVIDER>_CLIENT_ID` / `<PROVIDER>_CLIENT_SECRET`.
- **Alias host:** require `<PROVIDER>_AUTH_<aliasSlug>=<id>,<secret>`. **No
  default fallback** — providers without an alias-keyed credential are
  hidden on the alias's login page.

`aliasSlug` lowercases the host and replaces every non-alphanumeric character
with `_`. e.g. `civitai.blue` → `civitai_blue`.

```env
# Example: civitai.blue alias of blue, with Discord + Google OAuth registered
SERVER_DOMAIN_BLUE_ALIASES=civitai.blue
DISCORD_AUTH_civitai_blue=<discord_alias_client_id>,<discord_alias_secret>
GOOGLE_AUTH_civitai_blue=<google_alias_client_id>,<google_alias_secret>
# Reddit not registered → Reddit button hidden on civitai.blue
```

When a provider is hidden on an alias, the login page renders a "Continue on
`<primary>`" button that bounces the user through the canonical host. The
canonical login picks any provider, then sync-account brings the session back
to the alias.

## Cookie Behavior

eTLD+1 differs between aliases (`civitai.com` vs `civitai.blue`), so session
cookies are not shared across aliases. The existing `sync-account` flow
covers cross-host hops; same-color aliases use it just like cross-color hops
do today.

## Inbound Resolution

`getRequestDomainColor(req)` walks every color's primary + aliases. Earliest
declared color in `colorDomainNames` wins on ambiguity (green → blue → red).

Localhost fallback (request to `localhost:<port>` with no exact host match)
picks the first color whose primary is also configured as localhost, mirroring
the previous behavior.

## Outbound URLs

Always use the canonical primary. `useServerDomains()` plucks
`primary` from each color's config; `getBaseUrl(color)` reads from
`serverDomainPrimaryMap`. The `useDomainSync` hook short-circuits when the
current host belongs to the destination color's alias set, since same-color
hops don't need a sync round-trip.

## Touch Points

| Layer | File | Change |
|---|---|---|
| Type | `src/shared/constants/domain.constants.ts` | New `DomainConfig`, `ServerDomains`, `ServerDomainPrimaryMap` types + `aliasSlug` helper |
| Env | `src/env/server-schema.ts` | New `SERVER_DOMAIN_<COLOR>_ALIASES` vars |
| Resolver | `src/server/utils/server-domain.ts` | Alias-aware `getRequestDomainColor`, helpers (`getAllServerHosts`, `getHostsForColor`, `isHostForColor`, `isPrimaryHost`, `resolveOAuthCredentialsForHost`, `getAvailableOAuthProviders`) |
| Allowlists | `src/server/createContext.ts`, `src/server/utils/endpoint-helpers.ts`, `src/pages/_app.tsx`, `next-sitemap.config.js`, `src/server/middleware/region-restriction.middleware.ts`, `src/server/services/feature-flags.service.ts` | Walk all hosts (primary + aliases) |
| Outbound | `src/server/utils/url-helpers.ts`, `src/providers/AppProvider.tsx`, `src/utils/sync-account.ts`, `src/hooks/useDomainSync.tsx` | Canonical-only URLs; alias-aware short-circuit |
| Auth | `src/server/auth/next-auth-options.ts` | Per-host provider filtering + alias-keyed credential lookup |
| UI | `src/components/Login/LoginContent.tsx` | Filter providers list, render "Continue on `<primary>`" fallback button on alias hosts |
| Docs | `.claude/skills/rgb-proxy/SKILL.md` | Local alias testing instructions |

## Out-of-Scope (Operational)

- Cloudflare DNS for alias hosts — handled separately.
- OAuth provider callback URL registration for alias hosts — handled
  separately.
- `rgb-proxy` repo (sibling repo) does not currently auto-register alias
  hosts. Add a `proxy.register()` line per alias to `rgb-proxy/index.mjs`
  manually for local testing.
