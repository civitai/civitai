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
| `{allow: false, cause: "timeout", detail}`        | stopped by the interrupt handler at its deadline (including an interrupt the engine swallowed, for example inside `Error.prepareStackTrace`)         | same                                      |
| `{allow: false, cause: "oom", detail}`            | exceeded the 16 MiB heap (the engine's own out-of-memory error, identified by prototype; a look-alike thrown by the hook is `error`)                 | same                                      |
| `{allow: false, cause: "stack_overflow", detail}` | exceeded the stack cap                                                                                                                               | same                                      |
| `{allow: false, cause: "invalid_result", detail}` | returned anything but the two valid shapes, including a Promise                                                                                      | same                                      |

`detail` is for the author's logs, never for end users. `reason` is author text shown to users.
It is clipped to its first 400 UTF-16 units (bounding the work; a high surrogate left at the cut
is dropped), then control characters, bidi marks and controls, U+2028/U+2029 and U+FEFF are
stripped, then it is truncated to 200 code points. If nothing but whitespace is left, the result
is `invalid_result` with detail `deny reason is empty`.

**Author fault versus runner fault.** Every 200 `result` above is the AUTHOR's: the hook's own
code produced it, and a refusal is `hook_rejected`. A non-2xx answer is a RUNNER fault: the
runner could not produce a trustworthy answer, and the caller says `hook_unavailable`. In
particular, these are runner faults, never `timeout`:

- the worker **backstop** firing (`worker_terminated`, 500): the interrupt handler is what bounds
  a hook's time, so a call that outran it by 100 ms means native work that never polled it or a
  worker starved of CPU, and the author is not blamed for either;
- a failure creating or disposing the call's QuickJS runtime or context (`worker_crashed`, 500):
  the call's computed answer is discarded, never returned, so it can never leak an allow;
- a full queue or an app over its share of it (`overloaded`, 503).

The time budget covers the hook's EVALUATION only. The source is compiled once with the deadline
disarmed, and the evaluation compiles it again (quickjs-emscripten cannot run an already compiled
module), which can run slower than the first. So the effective deadline, counted from the end of
that first compile, is

`timeoutMs + COMPILE_ALLOWANCE_FACTOR × compileMs + COMPILE_ALLOWANCE_FLOOR_MS`

where `compileMs` is the measured first compile (constants in `src/limits.ts`).

**Caller timeout.** A client-side timeout must allow for the compile allowance plus the backstop,
not just `timeoutMs`. The backstop answers 500 at `timeoutMs + BACKSTOP_MS` after the call reaches
a worker, which also caps the compile allowance, so size the client timeout as at least
`timeoutMs + BACKSTOP_MS`, plus time queued behind other calls and the network round trip.

Non-2xx answers mean the runner did not evaluate. The caller maps every one of them, and any
transport failure or unverifiable response, to `hook_unavailable` (fail closed):

| status | `error.code`                                      |
| ------ | ------------------------------------------------- |
| 400    | `bad_request`, `source_too_large`, `sha_mismatch` |
| 401    | `bad_signature`, `stale_timestamp`                |
| 413    | `body_too_large` (256 KiB)                        |
| 500    | `worker_crashed`, `worker_terminated`             |
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
`fetch`, timers, `queueMicrotask`, `performance`, `InternalError`, `console`, `process`, or any
host function.
Every call gets a fresh QuickJS runtime and context, so nothing a hook can see (globals, module
state, prototype changes, heap objects) carries over from one call to the next.

## Isolation and limits

All bounds live in `src/limits.ts`.

| bound    | value                                              | enforced by                                                                                                     |
| -------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| heap     | 16 MiB                                             | `runtime.setMemoryLimit`                                                                                        |
| stack    | 256 KiB                                            | `runtime.setMaxStackSize` (see below)                                                                           |
| time     | `timeoutMs`, [1, 500], default 50, evaluation only | interrupt handler (uncatchable; `catch`/`finally` cannot resume; a swallowed interrupt still ends as `timeout`) |
| backstop | `timeoutMs` + 100 ms                               | the pool terminates and replaces the worker; answered 500                                                       |
| per app  | ⌈`MAX_QUEUE` / 4⌉ calls queued plus in flight      | the pool; past it that app gets 503 while others proceed                                                        |
| source   | 64 KiB                                             | request validation                                                                                              |
| body     | 256 KiB                                            | Fastify `bodyLimit`                                                                                             |

- **A fresh QuickJS runtime per call, inside one shared WebAssembly instance per worker.** The
  QuickJS WASM is compiled once per worker and instantiated once; each call creates and disposes
  its own runtime and context, which own every JS-visible object. This was chosen for latency: a
  fresh instance per call measured p50 3.05 / p99 35.7 ms against 0.71 / 4.96 ms for a fresh
  runtime (1 KiB hook, one CI run). The accepted residual
  risk: calls on one worker share the instance's linear memory, so a QuickJS memory-safety bug
  could read freed memory from an earlier call.
- **When the shared instance is replaced.** After a call that leaves the VM other than by a clean
  in-VM exception: a throw out of the WASM boundary (a WASM trap, a host stack overflow), a
  failure creating the runtime or context, a failure disposing them, or a failed instantiation.
  The instance's state is unknown after those, so the worker instantiates a new one. A trap during
  the hook's own run still answers with the author's refusal; the others are runner faults (500). A throw, out of memory, an in-VM
  stack overflow or the interrupt are clean exceptions and keep the instance; tests pin that the
  next call on the same worker behaves normally after each of them.
- **No bytecode cache.** quickjs-emscripten 0.32.0 has no public bytecode serialise API, and
  caching a runtime would break isolation, so the hook is compiled on every call (the benchmark measures that
  at 1 KiB and 64 KiB).
- **Why 256 KiB of stack, not 512.** Measured on Node 24.21: with 512 KiB QuickJS recurses deeper
  than the host V8 stack allows, so unbounded recursion overflows the host instead of raising
  in-VM. 256 KiB raises in-VM at ~1,486 frames. A host overflow is still caught, answered as
  `stack_overflow`, and the worker's instance is replaced.
- **Why a backstop.** The interrupt handler runs only when QuickJS polls it. A single native
  operation does not: an allocation loop near the heap cap was measured running 1.3 s with one
  poll against a 50 ms deadline. The backstop bounds that case, and answers it as a runner fault
  (500 `worker_terminated`).
- Worker pool: `POOL_SIZE` workers, one evaluation each, plus a FIFO queue of `MAX_QUEUE`
  (default 64); past it the answer is 503. The `POOL_SIZE` default is the container's CPU quota
  (cgroup v2 `/sys/fs/cgroup/cpu.max`, rounded up, capped at the cores Node sees), else
  `availableParallelism()`: that alone reports the node's cores, which would start one worker
  per node core in a 1-CPU pod. One app may hold at most `MAX_PER_APP` (default ⌈`MAX_QUEUE` /
  4⌉) calls queued plus in flight.
- Worker replacement: a worker that dies while serving, or is terminated by the backstop, is
  replaced at once. A replacement that fails to start is retried with exponential backoff (100 ms
  doubling to 30 s). A worker that fails during the initial start fails startup instead.

## Operations

| route            | port                  | meaning                                                                                                                                                                                                                                                                                                        |
| ---------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /v1/check` | `PORT` (8080)         | evaluate                                                                                                                                                                                                                                                                                                       |
| `GET /healthz`   | `PORT`                | liveness: 503 once the pool has had no ready worker for 30 s (replacements keep failing), so the pod is restarted                                                                                                                                                                                              |
| `GET /readyz`    | `PORT`                | at least one worker is ready, and the built-in self-test hooks (allow, deny, an infinite loop stopped by the interrupt handler) answer correctly. The self-test runs on its own QuickJS instance on the request thread, not through the pool, so a saturated pool is still ready; its result is reused for 5 s |
| `GET /metrics`   | `METRICS_PORT` (9091) | Prometheus                                                                                                                                                                                                                                                                                                     |

Metrics:

- `storage_hook_runner_calls_total{app,collection,op,outcome}`: outcome is `allow`, `deny` or a
  fault cause.
- `storage_hook_runner_call_duration_seconds{outcome}`: evaluation time inside the worker.
- `storage_hook_runner_sig_rejected_total{reason}`: `bad_signature`, `stale_timestamp`.
- `storage_hook_runner_requests_refused_total{reason,app}`: other non-2xx answers. `app` is empty
  until the request is authenticated and validated.
- `storage_hook_runner_worker_terminated_total{app}`: backstop terminations.
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
instances.

The benchmark, `src/__tests__/benchmark.test.ts`, is skipped unless `RUNNER_BENCH=1` is set, so
CI does not run it. Run it with:

```sh
RUNNER_BENCH=1 pnpm --filter @civitai/storage-hook-runner-app exec vitest run src/__tests__/benchmark.test.ts
```

It prints `BENCH` lines with per-call p50/p99 (runtime-per-call as the runner does it, a fresh
instance per call for comparison, and end to end over HTTP) and asserts only correctness.
