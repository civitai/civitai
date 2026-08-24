# @civitai/axiom

Structured logging to Axiom for Civitai apps. Writes a stderr line (for Loki ingest) plus an Axiom event
in production; degrades to stderr-only when Axiom isn't configured.

## Add to an app

```jsonc
// package.json
"@civitai/axiom": "workspace:*"
```

Transpile (raw TS): Next `transpilePackages: ['@civitai/axiom']`, Vite `ssr.noExternal: ['@civitai/axiom']`.

## Env

All optional — without a token the logger is stderr-only.

| Var                       | Notes                                                                    |
| ------------------------- | ------------------------------------------------------------------------ |
| `AXIOM_TOKEN`             | Axiom ingest token                                                       |
| `AXIOM_ORG_ID`            | Axiom org                                                                |
| `AXIOM_DATASTREAM`        | default datastream                                                       |
| `AXIOM_EXTRA_DATASTREAMS` | comma-separated; **widens** the provisioned-dataset allowlist (add-only) |
| `PODNAME`                 | tags each event with the pod                                             |

## Use

```ts
import { createAxiomLogger, safeError } from '@civitai/axiom';

const logger = createAxiomLogger();
await logger.logToAxiom({ name: 'sysredis-fail-open', error: safeError(err) });
```

## Gotchas

- The **stderr line fires before** the Axiom-null/datastream guards on purpose — Loki ingest depends on it,
  so it must emit even when Axiom is null (preview) or degraded. Don't "optimize" that ordering away.
- Only logs to Axiom when `NODE_ENV=production`; dev is stderr-only regardless of token.
- 🔴 **A datastream must name a dataset that EXISTS.** Axiom does not create one on ingest, so an
  unprovisioned name is rejected on every write, forever, reported only as `reason: "error"` — a
  category it shares with every transient fault. The allowlist in `src/datastreams.ts` is the
  checkable form of that requirement: a name outside it never reaches `ingestEvents` and is reported
  once per process as `axiom-datastream-unprovisioned`. The event still reaches stderr → the log
  store in full, so nothing is lost.
- 🔴 **Adding or removing a datastream argument anywhere in the repo means updating a ledger.**
  `src/server/logging/__tests__/axiom-datastream-ledger.test.ts` enumerates every datastream literal
  reachable from production code and fails when that set **grows** (a name that is neither
  provisioned nor ledgered) **or shrinks** (a ledgered name that no longer appears, so the reasoning
  recorded beside it has gone stale). The test tells you which of the three fixes you want.
- **Not everything that ships to Axiom goes through this package** — `apps/event-engine` uses
  `@axiomhq/pino` directly and is outside the guard. Its default dataset is provisioned, so nothing
  is broken there today; it simply is not covered by the allowlist or the ledger.
