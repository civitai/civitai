"""Read-only Qdrant proxy with spelling correction and query embedding.

The embedding call and the Qdrant query mirror src/server/services/semantic-image-search.service.ts
in the main app; keep them in step with it.
"""

import hashlib
import hmac
import json
import logging
import os
import time
from array import array
from collections import OrderedDict
from contextlib import asynccontextmanager
from typing import Any

import httpx
from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from .config import Settings
from .spelling import Corrector

log = logging.getLogger('search_service')

EMBED_MODEL = 'wemm-2b'
EMBED_DIMENSIONS = 256
STAMP_TTL_SECONDS = 5 * 60
# Qdrant pays for every skipped candidate on each page, so deep paging is capped (as the main app).
MAX_OFFSET = 2000
MAX_LIMIT = 100
PASSTHROUGH_OPS = frozenset({'query', 'search', 'recommend', 'scroll', 'count'})
PASSTHROUGH_PARAMS = frozenset({'timeout', 'consistency'})
MAX_PASSTHROUGH_BODY = 64 * 1024


class SearchRequest(BaseModel):
    collection: str
    query: str = Field(min_length=1, max_length=1000)
    filter: dict[str, Any] | None = Field(default=None, description='A Qdrant filter object.')
    limit: int = Field(default=20, ge=1, le=MAX_LIMIT)
    offset: int = Field(default=0, ge=0, le=MAX_OFFSET)
    spellcheck: bool = True
    with_payload: bool | list[str] = Field(
        default=False, description='As Qdrant: true, false, or a list of payload keys.'
    )


class SpellRequest(BaseModel):
    query: str = Field(min_length=1, max_length=1000)


class Change(BaseModel):
    from_: str = Field(alias='from')
    to: str
    distance: int

    model_config = {'populate_by_name': True}


class Hit(BaseModel):
    id: int | str
    score: float
    payload: dict[str, Any] | None = None


class SearchResponse(BaseModel):
    query: str
    corrected: str
    changes: list[Change]
    hits: list[Hit]


class SpellResponse(BaseModel):
    query: str
    corrected: str
    changed: bool
    changes: list[Change]
    skipped: str | None = None
    policy: str
    version: str


FAKE_STAMP = {'modelRevision': 'local-fake', 'profile': 'local'}


def fake_embedding(text: str) -> list[float]:
    """A deterministic unit vector from the text's words, so equal words land near each other."""
    vector = [0.0] * EMBED_DIMENSIONS
    for word in text.casefold().split():
        digest = hashlib.sha256(word.encode()).digest()
        for i in range(0, 16, 2):
            vector[int.from_bytes(digest[i : i + 2]) % EMBED_DIMENSIONS] += 1.0
    norm = sum(v * v for v in vector) ** 0.5 or 1.0
    return [v / norm for v in vector]


def normalize_query(query: str) -> str:
    """Whitespace only: case can carry meaning (names, styles), so it reaches the model unchanged."""
    return ' '.join(query.split())


class VectorCache:
    """A small LRU of query vectors, stored as float32 arrays (about 1 KB each at 256 dimensions)."""

    def __init__(self, size: int):
        self.size = size
        self.items: OrderedDict[tuple, array] = OrderedDict()

    def get(self, key):
        vector = self.items.get(key)
        if vector is not None:
            self.items.move_to_end(key)
            return vector.tolist()
        return None

    def put(self, key, vector):
        if self.size <= 0:
            return
        self.items[key] = array('f', vector)
        self.items.move_to_end(key)
        while len(self.items) > self.size:
            self.items.popitem(last=False)


class RateLimiter:
    """A token bucket per caller token: bursts up to a minute's allowance, then refills steadily."""

    def __init__(self, per_minute: int):
        self.capacity = float(per_minute)
        self.rate = per_minute / 60.0
        self.buckets: dict[str, tuple[float, float]] = {}

    def take(self, key: str) -> float:
        """0 when allowed, else the seconds until a request would be."""
        if self.capacity <= 0:
            return 0.0
        now = time.monotonic()
        tokens, at = self.buckets.get(key, (self.capacity, now))
        tokens = min(self.capacity, tokens + (now - at) * self.rate)
        if tokens < 1:
            self.buckets[key] = (tokens, now)
            return (1 - tokens) / self.rate
        self.buckets[key] = (tokens - 1, now)
        return 0.0


def _passthrough_violation(body: Any, allowed: set[str], numeric_offset: bool) -> str | None:
    """Why a passthrough body is refused, checked at every depth (prefetch nests whole queries)."""
    if isinstance(body, dict):
        lookup = body.get('lookup_from')
        if isinstance(lookup, dict) and lookup.get('collection') not in allowed:
            return 'lookup_from may only name an allowed collection'
        limit = body.get('limit')
        if isinstance(limit, int) and not isinstance(limit, bool) and limit > MAX_LIMIT:
            return f'limit may be at most {MAX_LIMIT}'
        # A scroll offset is a point id to start from, not a count of points to skip.
        offset = body.get('offset')
        if numeric_offset and isinstance(offset, int) and not isinstance(offset, bool) and offset > MAX_OFFSET:
            return f'offset may be at most {MAX_OFFSET}'
        if body.get('with_vector') or body.get('with_vectors'):
            return 'with_vector is not available through this service'
        values = body.values()
    elif isinstance(body, list):
        values = body
    else:
        return None
    for value in values:
        reason = _passthrough_violation(value, allowed, numeric_offset)
        if reason:
            return reason
    return None


async def _read_capped(request: Request, cap: int) -> bytes:
    declared = request.headers.get('content-length')
    if declared and declared.isdigit() and int(declared) > cap:
        raise HTTPException(413, f'Request body over {cap} bytes')
    chunks, size = [], 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > cap:
            raise HTTPException(413, f'Request body over {cap} bytes')
        chunks.append(chunk)
    return b''.join(chunks)


def create_app(
    settings: Settings | None = None,
    corrector: Corrector | None = None,
    transport: httpx.AsyncBaseTransport | None = None,
) -> FastAPI:
    settings = settings or Settings.from_env()
    logging.basicConfig(
        level=os.environ.get('LOG_LEVEL', 'info').upper(),
        format='%(asctime)s %(levelname)s %(name)s %(message)s',
    )
    state: dict[str, Any] = {}
    stamps: dict[str, tuple[dict, float]] = {}
    vectors = VectorCache(settings.query_cache_size)
    limiter = RateLimiter(settings.rate_limit_per_minute)
    token_digests = [hashlib.sha256(t.encode()).digest() for t in settings.service_tokens]

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        if not token_digests:
            raise RuntimeError('SEARCH_SERVICE_TOKENS is empty: no caller could authenticate')
        if settings.fake_embeddings:
            log.warning('FAKE_EMBEDDINGS is on: queries are hashed, not embedded (local only)')
        state['corrector'] = corrector or Corrector(settings.spelling_dir)
        meta = state['corrector'].meta
        log.info(
            'spelling dictionary loaded: policy=%s version=%s terms=%s load_seconds=%.2f',
            meta.get('policy'),
            meta.get('version'),
            meta.get('dictionary_terms'),
            getattr(state['corrector'], 'load_seconds', 0.0),
        )
        qdrant_headers = {'api-key': settings.qdrant_api_key} if settings.qdrant_api_key else {}
        state['qdrant'] = httpx.AsyncClient(
            base_url=settings.qdrant_url, headers=qdrant_headers, timeout=10.0, transport=transport
        )
        state['orchestrator'] = httpx.AsyncClient(
            base_url=settings.orchestrator_endpoint,
            headers={'Authorization': f'Bearer {settings.orchestrator_access_token}'},
            timeout=30.0,
            transport=transport,
        )
        yield
        await state['qdrant'].aclose()
        await state['orchestrator'].aclose()
        state.clear()

    app = FastAPI(
        title='Civitai search service',
        version='1.0.0',
        description='Read-only Qdrant proxy with SymSpell correction and wemm-2b query embedding.',
        lifespan=lifespan,
    )

    def caller(request: Request) -> str:
        scheme, _, token = request.headers.get('authorization', '').partition(' ')
        digest = hashlib.sha256(token.encode()).digest()
        if scheme.lower() != 'bearer' or not token or not any(
            hmac.compare_digest(digest, d) for d in token_digests
        ):
            raise HTTPException(401, 'Missing or invalid service token', {'WWW-Authenticate': 'Bearer'})
        key = digest.hex()[:16]
        wait = limiter.take(key)
        if wait:
            raise HTTPException(429, 'Rate limit exceeded', {'Retry-After': str(max(1, round(wait)))})
        return key

    def alias_for(collection: str) -> str:
        alias = settings.collections.get(collection)
        if not alias:
            raise HTTPException(404, f'Unknown collection {collection!r}')
        return alias

    async def qdrant_json(method: str, path: str, body: Any = None) -> Any:
        try:
            res = await state['qdrant'].request(method, path, json=body)
        except httpx.HTTPError as err:
            raise HTTPException(502, f'Vector index unreachable ({type(err).__name__})') from err
        if res.status_code == 404:
            raise HTTPException(404, 'Collection not available')
        if res.is_error:
            raise HTTPException(502, f'Vector index error ({res.status_code})')
        return res.json()['result']

    async def index_stamp(alias: str) -> dict:
        cached = stamps.get(alias)
        if cached and time.monotonic() - cached[1] < STAMP_TTL_SECONDS:
            return cached[0]
        info = await qdrant_json('GET', f'/collections/{alias}')
        stamp = (info.get('config') or {}).get('metadata') or {}
        stamps[alias] = (stamp, time.monotonic())
        return stamp

    async def embed(text: str, alias: str) -> list[float]:
        stamp = await index_stamp(alias)
        if not stamp.get('modelRevision'):
            raise HTTPException(503, 'The index has no vectors yet')
        key = (
            EMBED_MODEL,
            EMBED_DIMENSIONS,
            stamp.get('modelRevision'),
            stamp.get('profile'),
            hashlib.sha256(text.encode()).hexdigest(),
        )
        cached = vectors.get(key)
        if cached is not None:
            return cached
        if settings.fake_embeddings:
            if stamp.get('modelRevision') != FAKE_STAMP['modelRevision']:
                raise HTTPException(503, 'The search model does not match the index')
            return fake_embedding(text)
        try:
            res = await state['orchestrator'].post(
                '/v2/consumer/recipes/multimodalEmbedding',
                json={
                    'model': EMBED_MODEL,
                    'dimensions': EMBED_DIMENSIONS,
                    'precision': 'float32',
                    'text': text,
                },
            )
        except httpx.HTTPError as err:
            raise HTTPException(502, 'Embedding failed') from err
        data = res.json() if res.is_success else None
        vector = (data or {}).get('embedding')
        if not vector:
            log.warning('embedding failed: status=%s', res.status_code)
            raise HTTPException(502, 'Embedding failed')
        # A query vector from another model or profile is meaningless against the index.
        if data.get('modelRevision') != stamp.get('modelRevision') or data.get('profile') != stamp.get(
            'profile'
        ):
            stamps.pop(alias, None)
            log.error(
                'model mismatch: query=%s/%s index=%s/%s',
                data.get('modelRevision'),
                data.get('profile'),
                stamp.get('modelRevision'),
                stamp.get('profile'),
            )
            raise HTTPException(503, 'The search model does not match the index')
        vectors.put(key, vector)
        return vector

    @app.get('/healthz', tags=['health'])
    async def healthz():
        c = state.get('corrector')
        if not c:
            return JSONResponse({'status': 'starting'}, status_code=503)
        return {
            'status': 'ok',
            'spelling': {'policy': c.meta.get('policy'), 'version': c.meta.get('version')},
            'collections': sorted(settings.collections),
        }

    @app.post('/v1/spell', response_model=SpellResponse, tags=['v1'])
    async def spell(body: SpellRequest, _caller: str = Depends(caller)):
        r = state['corrector'].correct(body.query)
        return SpellResponse(
            query=r['original'],
            corrected=r['query'],
            changed=r['changed'],
            changes=r['changes'],
            skipped=r['skipped'],
            policy=r['policy'],
            version=r['version'],
        )

    @app.post(
        '/v1/search', response_model=SearchResponse, response_model_exclude_none=True, tags=['v1']
    )
    async def search(body: SearchRequest, _caller: str = Depends(caller)):
        alias = alias_for(body.collection)
        if not normalize_query(body.query):
            raise HTTPException(422, 'Enter a search query')
        if body.spellcheck:
            r = state['corrector'].correct(body.query)
            corrected, changes = r['query'], r['changes']
        else:
            corrected, changes = body.query, []
        vector = await embed(normalize_query(corrected), alias)
        result = await qdrant_json(
            'POST',
            f'/collections/{alias}/points/query',
            {
                'query': vector,
                'filter': body.filter,
                'offset': body.offset,
                'limit': body.limit,
                'params': {'quantization': {'rescore': True, 'oversampling': 2}},
                'with_payload': body.with_payload,
            },
        )
        hits = [
            Hit(id=p['id'], score=p['score'], payload=p.get('payload') if body.with_payload else None)
            for p in result.get('points', [])
        ]
        return SearchResponse(query=body.query, corrected=corrected, changes=changes, hits=hits)

    async def forward(request: Request, method: str, path: str, op: str | None = None) -> Response:
        params = {k: v for k, v in request.query_params.items() if k in PASSTHROUGH_PARAMS}
        content = await _read_capped(request, MAX_PASSTHROUGH_BODY) if method == 'POST' else None
        if content:
            try:
                parsed = json.loads(content)
            except ValueError:
                raise HTTPException(400, 'The request body must be JSON') from None
            reason = _passthrough_violation(
                parsed, set(settings.collections.values()), numeric_offset=op != 'scroll'
            )
            if reason:
                raise HTTPException(403 if reason.startswith('lookup_from') else 400, reason)
        try:
            res = await state['qdrant'].request(
                method,
                path,
                params=params,
                content=content,
                headers={'content-type': 'application/json'} if content else None,
            )
        except httpx.HTTPError as err:
            raise HTTPException(502, f'Vector index unreachable ({type(err).__name__})') from err
        return Response(
            content=res.content,
            status_code=res.status_code,
            media_type=res.headers.get('content-type'),
        )

    @app.get('/qdrant/collections/{collection}', tags=['qdrant'])
    async def qdrant_collection(collection: str, request: Request, _caller: str = Depends(caller)):
        """Qdrant's collection info, byte for byte."""
        return await forward(request, 'GET', f'/collections/{alias_for(collection)}')

    @app.post('/qdrant/collections/{collection}/points/{op}', tags=['qdrant'])
    async def qdrant_points(
        collection: str, op: str, request: Request, _caller: str = Depends(caller)
    ):
        """Qdrant's points query, search, recommend, scroll or count, byte for byte."""
        if op not in PASSTHROUGH_OPS:
            raise HTTPException(403, 'Only read operations are allowed')
        return await forward(
            request, 'POST', f'/collections/{alias_for(collection)}/points/{op}', op
        )

    @app.api_route(
        '/qdrant/{rest:path}',
        methods=['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
        include_in_schema=False,
    )
    async def qdrant_refused(rest: str, _caller: str = Depends(caller)):
        raise HTTPException(403, 'Only read operations are allowed')

    return app
