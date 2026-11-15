# Golden fixtures

One JSON file per request shape: `as-posts/` for `image.getImagesAsPostsInfinite`, `v1-images/` for
`GET /api/v1/images`, `v1-models/` for `GET /api/v1/models` and `/api/v1/models/[id]` (that directory
has its own format and harness: see "v1-models" below). `internal/server/golden_test.go` loads every file, builds a real `*Server`
over in-memory fakes (`internal/testkit`) holding exactly what the fixture records, computes the
request, and compares the answer with the Node answer the fixture expects (`shadow.Compare` for the
superjson envelope, `shadow.CompareJSON` for the REST body). All data is synthetic: invented ids
(users 1001.., images 8001..), usernames, `00000000-0000-4000-8000-…` image keys, `*.example.test`
hosts.

## Format

| key | what |
|---|---|
| `now` | the instant the request runs at (the publish filter, cache staleness, session token times) |
| `config` | feed-go's flag mirrors (`imageIndexFeed`, `lazyPostImages`, `creatorPromotions`, `decorationEvents`) or, for v1, `imageLocation` |
| `request` | tRPC: `input` (the raw `?input=` superjson envelope); REST: `query` (the raw query string) and `path`. `headers` (always `host`); `session.userId` makes the harness mint a signed session cookie for that synthetic viewer |
| `feed` | every call the request makes to the image feed service: the exact `query` string (asserted: an unlisted query fails, and on a served fixture an unasked one fails) and the reply `status` / `body` |
| `redis` | cache-cluster keys: `packed` (base64 of msgpackr bytes, with the readable `value`), `raw` (JSON strings such as gallery settings) or `hash` (metric hashes) |
| `sysRedis` | system-redis keys (the browsing-settings addons) |
| `db` | Postgres tables (`images` rows as the getAllImages SELECT returns them, plus `_resources`, their ImageResourceNew rows; `posts`, `modelVersions`, `models`, `reviews`, `reactions`, `placements`, `users`). The harness answers each query feed-go sends from these, evaluating the clauses the fixtures reach |
| `expect` | `fallback` (the reason feed-go must fall back with), or the Node answer: `envelope` (`{json, meta}`) plus `cacheable` (signed out), or `body` (REST) |

## Where the expectations come from

`gen.mjs` writes every fixture. Its mirror functions are transcriptions of the Node code path, each
naming the file it follows (the gallery handler, `getAllImagesIndex`, `getAllImagesUncaptured`, the
feed query mapper, `serveFromFeed`, the wire trims, `runImageSearch`, the cache readers). The answer
is encoded with the repo's own `superjson` / `JSON.stringify`, `nextPage` with `query-string`, and
cache values with msgpackr's module-level `pack` (`pack.mjs`), so the bytes are Node's. Nothing is
derived from feed-go's output: when a golden test fails, re-derive the answer from the Node source;
a fixture is corrected only when the mirror mis-read Node, and otherwise feed-go is fixed.

```bash
TZ=UTC node apps/feed-go/testdata/golden/gen.mjs              # regenerate everything
node apps/feed-go/testdata/golden/pack.mjs <fixture.json>...   # re-pack edited `value`s in place
```

Both need the repo's `node_modules` (`pnpm install`; from a worktree without one, set
`GOLDEN_NODE_MODULES=<clone>/node_modules`). After regenerating, raise `goldenMinAsPosts` /
`goldenMinV1` in the harness if fixtures were added.

## Refreshing from a Node dev instance

To pin a shape the mirror does not cover, capture it from a Node dev server and write the fixture by
hand (or add a spec to `gen.mjs`):

1. **The answer.** tRPC: the `result.data` of `GET /api/trpc/image.getImagesAsPostsInfinite?input=…`
   (the superjson `{json, meta}`); REST: the JSON body of `GET /api/v1/images?…`. Record the request
   (`input` / query string, `Host`, whether a session cookie was sent and for which user).
2. **The feed calls.** Log the `query` argument and the reply of `fetchFeedPrimary`
   (`src/server/services/feed-primary.service.ts`) for the request: page calls, the loop's further
   pages and the post-completion calls (`postIds=…`).
3. **The cache keys read.** Enable the cache readers' debug logging or read the keys with
   `redis-cli --raw`: `packed:caches:*` for the image ids and creators on the page, `metrics:Image:<id>`
   hashes, `model:gallery-settings:*`, `session:data2:<userId>`, and `system:browsing-setting-addons`
   on the system redis. Store each packed value as `value` (JSON, Dates as `{"$date": …}`,
   `undefined` as `{"$undefined": true}`) and run `pack.mjs` on the file to fill `packed`.
4. **The rows.** The getAllImages rows of every image on the page (all rows of each post: the post
   image count reads them), the version→model rows, reviews, reactions, placements.

Replace every id, name, URL and hash with synthetic values before committing: this repository is
public.

## v1-models

`gen-v1-models.mjs` writes each fixture's request and `world` (the model statement's rows, every cache
value, every replica row) and packs the cache values under their real keys (`redis`). It does NOT write
the expected answer: `src/server/__tests__/feed-go-v1-models.golden.test.ts` runs the real Node route
handlers over the world and requires `expect.body` (the bytes `res.json` writes) and `expect.sql` (the
model statement) to equal what that code produces. A new fixture starts with `expect: {body: null}`;
that test fails with `GOLDEN-ACTUAL <file> <json>`, the real answer, which is copied into the fixture.
`internal/v1models/golden_test.go` then requires the same bytes and statement from Go.

```bash
GOLDEN_NODE_MODULES=<clone>/node_modules node apps/feed-go/testdata/golden/gen-v1-models.mjs
```
