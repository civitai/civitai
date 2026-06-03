# On-demand V8 CPU profiling for civitai-web pods

Capture a real V8 CPU profile from a running civitai-dp-prod (or any civitai-web)
pod that is CPU-saturating the single Node thread, so we can see which JS
functions actually burn the CPU during a saturation wave.

## Why this exists

civitai-dp-prod API pods periodically peg the Node main thread at ~1.0 core
during traffic waves. The event loop then can't answer health probes in time
and the pod is SIGKILLed. The CPU consumer is **not** visible in any
instrumented span (the slow image feeds are I/O-bound on Meilisearch; superjson
is ~10ms). The only way to identify it is a V8 CPU profile taken on a saturated
pod.

The deployment previously had **no** CPU-profile mechanism — `NODE_OPTIONS` only
carried `--heapsnapshot-signal=SIGUSR2` (heap, not CPU).

## Mechanism

A signal handler registered at server startup (in `src/server/cpu-profiler.ts`,
armed from `src/instrumentation.node.ts`) uses the in-process `node:inspector`
`Session` API: `Profiler.enable` → `Profiler.start` → wait `CPU_PROFILE_SECONDS`
→ `Profiler.stop` → write the `.cpuprofile` JSON to disk.

- **Zero steady-state overhead.** Nothing runs until the signal arrives.
- **In-process** — does NOT require the inspector port (`:9229`) to be open.
- **Safe** — a second signal during an in-flight capture is ignored; all work is
  wrapped in try/catch so a profiling failure can never crash the process; the
  capture timer is `unref`'d so it never blocks shutdown. Server-side (nodejs
  runtime) only.

### Signal choice (important)

The obvious signals are both taken on these pods:

- **SIGUSR2** is claimed by Node's `--heapsnapshot-signal=SIGUSR2` flag.
- **SIGUSR1** is Node's built-in "open the inspector port" signal. The cluster
  `heap-snapshot` skill relies on it: `kubectl exec <pod> -- kill -USR1 1` opens
  `:9229`, then drives `HeapProfiler.takeHeapSnapshot` over CDP. Registering a
  userland `SIGUSR1` listener would **override** that default and break heap
  snapshots.

So the default trigger is **`SIGWINCH`** — a no-op for a non-TTY server process
that Kubernetes never sends. It is overridable via `CPU_PROFILE_SIGNAL`.

## Tunables (env vars, no rebuild needed)

| Env var               | Default     | Meaning                                  |
| --------------------- | ----------- | ---------------------------------------- |
| `CPU_PROFILE_SECONDS` | `25`        | Capture duration in seconds              |
| `CPU_PROFILE_SIGNAL`  | `SIGWINCH`  | Signal that triggers a capture           |
| `CPU_PROFILE_DIR`     | `/tmp`      | Output directory (must be writable)      |

`/tmp` is the right default: the container's cwd (`/app`) is **read-only** in
the Next.js standalone image (this is also why heap snapshots go to `/tmp`).
`/tmp` is writable and `tar` is present in the image, so `kubectl cp` works.

## How to trigger

PID 1 is the Node process in these pods.

```bash
POD=$(kubectl get pods -n civitai-dp-prod -l app=civitai-dp-prod-api \
  --field-selector status.phase=Running -o name | head -1 | cut -d/ -f2)

# (optional) pick the hottest pod instead:
kubectl top pods -n civitai-dp-prod --sort-by=cpu | head

# Fire the capture (default SIGWINCH). The handler logs start + the exact path.
kubectl exec -n civitai-dp-prod "$POD" -- kill -WINCH 1

# Watch for the start/complete log lines (they include the full file path):
kubectl logs -n civitai-dp-prod "$POD" --tail=20 | grep cpu-profiler
```

The capture runs for `CPU_PROFILE_SECONDS` (default 25s). The completion log line
prints the exact filename and the retrieval command.

## Where the file lands

`/tmp/cpu-<podname>-<ISO8601>.cpuprofile` inside the pod, e.g.
`/tmp/cpu-civitai-dp-prod-api-7499d9d7f-d9khv-2026-06-03T13-52-01-123Z.cpuprofile`.

## How to retrieve

`curl` is **absent** from the container, but `tar` is present, so `kubectl cp`
works:

```bash
FILE=$(kubectl exec -n civitai-dp-prod "$POD" -- sh -c 'ls -t /tmp/*.cpuprofile | head -1')
kubectl cp "civitai-dp-prod/${POD}:${FILE}" "./$(basename "$FILE")"
```

(`kubectl cp` strips a leading `/`; if it complains, pass the path without the
leading slash: `civitai-dp-prod/${POD}:tmp/...`.)

## How to view

- **Chrome DevTools**: open DevTools → **Performance** tab → "Load profile…" →
  select the `.cpuprofile`. The bottom-up / call-tree views show self-time hot
  functions.
- **speedscope**: drag the file onto <https://speedscope.app> (runs fully
  client-side). The "Left Heavy" view is the fastest way to spot the dominant
  CPU consumer.

## Deployment wiring (datapacket-talos)

To override the duration without a rebuild, add to the API deployment's `env:`
in `clusters/production/apps/civitai-dp-prod/deployment-api.yaml`:

```yaml
- name: CPU_PROFILE_SECONDS
  value: "30"
```

No NODE_OPTIONS change is required — the profiler arms itself from the
instrumentation hook on every server start.
