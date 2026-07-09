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

| Var | Notes |
|---|---|
| `AXIOM_TOKEN` | Axiom ingest token |
| `AXIOM_ORG_ID` | Axiom org |
| `AXIOM_DATASTREAM` | default datastream |
| `PODNAME` | tags each event with the pod |

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
