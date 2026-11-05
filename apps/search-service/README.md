# search-service

A small read-only service in front of Qdrant. It corrects the spelling of text queries with SymSpell,
embeds them the way the main app does, and queries the vector index. Python 3.12 + FastAPI.

The contract is [`openapi.json`](./openapi.json). Regenerate it with `python scripts/export_openapi.py`
after changing a route or model (CI fails when it is stale).

## Endpoints

Every route except `/healthz` needs `Authorization: Bearer <token>`, where the token is one of
`SEARCH_SERVICE_TOKENS`. Each token has its own rate limit (`RATE_LIMIT_PER_MINUTE`, default 600,
with bursts up to that many). Over the limit, the service answers `429` with `Retry-After`.

| Route | What it does |
| --- | --- |
| `GET /healthz` | `200` once the spelling dictionary has loaded, with its policy and version. |
| `POST /v1/spell` | `{query}` → `{query, corrected, changed, changes[], skipped, policy, version}` |
| `POST /v1/search` | `{collection, query, filter?, limit?=20, offset?=0, spellcheck?=true, with_payload?=false}` → `{query, corrected, changes[], hits: [{id, score, payload?}]}` |
| `GET /qdrant/collections/{collection}` | Qdrant's collection info, byte for byte |
| `POST /qdrant/collections/{collection}/points/{query,search,recommend,scroll,count}` | Qdrant's read endpoints, byte for byte (status, body and content type) |

Each change in `changes[]` has the form `{from, to, distance}`. In `/v1/search`, `limit` is at most
100 and `offset` at most 2000. `filter` is a [Qdrant filter](https://qdrant.tech/documentation/concepts/filtering/).

How the passthrough treats requests:
- The request body is forwarded unchanged.
- The `timeout` and `consistency` query parameters are forwarded; any other query parameter is dropped.
- A body whose `lookup_from` names a collection outside the allow-list is refused.
- Every other `/qdrant/...` path or method is `403`. That covers all writes, batch endpoints,
  snapshots, aliases and cluster routes.

`collection` is a public name from the allow-list (`SEARCH_COLLECTIONS`, default
`images=images_semantic,models=models_semantic`), never a raw Qdrant name. If a collection is
configured but does not exist in Qdrant, the service answers `404`.

**Hits are candidates, not visibility decisions.** Qdrant's payload can be stale, and this service
does not know who is viewing. Callers must hydrate ids through the main app's image fetch path,
which applies publish state, privacy, blocks and browsing level, as `semantic-image-search.service.ts` does.

### Example

```bash
curl -s localhost:8000/v1/search -H 'Authorization: Bearer local-dev-token' \
  -H 'content-type: application/json' \
  -d '{"collection":"images","query":"Batmen","limit":5,
       "filter":{"must":[{"key":"nsfwLevel","match":{"any":[1]}}]}}'
# {"query":"Batmen","corrected":"Batman","changes":[{"from":"Batmen","to":"Batman","distance":1}],
#  "hits":[{"id":123,"score":0.83}, ...]}
```

The smoke test: `Batmen` must come back as `Batman`. With the real dictionary it does, and
`/v1/spell` shows the same correction without a search.

## Spelling

The service uses policy `catalog-conservative-v1`, ported unchanged from the catalog search prototype
(`search_service/spelling.py`):
- It skips quoted spans, protected terms (catalog names, trigger words, creator names, English
  words), whole queries that are a creator's name, and queries with non-Latin or accented letters.
- It only corrects ASCII words of 4–32 letters, at edit distance 1 below 8 letters and 2 from there.
- It only corrects when the best suggestion has a count of at least 5 and at least 3× the runner-up.
- It keeps the source's case (`Batmen` → `Batman`, `WATERCOLR` → `WATERCOLOR`).

A change to any of these rules is a new policy name.

The dictionary is three files in `SPELLING_DIR`: `spelling-dictionary.txt`,
`spelling-protected.private.json` and `spelling.json`. **They are never committed**, because the
protected list holds creator usernames. Build them from a JSONL of `{name, tags, trigger_words, username}`:

```bash
python -m search_service.spelling build --source catalog.jsonl --out data/spelling
```

The service refuses to start without them. It also refuses a dictionary built under another policy.

## Embedding

This mirrors `src/server/services/semantic-image-search.service.ts`:
- It calls `POST {ORCHESTRATOR_ENDPOINT}/v2/consumer/recipes/multimodalEmbedding` with
  `{model: "wemm-2b", dimensions: 256, precision: "float32", text}` and the bearer token
  `ORCHESTRATOR_ACCESS_TOKEN`.
- The text it embeds is the corrected query with whitespace collapsed. Case is kept.
- The response's `modelRevision`/`profile` must match the index's stamp (the collection's
  `config.metadata`, cached 5 minutes). A mismatch answers `503` and is never cached.
- Query vectors are kept in an in-memory LRU (`QUERY_CACHE_SIZE`, default 5000, about 1 KB each).
- Qdrant is queried with `params: {quantization: {rescore: true, oversampling: 2}}`.

## Configuration

| Env | Default | |
| --- | --- | --- |
| `QDRANT_URL` | `http://localhost:6333` | |
| `QDRANT_API_KEY` | none | Sent as `api-key`. A read-only key is enough. |
| `ORCHESTRATOR_ENDPOINT` | `https://orchestration.civitai.com` | |
| `ORCHESTRATOR_ACCESS_TOKEN` | none | The token the main app embeds with. |
| `SEARCH_SERVICE_TOKENS` | none | Comma-separated caller tokens. Required. |
| `SEARCH_COLLECTIONS` | `images=images_semantic,models=models_semantic` | Public name = Qdrant collection or alias. |
| `SPELLING_DIR` | `/data/spelling` | Read-only is fine. |
| `RATE_LIMIT_PER_MINUTE` | `600` | Per token, per process. |
| `QUERY_CACHE_SIZE` | `5000` | |
| `FAKE_EMBEDDINGS` | off | Local only; see below. |
| `LOG_LEVEL` | `info` | |

Tokens and keys are never logged. The container listens on port 8000 and runs as uid 1001. It
writes nothing to disk, so a read-only root filesystem works. With the full catalog dictionary
(168k terms, 598k protected terms) the process holds about 380 MB RSS after startup, and loading
takes about 3 s. Each uvicorn worker loads its own copy, so scale with replicas, not workers.

## Run locally

You need Docker, or Python 3.12 for the no-Docker route below. This setup uses a local Qdrant
seeded with fake vectors, so it runs without an orchestrator token.

```bash
cd apps/search-service

# 1. A dictionary. The sample catalog is synthetic; ask the search team for the real one,
#    and keep it out of the repo (data/ is gitignored).
python3.12 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python -m search_service.spelling build --source examples/sample-catalog.jsonl --out data/spelling

# 2. Qdrant + the service
docker compose up -d --build

# 3. A fake-vector images_semantic collection (400 points from the sample catalog)
.venv/bin/python scripts/seed_local.py --qdrant http://localhost:6333

# 4. Try it
curl -s localhost:8000/healthz
curl -s localhost:8000/v1/search -H 'Authorization: Bearer local-dev-token' \
  -H 'content-type: application/json' -d '{"collection":"images","query":"Batmen","limit":3,"with_payload":["name"]}'
```

`FAKE_EMBEDDINGS=1` (the compose default) hashes words into vectors instead of calling the
orchestrator. Results rank by shared words, not meaning, but the contract is the same. Fake
vectors carry their own model revision, so they are refused against a real index. To embed for
real, set `FAKE_EMBEDDINGS=0` and `ORCHESTRATOR_ACCESS_TOKEN`, and point `QDRANT_URL` at an
index built with `wemm-2b`.

To run without Docker, start a Qdrant binary from its GitHub release, then:

```bash
QDRANT_URL=http://localhost:6333 SEARCH_SERVICE_TOKENS=local-dev-token FAKE_EMBEDDINGS=1 \
SPELLING_DIR=data/spelling .venv/bin/uvicorn search_service.app:create_app --factory --port 8000
```

## Tests

```bash
.venv/bin/pip install pytest==8.3.4 && .venv/bin/python -m pytest
```

The tests run against a fake Qdrant and orchestrator, with a dictionary built from a synthetic
catalog. They cover:
- spelling parity with the prototype's cases, and `Batmen` → `Batman`
- auth on every route
- the passthrough allow-list, with writes refused
- the `/v1/search` request shapes
- caching and the model-stamp check

No pnpm CI job runs these (Python is invisible to them); run them locally before a PR.
