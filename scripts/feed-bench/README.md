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
standalone function's doc lists the steps it keeps and what the tRPC path adds around them;
`src/server/feed-bench/__tests__/images-as-posts-standalone.parity.test.ts` pins that it answers
the tRPC route's bytes for feed-go's golden inputs.

The difference `next - node` is the Next.js + tRPC cost; `node - go` is Node against Go for the same
work; the captured in-situ span durations of the Next pool against `next` show what sharing a pool
with other endpoints adds (garbage collection and event-loop contention included).

## Harness (`bench.cjs`)

```bash
# 1. Capture: production requests served by the Next pool, from head-sampled traces in Tempo, as
#    JSONL { t, host, input, authed, durMs }: no address, user agent, cookie or user id is kept.
#    Also writes <out>.prod.json: that pool's in-situ p50 and feed-go's served p50, same window.
node feed-bench/bench.cjs capture --tempo <tempo-url> --minutes 60 --out /data/inputs.jsonl

# 2. Parity: a sample of inputs to every arm back to back; bodies compared (first target = reference).
FEED_BENCH_SESSION_FILE=<file> node feed-bench/bench.cjs parity --inputs /data/inputs.jsonl \
  --sample 200 --target next=<url> --target node=<url> --target go=<url>

# 3. Run: warm-up pass on every arm (in the order given), idle CPU baseline, then --rounds rounds
#    with the arm order rotated, each arm replaying the same --count inputs at --rps (open loop).
FEED_BENCH_SESSION_FILE=<file> node feed-bench/bench.cjs run --inputs /data/inputs.jsonl \
  --rps 2 --count 1200 --rounds 3 --target next=<url> --target node=<url> --target go=<url> \
  --prom <prometheus-url> --cpu 'next=namespace="…",pod=~"…",container="…"' … --out /data/run1
```

**Signed in by default**, as a dedicated bench account with its own real session (no special
roles), so the replay takes the signed-in path production's feed-go cohort takes. The session is
read from the file `FEED_BENCH_SESSION_FILE` names: one `Cookie` header value
(`<session-cookie-name>=<token>`) for every host, or a JSON object mapping each host to its value
(the session cookie's name depends on the site's cookie mode). It is sent to all three arms and is
never printed, logged or written. Only captured rows the web client sent signed in (`authed: true`)
on a host the session covers are replayed. `--signed-out` replays every row with no cookie, for
comparison. Each request also carries the captured `Host` and a same-site `Referer` (both origin
checks need one).

Fails instead of reporting: 0 captured rows, fewer usable rows than `--count`/`--sample`, a round
where no request was answered 200 by every arm, a NaN latency or CPU figure, or a parity pair that
compared nothing.

**Parity** counts, per arm against the reference, `bytesEqual` (identical bytes), `jsonEqual`
(identical parsed JSON, key order ignored) and `valueEqual` (identical after each superjson envelope
is decoded as the client decodes it: an undefined member written as `null` plus an `["undefined"]`
annotation equals an omitted one; other annotations compared as sets). `examples` are the decoded
diffs' paths. `valueEqual` is the one that says whether the client sees the same response.

Latency is compared only over the requests every arm answered 200 in that round (`commonOk`): a
feed-go fallback (it proxies a shape it does not port) or an error on one arm removes that request
from all three. `allOkLatency` keeps each arm's own 200s. Container CPU cannot be split by request,
so each arm-run reports it both ways — per request sent (`msPerSent`) and per request answered 200
(`msPerOk`) — with the share not answered 200 (`notOkShare`) next to them.

**Sanity gate** (`sanity` in the run summary): the bench gap `next − go` (median of the rounds'
common-200 p50s) against production's gap (the Next pool's in-situ p50 for the replayed cohort minus
feed-go's served p50, from the capture). Flagged when the signs differ or they are further apart
than half the production gap (25 ms at least): such a run does not reproduce production's gap and
must be explained before it is quoted.

Pure logic is in `lib.cjs` (tested in `__tests__/lib.test.ts`); `bench.cjs` is the I/O around it.
