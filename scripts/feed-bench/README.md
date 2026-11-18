# Image feed benchmark

Is the latency feed-go saves on `image.getImagesAsPostsInfinite` Node itself, or what the main app
wraps around the procedure (Next.js, tRPC, a process shared with every other endpoint)? Three arms,
the same replayed requests, the same rate, identically sized pods, each arm otherwise idle:

| arm    | what serves the request                                                                                                                                                              |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `go`   | feed-go (`apps/feed-go`), its public listener                                                                                                                                        |
| `node` | `server.cjs` here: a bare `node:http` server that calls the procedure's code directly (`src/server/feed-bench/images-as-posts-standalone.ts`) — no Next.js request handling, no tRPC |
| `next` | the web image as the API pools run it (Next.js + the tRPC route), serving nothing else                                                                                               |

`node` and `next` run the SAME image: `server.cjs` loads the compiled page module
`/api/internal/feed-bench` (a 404 under Next) and calls the function its default export carries, so
both arms run the same build of the same modules, with the same `instrumentation.ts` boot. The
standalone function's doc lists exactly what it keeps and drops from the tRPC path;
`src/server/feed-bench/__tests__/images-as-posts-standalone.parity.test.ts` pins that it answers
the tRPC route's bytes for feed-go's golden inputs.

The difference `next - node` is the Next.js + tRPC cost; `node - go` is Node against Go for the same
work; the captured in-situ span durations against `next` show what sharing a pool with other
endpoints adds (garbage collection and event-loop contention included).

## Harness (`bench.cjs`)

```bash
# 1. Capture: production requests from head-sampled traces in Tempo, written as JSONL
#    { t, host, input, durMs }: no address, user agent, cookie or user id is kept.
node feed-bench/bench.cjs capture --tempo <tempo-url> --minutes 60 --out /data/inputs.jsonl

# 2. Parity: a sample of inputs to every arm back to back; bodies compared (first target = reference).
node feed-bench/bench.cjs parity --inputs /data/inputs.jsonl --sample 200 \
  --target next=<url> --target node=<url> --target go=<url>

# 3. Run: warm-up pass on every arm (in the order given), idle CPU baseline, then --rounds rounds
#    with the arm order rotated, each arm replaying the same --count inputs at --rps (open loop).
node feed-bench/bench.cjs run --inputs /data/inputs.jsonl --rps 2 --count 3600 --rounds 3 \
  --target next=<url> --target node=<url> --target go=<url> \
  --prom <prometheus-url> --cpu 'next=namespace="…",pod=~"…",container="…"' … --out /data/run1
```

Requests are replayed **signed out**: no session can be replayed without a user's credential, and a
signed-out request takes the same path through all three arms. Each carries the captured `Host` and
a same-site `Referer` (both origin checks need one).

Latency is compared only over the requests every arm answered 200 in that round (`commonOk`): a
feed-go fallback (it proxies a shape it does not port) or an error on one arm removes that request
from all three. `allOkLatency` keeps each arm's own 200s. CPU per request is the container's CPU
over the run, less its idle rate, over the requests sent (`lib.cjs` `cpuPerRequestMs`).

Pure logic is in `lib.cjs` (tested in `__tests__/lib.test.ts`); `bench.cjs` is the I/O around it.
