# @civitai/buzz

Server-side client for the Civitai **buzz service** (the .NET/Postgres API at `BUZZ_ENDPOINT`).
Shared by the main app and the SvelteKit spokes so nobody hand-rolls the buzz HTTP transport.

The **client** (`createBuzzClient`) is **server-only** — the buzz service is internal (never public); do
not call it from browser code. The **account-type helpers** (`./account-types`: `toApiType`, `BuzzAccountType`,
…) are pure and browser-safe.

Ships **raw** like the other `@civitai/*` packages; consumers transpile it
(Next `transpilePackages`, Vite `ssr.noExternal`).

## Scope

The client owns the buzz **HTTP transport** (fetch + retry + status→error) and **typed per-endpoint
methods**. Account-aware methods take the app's _friendly_ account types (`yellow`/`blue`/…) and map to the
buzz API internally. Higher-level buzz _orchestration_ — balance pre-checks, entity-owner lookups, domain
co-writes — stays in the consuming app (or a future `@civitai/monetization` built on top of this).

## Use

```ts
import { createBuzzClient } from '@civitai/buzz';

const buzzService = createBuzzClient({
  // endpoint optional (defaults to BUZZ_ENDPOINT env)
  mapError: (e) => {
    /* optional: turn BuzzApiError.status into your framework's error */
  },
});

const account = await buzzService.getUserBuzzByAccountType(userId, 'yellow');
const report = await buzzService.getUserTransactionsReport(userId, query);
await buzzService.createTransaction({ fromAccountId, toAccountId, amount, type, /* … */ });
```

`createBuzzClient(options)` returns a client with typed endpoint methods:

- **reads** — `getAccount`, `getUserBuzzByAccountType`, `getUserAccounts`, `getAccountTransactions`,
  `getUserTransactionsReport`, `getAccountBalances`, `getAccountSummary`, `getContributors`,
  `getCounterparties`, `previewMultiTransaction`, `listMultiTransactions`
- **writes** — `createTransaction`, `createTransactions`, `refundTransaction`, `createMultiTransaction`,
  `refundMultiTransaction`
- **escape hatch** — `request<T>(urlPart, init?)` for any endpoint without a method yet

On a non-2xx status the client throws `BuzzApiError` (carrying `status`), or the result of `mapError` if
provided.

## Env

| Var             | Required  | Notes                                         |
| --------------- | --------- | --------------------------------------------- |
| `BUZZ_ENDPOINT` | prod only | base URL of the buzz service; optional in dev |
