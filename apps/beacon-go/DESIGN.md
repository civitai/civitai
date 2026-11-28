# beacon-go design

beacon-go answers the browser beacons — `POST /api/internal/ping` (page views),
`POST /api/internal/pulse` (entity views) and, behind its own switch, `POST /api/track/batch` (search
and action telemetry, §1.4) — exactly as the Node handlers do, and writes the same tracker rows. It exists to move these high-volume, framework-overhead-dominated requests off the Node
API pool. It is its own small service (not part of `apps/feed-go`) so that the writes stay isolated
from the read-only feed service.

The rule, borrowed from feed-go: **answer only what can be answered exactly as Node would, and hand
everything else back** (a *fallback*). In serve mode a fallback is proxied to the Node app unchanged;
in shadow mode it is counted by reason. The fallback rate per reason is the measured list of what is
left to port.

## 1. The contract

Sources: `src/pages/api/internal/ping.ts`, `src/pages/api/internal/pulse.ts`, `PublicEndpoint` /
`addCorsHeaders` / `requestCarriesCallerCredentials` (`src/server/utils/endpoint-helpers.ts`),
`Tracker` (`src/server/clickhouse/tracker.ts`), `pageViewBeaconSchema` / `addViewSchema`
(`src/server/schema/track.schema.ts`), `getMatchingPathname`
(`src/shared/constants/pathname.constants.ts`), `resolveClientIp` (`src/server/utils/client-ip.ts`),
`getServerAuthSession` (`src/server/auth/get-server-auth-session.ts`) and Next 16's own `parseBody`,
`sendData` and `sendError`.

### 1.1 Shared by both endpoints

**Auth.** `PublicEndpoint`: no authentication is required and none is enforced. The session is
resolved only when a row is written (the Tracker's `send`), through `getServerAuthSession`: a bearer
token (`Authorization` header or `?token=`) is looked up as an API key; otherwise the hub session
cookie (`civ-token`, either slot) is verified, checked against the revocation registry and resolved
through the shared `session:data2:<userId>` cache. The row's `userId` is `session.user.id ?? 0`.

The session cookie is chosen as `readSessionToken` (`packages/civitai-auth/src/cookies.ts`) chooses it,
and this service reads it the same way (`internal/auth` `Resolve`). The order is the request site's
mode's own slot, then the other: `__Host-civ-token` then `__Secure-civ-token` in host mode,
`__Secure-civ-token` then `__Host-civ-token` in shared mode (the mode is the site's
`AUTH_SESSION_COOKIE_MODE_BY_SITE` entry, else `AUTH_SESSION_COOKIE_MODE`; the shared slot is skipped
when the legacy read is off; http dev has only the bare `civ-token`). The first slot the request carries
with a non-empty value is the token, on presence alone; when it does not verify, is revoked or is the
moderation account the request is signed out, and the other slot is not tried. The `Cookie` header is
read as Next's `req.cookies` reads it: several lines joined with `; `, the first occurrence of a name
wins even when empty, a value starting with `"` loses its first and last character, and a value that
does not URL-decode is kept raw.

**Rate limits.** None: neither handler nor `PublicEndpoint` applies one.

**Methods.** Any method reaches the handler (`['POST']` only feeds `Access-Control-Allow-Methods`).

**Before the handler** (Next's `apiResolver`): the body is parsed by `parseBody` with the default
`1mb` limit. Content-Type `application/json` / `application/ld+json` → `JSON.parse` (an empty body is
`{}`; invalid JSON is answered by Next itself: `400 Invalid JSON`, no handler headers);
`application/x-www-form-urlencoded` → an object of strings; anything else (or an unparseable
Content-Type) → the decoded string. The decode honours the `charset` parameter and strips a BOM.

**Response headers** (`PublicEndpoint`, in order): `Vary: Authorization` (or `Authorization, Cookie`
when the request carries a credential: an `Authorization` header, a cookie whose name is any of the
five session-cookie spellings, or a `?token=`), `Access-Control-Allow-Origin: *`,
`Access-Control-Allow-Headers: Authorization, Content-Type, *`, `Access-Control-Allow-Methods: POST`.
An `OPTIONS` request is answered here: `Access-Control-Max-Age: 7200`, `200`, empty body. Otherwise
`Cache-Control: max-age=0, private, no-cache` for a credentialed request or a verified crawler
(`x-civitai-verified-bot: googlebot|bingbot`), else `public, s-maxage=300, stale-while-revalidate=150`.

**Response bodies.** `res.status(200).end()`: no body, no ETag. `res.status(400).send(text)`: the text,
no Content-Type, and an `ETag` (Next's `generateETag`): `"weftv9g98bf"` for `invalid request`,
`"eueval305xc"` for `invalid body`, `"17fa7f31cyhd"` for `invalid input`. When the request is
`fresh` for that ETag (`If-None-Match: *` or a matching tag, no `If-Modified-Since`, no
`Cache-Control: no-cache`) the answer is `304` with no body instead.

**Writes.** Each beacon writes at most one row: the Tracker POSTs `JSON.stringify(row)` to
`${CLICKHOUSE_TRACKER_URL}/track/<table>` (`Content-Type: application/json`), fire-and-forget, up to
3 attempts (a 4xx ends it; a 5xx or network error is retried after 250 ms·2^(n-2) + up to 250 ms
jitter). No row is sent when `CLICKHOUSE_TRACKER_URL` is unset or the public origin is loopback
without `NEXT_PUBLIC_LOCAL_TRACKER_ENABLED=true` (`trackerSends()`); the session is then never
resolved either. There is no direct ClickHouse insert, no Redis counter, no points and no signal.

**Side effect of the session read.** When the hub session's token is older than
`AUTH_SESSION_UPDATE_AGE` (default 24 h), `getServerAuthSession` asks the hub for a fresh token and
sets the session cookie on the response (rolling refresh).

### 1.2 `/api/internal/ping` → table `pageViews`

1. `referer` absent or empty → `400 invalid request`. `new URL(referer)` throws → `400 invalid
   request`. `url.host !== req.headers.host` (case-sensitive) → `400 invalid request`.
2. `JSON.parse(req.body)`: a string body is parsed; an object (a JSON or urlencoded body) stringifies
   to `[object Object]` and throws; a number / boolean / null re-parses and then fails the schema. A
   throw → `400 invalid request`. (The real client sends no Content-Type, so the body is text.)
3. `pageViewBeaconSchema`: an object with a string `path` (else `400 invalid request`); `ads` a boolean
   else `false`; `duration`, `windowWidth`, `windowHeight` a finite number or a string whose
   `Number()` is finite, else `0`. Unknown keys are dropped.
4. `country = req.headers['cf-ipcountry'] ?? 'undefined'`; `pageId = getMatchingPathname(path)` (the
   first pathname whose tokens equal the url's — a SHORTER url matches a longer pathname's prefix —
   else the last same-length `[`-wildcard match, else the path itself).
5. The session is resolved and awaited (so a rolling refresh adds `Set-Cookie` to this response), then
   the row is sent and the answer is `200`, empty.

Row, keys in this order:

```json
{"userId":0,"memberType":"undefined","ip":"203.0.113.7","pageId":"/models/[id]/[[...slug]]",
 "path":"/models/123/some-slug","host":"www.example.test","country":"US","ads":true,
 "duration":12345,"windowWidth":1920,"windowHeight":1080}
```

`memberType` is `session.user.tier ?? 'undefined'`. `duration` is `Math.floor` of the value, then each
of the three is clamped to its column (`clampToColumn`: non-finite → 0, truncate, negative → 0, past
the bound → the bound: 4294967295 for `duration`, 32767 for the window sizes). `ip` is
`resolveClientIp(req)`: a trimmed `cf-connecting-ip` that `net.isIP` accepts (≤ 45 characters, no
`%`), else request-ip's chain (`x-client-ip`, the first valid `x-forwarded-for` entry with a
`host:port` entry cut to its host, `cf-connecting-ip`, `fastly-client-ip`, `true-client-ip`,
`x-real-ip`, `x-cluster-client-ip`, `x-forwarded`, `forwarded-for`, `forwarded`,
`x-appengine-user-ip`, then the socket), else `'unknown'`.

### 1.3 `/api/internal/pulse` → table `views`

1. `source = req.headers.origin ?? req.headers.referer` (an Origin that was sent, even empty, wins);
   no source, a `new URL` throw, or `url.host !== req.headers.host` → `400 invalid request`.
2. A string body is `JSON.parse`d (a throw → `400 invalid body`); any other body is used as is.
3. `addViewSchema` (zod 4) → `400 invalid input` unless: an object; `type` one of `VIEW_TYPES`;
   `entityType` one of `VIEW_ENTITY_TYPES`; `entityId` a finite number; optional `ads` one of
   `Member | Blocked | Served | Off`; optional `nsfw` a boolean; optional `nsfwLevel` and
   `browsingLevel` finite numbers; optional `details` an object whose JSON is at most 256 KiB
   characters (and at most 128 Ki values). The output has only the keys the input had, in schema
   order; `details` keeps the input's own keys (JS order: integer keys ascending first) minus a
   top-level `__proto__`.
4. The view is NOT awaited: `200`, empty, is sent at once and the session resolves afterwards (a
   rolling refresh then fails to set its cookie on the already-sent response).

Row: `{...actor, ...values}`:

```json
{"userId":0,"ip":"203.0.113.7","userAgent":"Mozilla/5.0 …","type":"ImageView","entityType":"Image",
 "entityId":123,"ads":"Served","nsfw":false,"details":{"1":true,"2":"x","b":1},"nsfwLevel":1,
 "browsingLevel":31}
```

`userAgent` is `req.headers['user-agent'] ?? 'unknown'`.

### 1.4 `/api/track/batch` → tables `search`, `actions`, `impressions` (and `feedEvents`, never here)

Sources: `src/pages/api/track/batch.ts`, `parseTrackBatch` / `trackBatchEventSchema` /
`trackSearchSchema` / `trackActionSchema` (`track.schema.ts`), `Tracker.search` / `Tracker.action` /
`ACTOR_META_FREE_ACTION_TYPES` (`tracker.ts`).

1. The same-origin guard and the body step of pulse (§1.3 steps 1 and 2): `400 invalid request`,
   `400 invalid body`.
2. The envelope: an array of 1..`TRACK_BATCH_MAX` (100) elements, else `400 invalid input`.
3. Each element is parsed on its own (`trackBatchEventSchema`, on `kind`). Node DROPS an element
   that does not parse and keeps the rest (`400 invalid input` when none survives).
4. Node dispatches each event in order through one Tracker, not awaited; `200`, empty, is sent at
   once (so, as on pulse, no rolling refresh can reach the response):
   - `search` → `Tracker.search` → one row in `search`: `{...actor, query (trimmed), index,
     filters}`, `filters` the `JSON.stringify` of the passthrough object (at most
     `TRACK_FREEFORM_MAX_CHARS`), or `''` when absent;
   - `action` → `Tracker.action` → one row in `actions`: `{...actor, type, [reason], details}`,
     `details` the `JSON.stringify` of the arm's parsed object (zod key order: the shape's keys,
     then a passthrough object's other keys; unknown keys of a strict object stripped), or `''`;
     for the five `ACTOR_META_FREE_ACTION_TYPES` the actor is `{userId}` alone;
   - `impression` → `Tracker.impressions`: a DIRECT ClickHouse insert into `impressions` (not the
     tracker service), plus event points for hatted entities (`awardViewPoints`, a `UserWrite`
     session);
   - `feed` → the feed events recorder (its own buffer; the viewer's tier and hot-lead state).

`actor` is pulse's (`userId`, `ip`, `userAgent`), resolved once per batch.

What the two non-tracker sinks do and write (sources: `Tracker.impressions` / `trackMany` /
`sendMany` in `tracker.ts`; `hattedImpressionEntities` / `awardViewPoints` in
`src/server/events/points/hooks.ts` and `awardEventPoints` in `award.ts`; `feedEventsRecorder` in
`src/server/services/feed-events.service.ts` and `createSampledRowBuffer` in
`src/server/clickhouse/sampled-row-buffer.ts`):

- **impressions**: one ClickHouse insert per event (`clickhouse.insert`, `JSONEachRow`, the shared
  client's `async_insert=1, wait_for_async_insert=0`), one row per entity,
  `{userId, entityType, entityId, sessionKey, surface}` (`skipActorMeta`: no ip, no user agent).
  Gated on the ClickHouse client existing, not on the tracker. Not retried.
- **event points for hatted content**: `hattedImpressionEntities` picks the distinct Image / Model /
  Article entities wearing a hat of a scored event (an in-memory hat map loaded from Redis and
  followed through a stream), behind the `event-points-engine` Flipt switch; when any, it resolves a
  `UserWrite`-scoped session and `awardEventPoints` writes Redis dedupe sets, per-owner caps and live
  totals, a ClickHouse ledger row (`event_point_events`) and a live push.
- **feed events**: sampled per browser session, `hashToUnit(sessionKey) < rate` with the rate the
  `feed-events-sample-rate` Flipt variant (`parseSampleRate`, read for 15 s). An unsampled session
  records nothing and reads nothing. A sampled one resolves the viewer from the session (its
  `userId`, `memberType` = tier, and `personalHotLead`, a per-user Flipt evaluation), labels the page
  from the build's page manifest (`pageRouteLabel`), and buffers the row, stamped with the buffer
  time, for a batched insert into `feedEvents`.

**What beacon-go answers**: a batch whose every element it parses and can write exactly: `search`
and `action` events (always, when the route is on), `impression` events with
`BEACON_GO_TRACK_BATCH_SERVE_IMPRESSIONS` on and no scored event's points window open (± 1 h), and
`feed` events of unsampled sessions with `BEACON_GO_TRACK_BATCH_SERVE_FEED` on and a current reading
of the sample rate (an unsampled feed event writes nothing, so this service writes nothing for it
either). It answers every 400 of steps 1-2 itself. Everything else falls back WITH THE WHOLE
REQUEST, so a batch is written by one writer only and is never split or written twice. A batch it
answers is queued whole, across both of its writers: its tracker rows and its impression inserts
are reserved in their queues first (`Reserve`, under each queue's lock), and queued only when both
reservations hold; when either queue cannot take its share the other is released and the request
falls back to Node rather than answering 200 for a partly queued batch. Once queued, a row can
still end `failed` or `dropped` at shutdown (§3), as a Node send can fail:

| reason | when |
|---|---|
| `track-impression` | the batch has an `impression` event and the impressions sink is off |
| `track-feed` | the batch has a `feed` event and the feed sink is off |
| `track-impression-event-points` | an impression names an Image, Model or Article while a scored event's points window (`previewFrom ?? startDate` to `endDate + finalizeAfterMs`, widened by an hour each side) is open: Node may award view points for it, which depends on the hat map in Redis and writes Redis and the ledger; not reproduced |
| `track-feed-sample-rate` | a feed event, and no current reading of the `feed-events-sample-rate` variant (Flipt not configured, or no successful read in the last minute) |
| `track-feed-sampled` | a feed event of a sampled session: its row needs the viewer's personal-hot-lead cohort (a per-user Flipt evaluation), the build's page manifest and the recorder's buffer clock; not reproduced |
| `track-action-unported` | an `Experiment_Exposure` action (its schema reads the experiment registry) |
| `track-event-invalid` | an element this service's copy of the schema does not accept: Node would drop it, but a value Node has started accepting since the copy was taken would be lost, so Node decides |
| `disabled` | serve mode with `BEACON_GO_TRACK_BATCH_SERVE` off (§3): every request |
| `track-queue-full` | serve mode: the batch was computed, but the tracker or the insert queue has room for fewer than its rows (or a client is closing); nothing is queued |

When several apply, the first in that order is counted. With the two sinks off, the `track-impression`
and `track-feed` rates are the share of batches carrying one, as before they were ported.

The impression and feed sinks copy their constants too (`internal/beacon/trackbatch_sinks.go`: the
impression entity types and surfaces, the feed enums and bounds, the point entity types, the scored
events' windows, the sample-rate flag), pinned by `TestTrackBatchSinkConstants`; `hashToUnit` and
`parseSampleRate` are pinned by recorded vectors. `gen.ts` also records the zod schemas of every
event kind as JSON Schema (`z.toJSONSchema`, `io: 'input'`), and `TestTrackBatchSchemas` pins each
action arm and the search, impression and feed parsers to them key by key (order, required, type,
enum, bounds, pattern, passthrough), so a field added on the Node side fails a Go test instead of
being stripped or refused in production. What JSON Schema cannot show (`.trim()`) is not pinned
there.

The action arms import constants (`USER_MENU_ITEM_IDS`, the app-store and app-telemetry enums, ...);
`internal/beacon/trackbatch_arms.go` holds copies, pinned by `TestTrackBatchConstants` against
`vectors.json`, which `src/server/beacon/__tests__/beacon-go-track-batch-vectors.test.ts` pins
against the live Node values.

## 2. What beacon-go reproduces, and what it hands back

Exact, byte for byte: the body parse (UTF-8, BOM strip, text and JSON bodies, Next's empty-JSON and
`Invalid JSON` cases), the headers above, the four response bodies and their ETags, both schemas,
`getMatchingPathname` (its list is a copy, pinned against the Node file by a test), the client-ip
chain, `JSON.parse` / `JSON.stringify` semantics (key order, a repeated key, `__proto__`, lone
surrogates, number formatting, `Number(string)`), header bytes read as latin-1 and repeated headers
folded as Node folds them.

Deliberately not reproduced, because beacons never send them: the `OPTIONS` preflight, conditional
requests (the 304 rule) and urlencoded bodies. Each falls back under its own reason, so serve mode
hands them to Node and the counter shows whether they ever occur.

Fallback reasons (`beacon_go_fallback_total{reason}`):

| reason | when |
|---|---|
| `query-string` | the request target has a query (getServerAuthSession and the credential check read `?token=`; beacons send none) |
| `bearer-token` | a row would be written and the request carries an `Authorization` header (an API-key session) |
| `session-cache-miss`, `session-cache-cleared`, `session-id-mismatch`, `session-no-id`, `session-tier-type` | the session cannot be resolved exactly from the cache (the Node path would ask the hub, or the cached user is unusual) |
| `jwks-unavailable` | a session cookie is present but no key set is held (the first fetch has not landed, or the set was dropped as stale): the token may be valid, so it is not written as signed out |
| `revocation-unavailable` | the revocation registry read failed: Node would still deny the revocations its marker cache has seen, which this service does not hold, so it does not guess |
| `session-roll-due` | ping only: the session's token is due a rolling refresh, which only Node can mint; Node answers with the `Set-Cookie` |
| `url` | the Referer/Origin is outside the reproduced URL subset: a scheme other than http(s), userinfo, an IPv6 or IPv4-number host, punycode or non-ASCII, percent-encoding, backslashes, controls or spaces, or other than exactly two slashes |
| `client-ip` | an ip candidate holding `:` reaches request-ip's IPv6 regex (lookaheads and backreferences, not reproduced) |
| `client-ip-socket` | no header resolves an ip, so request-ip would read the socket peer |
| `charset` | a `charset` other than UTF-8 |
| `body-too-large` | over Next's 1 MiB limit (Next answers 413) |
| `json-depth` | JSON nested past 512 levels |
| `array-body` | ping with a JSON array body (Node `String()`s it, then parses) |
| `preflight` | an `OPTIONS` request (PublicEndpoint answers it with the CORS headers and `Access-Control-Max-Age`) |
| `conditional-request` | a non-empty `If-None-Match` or `If-Modified-Since` (Next could answer a 400 with a 304) |
| `form-body` | an `application/x-www-form-urlencoded` body (both handlers refuse Next's decoded object with a 400) |
| `shadow-body-kind` | shadow only: Node's `req.body` shape disagrees with this service's Content-Type reading |

Deliberately not reproduced: `isDev` (development answers 200 at once); the preview-only cookie sign-in;
on `pulse`, the hub refresh call Node makes after the response for a token due a roll (its cookie can
never reach the client, so beacon-go makes no call); the HTTP reason phrase of Next's `400 Invalid
JSON` (Go writes the standard one).

## 3. Modes

`/api/track/batch` has its own switch, `BEACON_GO_TRACK_BATCH_SERVE` (exactly `true` turns it on;
default off), read in serve mode only: off, the public listener proxies every `/api/track/batch`
request to the Node app unchanged (fallback `disabled`), whatever share of that route the ingress
sends here. Its shadow compare endpoint runs in either mode and either way, and writes nothing.

Two more switches, each default off and read in serve mode only, and only with the route on, add
the ported sinks one at a time: `BEACON_GO_TRACK_BATCH_SERVE_IMPRESSIONS` (requires
`CLICKHOUSE_HOST` and `CLICKHOUSE_USERNAME`, plus `CLICKHOUSE_PASSWORD`: the inserts go straight to
ClickHouse, as Node's do) and `BEACON_GO_TRACK_BATCH_SERVE_FEED` (requires `FLIPT_URL`, plus
`FLIPT_FETCHER_SECRET` and `FLIPT_ENVIRONMENT` as Node's client reads them: the sample rate). With
the route on and both off, the route serves exactly what step 1 served. The shadow comparison
ignores both switches: it computes every batch with every ported sink, so it measures the whole
port and says per batch which switches it would need (§4).

`BEACON_GO_MODE=shadow` (default): only the internal listener runs. Nothing is written. The Node
sampler (below) posts samples; each one is computed and compared.

`BEACON_GO_MODE=serve`: the public listener answers both routes. A computed row is queued and sent
by a bounded worker pool with the Node retry policy (a full queue drops a ping or pulse row and
counts it; a track batch that does not fit falls back whole, `track-queue-full`, §1). A
fallback is proxied to `BEACON_GO_FALLBACK_URL` with the original Host and the whole body.

Every queued row ends in exactly one `beacon_go_tracker_writes_total{table, result}` count: `ok`,
`rejected` (a 4xx), `failed` (attempts spent) or `dropped` (the queue was full, the client was
closed, or the row was still waiting, or inside a POST still running, when the shutdown grace period
ended; that POST is then cancelled and no row starts another attempt, its own outcome is never
recorded, so the row is not counted twice, and an in-flight row counted as dropped may in fact have
landed). The
shutdown order keeps those counts scrapeable: the public listener drains first, then the shadow
samples, then the tracker queue, and the internal listener (`/metrics`) closes last. A scrape can
still miss the final counts (the process exits right after), so the shutdown warning logs the rows
given up on per table (`dropped`), their total and how many were in flight. Beside it,
`beacon_go_tracker_send_seconds{table}` times each sent row (every attempt and retry wait) and
`beacon_go_tracker_queue_depth` is the queue's backlog.

## 4. Shadow comparison

The sampler is `src/server/beacon/beacon-go-shadow.ts` (payload code in
`beacon-go-shadow-payload.ts`), behind the Flipt flag **`beacon-go-shadow`** (default off) and
`BEACON_GO_SHADOW_URL` + `BEACON_GO_SHADOW_SAMPLE_RATE > 0` (ping, pulse) or
`BEACON_GO_SHADOW_TRACK_BATCH_SAMPLE_RATE > 0` (track-batch, default 0), and only where the Tracker
would send. A track-batch sample carries every row Node wrote: the `search` and `actions` tracker
rows, the `impressions` rows (`Tracker.sendMany` reports them through the same `onSend`), the
`feedEvents` rows the recorder buffered (`capture`), and `hattedViews`, how many entities the handler
passed to `awardViewPoints` (sent only when above 0). Rows are compared table by table (the sinks
settle in any order; one table's rows keep the event order). A batch this service answers while Node
wrote a feed row or awarded view points is a writes mismatch (`writes:count` /
`write:feedEvents:table`, `points:views`).
For a sampled request it captures, after the response has finished (and, for pulse, after the
un-awaited view has settled):

- the request: method, the path (the query is never forwarded: it can hold an API key; only a
  marker says whether there is one, and whether it holds a `token`), the headers the outcome depends on (host, origin, referer,
  user-agent, content-type, cf-ipcountry, the client-ip chain, the verified-bot header, the
  conditional-request headers), the session cookies only, `Authorization` only as `present`, and
  `req.body` as Next left it (a string as is, else its JSON, with `bodyIsString`);
- Node's response: status, the endpoint-decided headers (`Set-Cookie` redacted), the body;
- Node's writes: every row `Tracker.send` dispatched, as `JSON.stringify(row)` (`Tracker.onSend`).

**Coverage.** A match ratio over the batches this service answers says nothing about how many it
answers. Each compared track batch it would answer is also counted in
`beacon_go_track_batch_answered_total{path="shadow", sinks, result="match"|"mismatch"}`, `sinks`
naming the optional sinks it needs (`core` = search and action only, `impressions`, `feed`,
`impressions-feed`); the batches it would not answer are `beacon_go_fallback_total{path="shadow",
reason}`. The served share a serve configuration would have is the answered batches whose sinks it
switches on, over every compared batch (`beacon_go_shadow_compare_total{beacon_endpoint="track-batch",
result!~"dropped|invalid"}`). Serve mode counts the same series with `path="serve",
result="served"`.

beacon-go rebuilds the request, computes its own response and rows, and compares status, each compared
header, the body, and the rows byte for byte (count, table, bytes; a differing row is diffed by
top-level key, or `order` when only the order differs). The result is counted in
`beacon_go_shadow_compare_total{beacon_endpoint, result}` with `result` one of `match`,
`mismatch_status`, `mismatch_headers`, `mismatch_body`, `mismatch_writes`, `fallback`, `invalid`,
`error`, `dropped`; each differing field in `beacon_go_shadow_diffs_total{beacon_endpoint, field}`
(a fixed set). Mismatches are logged by field name only (rows carry an ip and a user agent). The Node
side counts its samples in `civitai_app_beacon_go_shadow_samples_total{outcome, beacon_endpoint}`.

The label is `beacon_endpoint`, not `endpoint`: `endpoint` is a reserved scrape-target label that
would move ours to `exported_endpoint` (the reason feed-go uses `feed_endpoint`).

🔴 A sample carries a session cookie (a bearer credential) and the caller's address:
`BEACON_GO_SHADOW_URL` must be an in-cluster address.

## 5. Code layout

| package | what |
|---|---|
| `internal/beacon` | the two handlers (`Engine.Ping`, `Engine.Pulse`) and everything they reproduce |
| `internal/jsvalue` | JSON.parse / JSON.stringify / Number / trim / UTF-8 decode, with JS semantics |
| `internal/shadow` | sample decoding and the comparison |
| `internal/tracker` | the bounded fire-and-forget tracker client, and the same client as the direct ClickHouse insert (`NewClickHouse`, the impressions) |
| `internal/flipt` | the feed events sample rate, read from Flipt in the background (`Rate`) |
| `internal/server` | listeners, routes, metrics, the shadow intake |
| `internal/auth`, `internal/hydrate`, `internal/sysredis`, `internal/safe`, `internal/fallback`, `internal/testkit` | copied from feed-go (session JWT verification, revocation, the session cache read, the system-redis client, panic recovery, fallback errors, the Redis fake), cut down to what the beacons need; not imported across apps |
| `internal/golden` | the golden-fixture loader (tests only) |

The copy was chosen over a shared Go module: the pieces are small, feed-go's are entangled with its
hydration package, and a shared module would couple the two services' release cycles.

## 6. Tests

`testdata/golden/gen.ts` writes the golden fixtures and `vectors.json` from the Node code itself
(the real schemas, pathname matcher, client-ip resolver, Next's parseBody / generateETag / fresh, the
JS engine's URL / JSON / Number, and the sampler's payload builder; the rest transcribed, each mirror
naming its source). Every fixture runs through the serve path's request construction, the HTTP
handler, and the shadow path (the sampler's payload → decode → compute → compare). Regenerate from
the repo root with `pnpm exec tsx --tsconfig tsconfig.json apps/beacon-go/testdata/golden/gen.ts`.
All fixture data is synthetic.

## 7. Deployment needs

Outbound, beyond step 1: ClickHouse's HTTP interface (serve mode with the impressions sink only)
and the Flipt server (whenever `FLIPT_URL` is set, shadow mode included, to read the sample rate).

Ports: 8080 (public, serve mode only), 9090 (internal: `/metrics`, `/healthz`,
`/internal/shadow/api/internal/{ping,pulse}`, `/internal/shadow/api/track/batch`). Env vars: see `.env.example`. Resource guess: CPU
request 100m, limit 1 core; memory request 64 MiB, limit 256 MiB, per replica, to be replaced by
measurements from the shadow phase.

**Network policy.** The internal port's compare endpoints are unauthenticated and accept session
cookies, so the Deployment needs a NetworkPolicy that admits the internal port only from the web
pods (the sampler) and the monitoring stack (`/metrics`), and nothing else.

### Before serve mode

The tracker writer is a fixed pool of synchronous workers (`BEACON_GO_TRACKER_WORKERS`, default 16)
in front of a bounded queue (`BEACON_GO_TRACKER_QUEUE`); a full queue drops a ping or pulse row and
sends a track batch back to Node (`track-queue-full`). Before switching
any replica to `BEACON_GO_MODE=serve`:

1. size the workers from measurement: per-pod beacon rate (from the shadow phase) × the tracker's
   p99 POST latency, with headroom, and set `BEACON_GO_TRACKER_WORKERS` to at least that; once
   serving, `beacon_go_tracker_send_seconds` and `beacon_go_tracker_queue_depth` show whether the
   pool keeps up;
2. alert on `beacon_go_tracker_writes_total{result="dropped"}` increasing (any dropped row is a lost
   page view or view), and watch `result="failed"` beside it.
