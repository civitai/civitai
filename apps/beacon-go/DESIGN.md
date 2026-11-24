# beacon-go design

beacon-go answers the two browser beacons — `POST /api/internal/ping` (page views) and
`POST /api/internal/pulse` (entity views) — exactly as the Node handlers do, and writes the same
tracker rows. It exists to move these high-volume, framework-overhead-dominated requests off the Node
API pool. It is its own small service (not part of `apps/feed-go`) so that the writes stay isolated
from the read-only feed service. `/api/track/batch` is out of scope here.

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

`BEACON_GO_MODE=shadow` (default): only the internal listener runs. Nothing is written. The Node
sampler (below) posts samples; each one is computed and compared.

`BEACON_GO_MODE=serve`: the public listener answers both routes. A computed row is queued and sent
by a bounded worker pool with the Node retry policy (a full queue drops the row and counts it). A
fallback is proxied to `BEACON_GO_FALLBACK_URL` with the original Host and the whole body.

Every queued row ends in exactly one `beacon_go_tracker_writes_total{table, result}` count: `ok`,
`rejected` (a 4xx), `failed` (attempts spent) or `dropped` (the queue was full, the client was
closed, or the row was still waiting when the shutdown grace period ended). The one row a worker is
sending when the process exits is the exception (at most one per worker). Beside it,
`beacon_go_tracker_send_seconds{table}` times each sent row (every attempt and retry wait) and
`beacon_go_tracker_queue_depth` is the queue's backlog.

## 4. Shadow comparison

The sampler is `src/server/beacon/beacon-go-shadow.ts` (payload code in
`beacon-go-shadow-payload.ts`), behind the Flipt flag **`beacon-go-shadow`** (default off) and
`BEACON_GO_SHADOW_URL` + `BEACON_GO_SHADOW_SAMPLE_RATE > 0`, and only where the Tracker would send.
For a sampled request it captures, after the response has finished (and, for pulse, after the
un-awaited view has settled):

- the request: method, the path (the query is never forwarded: it can hold an API key; only a
  marker says whether there is one, and whether it holds a `token`), the headers the outcome depends on (host, origin, referer,
  user-agent, content-type, cf-ipcountry, the client-ip chain, the verified-bot header, the
  conditional-request headers), the session cookies only, `Authorization` only as `present`, and
  `req.body` as Next left it (a string as is, else its JSON, with `bodyIsString`);
- Node's response: status, the endpoint-decided headers (`Set-Cookie` redacted), the body;
- Node's writes: every row `Tracker.send` dispatched, as `JSON.stringify(row)` (`Tracker.onSend`).

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
| `internal/tracker` | the bounded fire-and-forget tracker client |
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

Ports: 8080 (public, serve mode only), 9090 (internal: `/metrics`, `/healthz`,
`/internal/shadow/api/internal/{ping,pulse}`). Env vars: see `.env.example`. Resource guess: CPU
request 100m, limit 1 core; memory request 64 MiB, limit 256 MiB, per replica, to be replaced by
measurements from the shadow phase.

**Network policy.** The internal port's compare endpoints are unauthenticated and accept session
cookies, so the Deployment needs a NetworkPolicy that admits the internal port only from the web
pods (the sampler) and the monitoring stack (`/metrics`), and nothing else.

### Before serve mode

The tracker writer is a fixed pool of synchronous workers (`BEACON_GO_TRACKER_WORKERS`, default 16)
in front of a bounded queue (`BEACON_GO_TRACKER_QUEUE`); a full queue drops the row. Before switching
any replica to `BEACON_GO_MODE=serve`:

1. size the workers from measurement: per-pod beacon rate (from the shadow phase) × the tracker's
   p99 POST latency, with headroom, and set `BEACON_GO_TRACKER_WORKERS` to at least that; once
   serving, `beacon_go_tracker_send_seconds` and `beacon_go_tracker_queue_depth` show whether the
   pool keeps up;
2. alert on `beacon_go_tracker_writes_total{result="dropped"}` increasing (any dropped row is a lost
   page view or view), and watch `result="failed"` beside it.
