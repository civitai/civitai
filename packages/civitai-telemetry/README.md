# @civitai/telemetry

Prometheus metrics + OpenTelemetry span helpers for Civitai apps. A shared registry with the
`civitai_app_` prefix, typed metric registration helpers, and `withSpan()` wrappers.

## Add to an app

```jsonc
// package.json
"@civitai/telemetry": "workspace:*"
```

Transpile (raw TS): Next `transpilePackages: ['@civitai/telemetry']`, Vite `ssr.noExternal: ['@civitai/telemetry']`.
`prom-client` and `@opentelemetry/api` come in transitively.

## Env

None. (OTEL exporters are configured by the app's instrumentation entry, not this package.)

## Use

```ts
import { registerCounter, registerHistogram, withSpan } from '@civitai/telemetry';

const myCounter = registerCounter({ name: 'my_thing_total', help: 'Things processed' });
myCounter.inc();

await withSpan('expensive-op', async () => doWork());
```

Many app-specific counters/histograms are already exported (login, cache hit/miss, tRPC duration, …) —
import those rather than redefining. Expose the registry at a `/metrics` endpoint in the app.

## Gotchas

- All metrics share one `instrumentationRegistry`; register via the helpers so names get the
  `civitai_app_` prefix and stay collision-free.
- `withSpan` is a no-op unless the app set up an OTEL SDK in its instrumentation entry.
