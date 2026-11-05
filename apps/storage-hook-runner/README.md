# storage-hook-runner

Evaluates App Storage **permission hooks**: a small, author-written JavaScript module that an app
declares per collection and that decides whether a write may proceed. The civitai write path calls
this service once per hooked write; the hook never runs inside the civitai web process.

The runner is a pure function service. It holds no data, opens no connections and needs no
network egress: civitai sends the hook source with every call and the runner checks it against
the sha256 the approved manifest pinned.

## Contract

### Request: `POST /v1/check`

Header `x-storage-hook-sig: hex(HMAC-SHA256(secret, rawBody))`. Body (JSON, strict: unknown or
missing fields are a 400):

| field        | type                                                               | notes                                                                                                                     |
| ------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `ts`         | integer                                                            | unix seconds, inside the signed body; must be within ±60 s of the runner's clock                                          |
| `appId`      | string                                                             | the app's blockId                                                                                                         |
| `collection` | string                                                             |                                                                                                                           |
| `op`         | `create` \| `put` \| `delete` \| `increment` \| `mark` \| `unmark` |                                                                                                                           |
| `sha256`     | 64 lowercase hex                                                   | must equal sha256 of the UTF-8 bytes of `source`                                                                          |
| `source`     | string                                                             | the hook module, at most 64 KiB (UTF-8)                                                                                   |
| `timeoutMs`  | number, optional                                                   | clamped to [1, 500]; default 50                                                                                           |
| `input`      | object                                                             | the hook's argument, below; `input.op`, `input.collection` and `input.app.blockId` must match `op`, `collection`, `appId` |

`input` (every key present; `null` where there is nothing):

```ts
{
  op, collection,
  key: string,                       // pre-generated for create
  before: Json | null,               // stored data before the write
  after: Json | null,                // data after the write (null for delete and tally ops)
  doc: Record<string, unknown> | null, // stored doc metadata (version, author kind, counters, marks)
  tally: { kind: 'counter', name, by } | { kind: 'mark', name } | null,
  viewer: { userId: number },
  app: { blockId: string },
  from: string | null,               // importing app's blockId on an imported write
}
```

### Response

Every response, success or refusal, is signed the same way in `x-storage-hook-sig` and carries
`ts` and `req` = sha256 of the raw request body, so a response cannot be forged by a spoofed
responder or replayed onto another request. The caller must verify both.

`200`:

```json
{ "ts": 1800000000, "req": "<sha256 of request body>", "elapsedMs": 0.7, "result": <result> }
```

| `result`                                          | meaning                                                                                                                                              | caller maps to                            |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `{allow: true}`                                   | the write may proceed                                                                                                                                | write                                     |
| `{allow: false, cause: "denied", reason}`         | the hook refused                                                                                                                                     | `hook_rejected` with `reason`             |
| `{allow: false, cause: "error", detail}`          | the hook threw, failed to load (syntax error, `import`, a `ReferenceError` such as `fetch`), has no default export function, or used top-level await | `hook_rejected`, generic reason, refunded |
| `{allow: false, cause: "timeout", detail}`        | interrupted at `timeoutMs`, or cut by the worker backstop                                                                                            | same                                      |
| `{allow: false, cause: "oom", detail}`            | exceeded the 16 MiB heap                                                                                                                             | same                                      |
| `{allow: false, cause: "stack_overflow", detail}` | exceeded the stack cap                                                                                                                               | same                                      |
| `{allow: false, cause: "invalid_result", detail}` | returned anything but the two valid shapes, including a Promise                                                                                      | same                                      |

`detail` is for the author's logs, never for end users. `reason` is author text shown to users:
control and bidi-override characters are stripped, then it must be 1 to 200 code points and not
blank, or the result is `invalid_result` (an over-long reason is refused, not truncated).

Non-2xx answers mean the runner did not evaluate. The caller maps every one of them, and any
transport failure or unverifiable response, to `hook_unavailable` (fail closed):

| status | `error.code`                                      |
| ------ | ------------------------------------------------- |
| 400    | `bad_request`, `source_too_large`, `sha_mismatch` |
| 401    | `bad_signature`, `stale_timestamp`                |
| 413    | `body_too_large` (256 KiB)                        |
| 500    | `worker_crashed`                                  |
| 503    | `overloaded`, `shutting_down`                     |

### The hook

One self-contained ES module whose **default export** is a synchronous function:

```js
export default function check({ op, before, after, tally }) {
  if (before && before.locked) return { allow: false, reason: `${op}: card is locked` };
  if (tally && tally.kind === 'counter' && tally.by > 1)
    return { allow: false, reason: 'one at a time' };
  return { allow: true };
}
```

Available: ECMAScript built-ins only (the QuickJS-NG engine). Not available: `import`, `require`,
`fetch`, timers, `queueMicrotask`, `performance`, `console`, `process`, or any host function.
Every call gets a fresh engine, so nothing (globals, module state, prototype changes) carries over
from one call to the next.

## Isolation and limits

All bounds live in `src/limits.ts`.

| bound    | value                             | enforced by                                                      |
| -------- | --------------------------------- | ---------------------------------------------------------------- |
| heap     | 16 MiB                            | `runtime.setMemoryLimit`                                         |
| stack    | 256 KiB                           | `runtime.setMaxStackSize` (see below)                            |
| time     | `timeoutMs`, [1, 500], default 50 | interrupt handler (uncatchable; `catch`/`finally` cannot resume) |
| backstop | `timeoutMs` + 100 ms              | the pool terminates and replaces the worker                      |
| source   | 64 KiB                            | request validation                                               |
| body     | 256 KiB                           | Fastify `bodyLimit`                                              |

- **A fresh WebAssembly instance per call.** The QuickJS WASM is compiled once per worker; each
  call instantiates it anew, so calls do not share linear memory. A fresh _runtime_ inside a
  shared instance is cheaper but would leave one call's memory readable to a QuickJS
  memory-safety bug in the next. The benchmark measures both.
- **No bytecode cache.** quickjs-emscripten 0.32.0 has no public bytecode serialise API, and
  caching a runtime would break isolation, so the hook is compiled on every call (measured below
  at 1 KiB and 64 KiB).
- **Why 256 KiB of stack, not 512.** Measured on Node 24.21: with 512 KiB QuickJS recurses deeper
  than the host V8 stack allows, so unbounded recursion overflows the host instead of raising
  in-VM. 256 KiB raises in-VM at ~1,486 frames. A host overflow is still caught and answered as
  `stack_overflow`.
- **Why a backstop.** The interrupt handler runs only when QuickJS polls it. A single native
  operation does not: an allocation loop near the heap cap was measured running 1.3 s with one
  poll against a 50 ms deadline. The backstop bounds that case.
- Worker pool: `POOL_SIZE` workers (default `availableParallelism()`), one evaluation each, plus a
  FIFO queue of `MAX_QUEUE` (default 64); past it the answer is 503.

## Operations

| route            | port                  | meaning                                                                                                                              |
| ---------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /v1/check` | `PORT` (8080)         | evaluate                                                                                                                             |
| `GET /healthz`   | `PORT`                | process up                                                                                                                           |
| `GET /readyz`    | `PORT`                | a worker is ready and the built-in self-test hooks (allow, deny, an infinite loop stopped by the interrupt handler) answer correctly |
| `GET /metrics`   | `METRICS_PORT` (9091) | Prometheus                                                                                                                           |

Metrics:

- `storage_hook_runner_calls_total{app,collection,op,outcome}`: outcome is `allow`, `deny` or a
  fault cause.
- `storage_hook_runner_call_duration_seconds{outcome}`: evaluation time inside the worker.
- `storage_hook_runner_sig_rejected_total{reason}`: `bad_signature`, `stale_timestamp`.
- `storage_hook_runner_requests_refused_total{reason}`: other non-2xx answers.
- `storage_hook_runner_worker_terminated_total`: backstop terminations.
- `storage_hook_runner_pool_workers{state}`, `storage_hook_runner_queue_depth`.

Environment: see `.env.example`. `STORAGE_HOOK_RUNNER_SECRET` (at least 32 characters) is
required; it signs requests (caller side) and responses (here).

The service needs no egress at all. Deployment manifests are kept outside this repository.

## Build and release

```sh
pnpm --filter @civitai/storage-hook-runner-app build      # tsup → dist/server.js + dist/worker.js
docker build -f apps/storage-hook-runner/Dockerfile -t civitai-storage-hook-runner .
```

The image is built from a `storage-hook-runner-vX.Y.Z` tag, as the other apps in this repo are.

## Tests

`pnpm --filter @civitai/storage-hook-runner-app test` (vitest, project `app:storage-hook-runner`;
CI runs it in the "App suites" workflow). The suites use real worker threads and real WASM
instances; `src/__tests__/benchmark.test.ts` prints `BENCH` lines with per-call p50/p99 and
asserts only correctness.
