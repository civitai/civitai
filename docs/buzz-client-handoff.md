# `@civitai/buzz` client — handoff

Status + context for continuing the buzz-client work in a fresh session. Part of the Creator Studio effort
(see [creator-studio-plan.md](creator-studio-plan.md) §5.1 / §7.2) — the buzz service is already external, so
this package is the shared, server-side client both the main app and the future SvelteKit spokes call.

## What exists now (done + verified)

A new package **`packages/civitai-buzz/`** (`@civitai/buzz`), and the main app refactored to use it.
`pnpm typecheck` is **green** (it exercises the widely-imported `buzz.constants.ts` facade across the whole app).

### Package layout

| File | Purpose |
|---|---|
| `src/env.ts` | Lazy/memoized `loadBuzzEnv()` → `{ endpoint }` from `BUZZ_ENDPOINT` (required prod, optional dev). |
| `src/account-types.ts` | **Browser-safe**, no deps: buzz account-type model + the pure friendly↔API name map. |
| `src/client.ts` | `createBuzzClient(options)` → typed per-endpoint client; `BuzzApiError`; `request<T>` transport. |
| `src/index.ts` | `export * from client / account-types / env`. |
| `README.md` | Usage reference. |

### Client API — `createBuzzClient(options)`

`options`: `{ endpoint?, retries=3, log?, mapError? }`. Returns:

- **reads**: `getAccount`, `getUserBuzzByAccountType`, `getUserAccounts`, `getAccountTransactions`,
  `getUserTransactionsReport`, `getAccountBalances`, `getAccountSummary`, `getContributors`,
  `getCounterparties`, `previewMultiTransaction`, `listMultiTransactions`
- **writes**: `createTransaction`, `createTransactions`, `refundTransaction`, `createMultiTransaction`,
  `refundMultiTransaction`
- **escape hatch**: `request<T>(urlPart, init?)`, plus `endpoint()`

Account-aware methods take the app's **friendly** account types (`'yellow'`/`'blue'`/…) and map to the buzz API
internally. On a non-2xx the client throws `BuzzApiError` (has `.status`), or the result of `mapError`.

`account-types.ts` also exports (browser-safe): `toApiType`, `toClientType`, `toApiTransaction`,
`clientToApiAccountType`, `buzzApiAccountTypes`, and the `BuzzAccountType` / `BuzzApiAccountType` / `BuzzSpendType`
/ … types.

## Key design decisions (don't re-litigate)

- **Package discipline (avoid sprawl)**: `@civitai/buzz` is the one thing that earns package status now (used by the
  main app broadly + creator-studio). Creator monetization ops (fee/access, kysely + this client) and analytics reads
  (ClickHouse) live as **creator-studio modules**, extracted to a package only at the full-cutover consolidation (when
  the main app adopts them). A package needs ≥2 app importers **and** to be a coherent capability — not a code-slice.
- **Server-only client, browser-safe types**: the fetch client must never run in the browser (buzz service is
  internal). The account-type helpers are pure and browser-safe by design.
- **Friendly types (chosen by the user)**: the pure name-map moved *into* the package; the app's `BuzzTypes`
  (`src/shared/constants/buzz.constants.ts`) is now a **facade** delegating `toApiType`/`toClientType`/
  `getApiTransaction` to the package, and `buzzTypeConfig.value` is sourced from the package's
  `clientToApiAccountType` (single source, no drift). All existing exports/types are re-exported, so **no
  consumer import sites changed**.
- **`mapError` hook**: keeps buzz-status → tRPC-error mapping centralized (the main app configures it once).
- **Behavior preserved**: same retry count (3), same error mapping. This was a lift, not a behavior change.

## Main-app changes

- `package.json` — added `"@civitai/buzz": "workspace:*"`.
- `next.config.mjs` — added `@civitai/buzz` to `transpilePackages`.
- `src/shared/constants/buzz.constants.ts` — `BuzzTypes` is now a facade (see above); name-map/types removed and
  re-exported from the package. `TransactionType`, `buzzTypeConfig` (UX flags), `buzzSpendTypes`/`buzzBankTypes`/
  `buzzPurchaseTypes`, `toSpendType`, `toOrchestratorType`, `buzzConstants` **stayed** in the app.
- `src/server/services/buzz.service.ts` — `buzzService = createBuzzClient({ endpoint, log, mapError })`; every
  wrapper calls a typed method (no `buzzApiFetch` alias, no local `baseEndpoint()` — both removed).

## Buzz service reference

The buzz service is a **.NET / ASP.NET Core Minimal API on PostgreSQL** at `C:\work\civitai-buzz` (ClickHouse
is only a post-commit tracking sink). Its routes are defined in `src/Civitai.Buzz.Api/Program.cs` (e.g.
`GET /account/{type}/{id}`, `GET /user/{id}/transactions/report`, `POST /transaction`, `GET /account-balances`).
The `AccountTransaction` view (`src/Civitai.Buzz.Infrastructure/Views/`) backs the earnings reads.

## What's left (follow-ups, not done)

1. ~~**Migrate remaining call sites** in `buzz.service.ts` from the `buzzApiFetch` alias to the named methods.~~
   **Done** — every call site now uses a named method (`getAccountTransactions`, `createTransaction`,
   `createTransactions`, `refundTransaction`, `createMultiTransaction`, `refundMultiTransaction`,
   `previewMultiTransaction`, `listMultiTransactions`, `getAccountSummary`, `getContributors`,
   `getCounterparties`, `getUserTransactionsReport`, `getAccountBalances`). `buzzApiFetch` is deleted.
   `getAccountSummary`/`getContributors`/`getCounterparties` gained an `opts.query` (and `opts.accountId`) so
   the app's URL-param reads fit the typed methods. Note: `createBuzzTransactionMany`'s validity filter dropped a
   provably-dead `|| fromAccountType === 'cashPending'` branch (it ran *after* the friendly→API map, so it was
   always false); behavior is unchanged, but if the intent was to keep cashPending self-transactions, that's a
   pre-existing bug to fix separately.
2. ~~**Add `ping()` and `getTransactionByExternalId()` methods**, then retire the local `baseEndpoint()`.~~
   **Done** — `ping()` (root liveness, `false` on error) and `getTransactionByExternalId()` (via `request`'s new
   `allow404` option → `null` on 404) are on the client; the two direct-`fetch` sites and `baseEndpoint()` are gone.
3. ~~**Tighten response types** — several read methods return `<T = unknown>`; define concrete response types.~~
   **Done** — `src/responses.ts` defines the buzz-service **wire** contract types (account-type fields are the
   PascalCase `BuzzApiAccountType`; dates are ISO strings — the app maps/coerces to friendly types + `Date` via
   its zod schemas). Each read method now defaults its generic `T` to the matching concrete type
   (`GetAccountTransactionsResponse`, `GetTransactionsReportResponse`, `GetAccountBalancesResponse`,
   `GetAccountSummaryResponse`, `GetContributorsResponse`, `GetCounterpartiesResponse`,
   `ListMultiTransactionsResponse`, `PreviewMultiTransactionResponse`, `BuzzTransactionResponse`), and the write
   methods return `Create*/Refund*` types. The `<T = …>` generic is kept as an escape hatch (e.g. the app still
   overrides `getCounterparties` with its friendly-typed domain view), but no call site needs to pass one for the
   default wire shape — the app's inline response types were removed in favour of these.
   - **Typed query params (done later)** — the read methods no longer take a raw `query: string`. `src/queries.ts`
     defines a typed params object per method (`GetAccountTransactionsQuery`, `GetTransactionsReportQuery`,
     `GetAccountBalancesQuery`, `GetAccountSummaryQuery`, `GetContributorsQuery`, `GetCounterpartiesQuery`,
     `PreviewMultiTransactionQuery`, `ListMultiTransactionsQuery`); the client serializes them internally
     (`toQueryString`): friendly account types → API values, `Date`s → the format each endpoint wants (full ISO for
     transactions/contributors, date-only `YYYY-MM-DD` **UTC** for report/summary), arrays → repeated keys,
     nullish/empty dropped. The app call sites now pass structured objects (no more `QS.stringify`/`URLSearchParams`
     hand-building). **Behavior note:** the report's `start`/`end` were previously formatted with dayjs in *local*
     time; they're now date-only in **UTC**, which is identical on UTC-run servers (prod) and matches how the
     summary endpoint already formatted its dates — only a non-UTC dev box could see a one-day shift.
4. **Consume from creator-studio** — when that app exists, import `@civitai/buzz` in its **server** code
   (`+page.server.ts` / `+server.ts`) for account/transaction operations. Server-only; never in a `.svelte`
   component. **Note (Justin):** analytics + earnings dashboards read from **ClickHouse** (daily aggregates /
   materialized views), *not* the buzz client's report endpoints — the buzz service is too slow for that path.
5. **Docs** — mark `@civitai/buzz` as built (a full client) in
   [creator-studio-overview.md](creator-studio-overview.md) / [creator-studio-plan.md](creator-studio-plan.md).

## Verify

```bash
pnpm run typecheck   # green
# lint: use `pnpm run lint` (full repo) — invoking eslint on individual files hits a repo config quirk
```
