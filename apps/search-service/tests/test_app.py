import json

import httpx
import pytest
from fastapi.testclient import TestClient

from search_service.app import EMBED_DIMENSIONS, EMBED_MODEL, create_app
from search_service.config import Settings

TOKEN = 'test-token'
AUTH = {'Authorization': f'Bearer {TOKEN}'}
STAMP = {'modelRevision': 'rev-1', 'profile': 'p1'}
VECTOR = [0.5] * EMBED_DIMENSIONS


class Upstream:
    """A fake Qdrant and orchestrator that records each request it is sent."""

    def __init__(self):
        self.calls: list[httpx.Request] = []
        self.embedding = {'embedding': VECTOR, **STAMP}
        self.stamp = STAMP
        self.points_status = 200

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.calls.append(request)
        path = request.url.path
        if request.url.host == 'orchestrator.test':
            return httpx.Response(200, json=self.embedding)
        if path == '/collections/images_semantic' and request.method == 'GET':
            return httpx.Response(200, json={'result': {'config': {'metadata': self.stamp}}})
        if path == '/collections/models_semantic':
            return httpx.Response(404, json={'status': {'error': 'Not found'}})
        if path.startswith('/collections/images_semantic/points/'):
            if self.points_status != 200:
                return httpx.Response(self.points_status, json={'status': {'error': 'boom'}})
            # Deliberately odd formatting: the passthrough must return these bytes untouched.
            return httpx.Response(
                200,
                content=b'{"result":{"points":[{"id":7,"score":0.9,"payload":{"nsfwLevel":1}},'
                b'{"id":3,"score":0.5,"payload":{"nsfwLevel":2}}]} ,"status":"ok"}',
                headers={'content-type': 'application/json'},
            )
        return httpx.Response(500)

    def sent(self, host=None, path=None):
        return [
            c
            for c in self.calls
            if (host is None or c.url.host == host) and (path is None or c.url.path == path)
        ]


@pytest.fixture
def upstream():
    return Upstream()


@pytest.fixture
def client(spelling_dir, loaded_corrector, upstream):
    settings = Settings(
        qdrant_url='http://qdrant.test:6333',
        qdrant_api_key='qdrant-secret',
        orchestrator_endpoint='https://orchestrator.test',
        orchestrator_access_token='orch-secret',
        service_tokens=frozenset({TOKEN}),
        spelling_dir=str(spelling_dir),
        rate_limit_per_minute=1000,
    )
    app = create_app(settings, corrector=loaded_corrector, transport=httpx.MockTransport(upstream))
    with TestClient(app) as c:
        yield c


# --- auth ------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    'method,path,body',
    [
        ('POST', '/v1/search', {'collection': 'images', 'query': 'cat'}),
        ('POST', '/v1/spell', {'query': 'cat'}),
        ('GET', '/qdrant/collections/images', None),
        ('POST', '/qdrant/collections/images/points/query', {}),
        ('DELETE', '/qdrant/collections/images', None),
    ],
)
@pytest.mark.parametrize('headers', [{}, {'Authorization': 'Bearer wrong'}, {'Authorization': TOKEN}])
def test_every_route_but_health_needs_a_valid_token(client, upstream, method, path, body, headers):
    res = client.request(method, path, json=body, headers=headers)
    assert res.status_code == 401
    assert upstream.calls == []


def test_healthz_is_open_and_reports_the_dictionary(client):
    res = client.get('/healthz')
    assert res.status_code == 200
    assert res.json()['spelling']['policy'] == 'catalog-conservative-v1'


def test_startup_fails_without_dictionary(tmp_path):
    settings = Settings(service_tokens=frozenset({TOKEN}), spelling_dir=str(tmp_path / 'missing'))
    with pytest.raises(FileNotFoundError), TestClient(create_app(settings)):
        pass


def test_startup_fails_without_service_tokens(spelling_dir):
    settings = Settings(spelling_dir=str(spelling_dir))
    with pytest.raises(RuntimeError), TestClient(create_app(settings)):
        pass


def test_rate_limit_per_token(spelling_dir, loaded_corrector, upstream):
    settings = Settings(
        service_tokens=frozenset({TOKEN, 'other'}), spelling_dir=str(spelling_dir), rate_limit_per_minute=2
    )
    with TestClient(create_app(settings, corrector=loaded_corrector, transport=httpx.MockTransport(upstream))) as c:
        codes = [c.post('/v1/spell', json={'query': 'x'}, headers=AUTH).status_code for _ in range(3)]
        assert codes == [200, 200, 429]
        assert c.post('/v1/spell', json={'query': 'x'}, headers={'Authorization': 'Bearer other'}).status_code == 200


# --- passthrough -----------------------------------------------------------------------------


@pytest.mark.parametrize('op', ['query', 'search', 'recommend', 'scroll', 'count'])
def test_read_operations_pass_through_byte_for_byte(client, upstream, op):
    body = b'{"limit": 2,  "with_payload": true}'
    res = client.post(
        f'/qdrant/collections/images/points/{op}?timeout=5&wait=true',
        content=body,
        headers={**AUTH, 'content-type': 'application/json'},
    )
    assert res.status_code == 200
    assert res.content.startswith(b'{"result":{"points":[{"id":7,')
    (sent,) = upstream.sent(path=f'/collections/images_semantic/points/{op}')
    assert sent.content == body
    assert sent.url.params.get('timeout') == '5'
    assert 'wait' not in sent.url.params
    assert sent.headers['api-key'] == 'qdrant-secret'
    assert 'authorization' not in sent.headers


def test_collection_info_passes_through(client, upstream):
    res = client.get('/qdrant/collections/images', headers=AUTH)
    assert res.status_code == 200
    assert res.json()['result']['config']['metadata'] == STAMP


def test_upstream_errors_pass_through(client, upstream):
    upstream.points_status = 400
    res = client.post('/qdrant/collections/images/points/query', json={}, headers=AUTH)
    assert res.status_code == 400
    assert res.json() == {'status': {'error': 'boom'}}


@pytest.mark.parametrize(
    'method,path',
    [
        ('PUT', '/qdrant/collections/images/points'),
        ('POST', '/qdrant/collections/images/points/delete'),
        ('POST', '/qdrant/collections/images/points/payload'),
        ('PUT', '/qdrant/collections/images/points/payload'),
        ('POST', '/qdrant/collections/images/points/vectors/delete'),
        ('PUT', '/qdrant/collections/images/points/query'),
        ('DELETE', '/qdrant/collections/images'),
        ('PATCH', '/qdrant/collections/images'),
        ('PUT', '/qdrant/collections/images'),
        ('PUT', '/qdrant/collections/images/index'),
        ('POST', '/qdrant/collections/images/snapshots'),
        ('GET', '/qdrant/collections'),
        ('POST', '/qdrant/collections/aliases'),
        ('GET', '/qdrant/cluster'),
        ('POST', '/qdrant/collections/images/points/query/batch'),
    ],
)
def test_everything_else_is_refused(client, upstream, method, path):
    res = client.request(method, path, json={'points': []}, headers=AUTH)
    assert res.status_code == 403
    assert upstream.calls == []


def test_unknown_collection_is_refused(client, upstream):
    for path in ['/qdrant/collections/private_stuff', '/qdrant/collections/images_semantic']:
        assert client.get(path, headers=AUTH).status_code == 404
    assert client.post('/qdrant/collections/secrets/points/scroll', json={}, headers=AUTH).status_code == 404
    assert upstream.calls == []


def test_lookup_from_another_collection_is_refused(client, upstream):
    body = {'query': {'recommend': {'positive': [1]}}, 'lookup_from': {'collection': 'private_stuff'}}
    nested = {'prefetch': [{'query': 1, 'lookup_from': {'collection': 'private_stuff'}}]}
    for b in [body, nested]:
        res = client.post('/qdrant/collections/images/points/query', json=b, headers=AUTH)
        assert res.status_code == 403
    assert upstream.calls == []
    ok = {**body, 'lookup_from': {'collection': 'images_semantic'}}
    assert client.post('/qdrant/collections/images/points/query', json=ok, headers=AUTH).status_code == 200


# --- /v1 -------------------------------------------------------------------------------------


def test_spell_corrects_batmen(client, upstream):
    res = client.post('/v1/spell', json={'query': 'Batmen'}, headers=AUTH)
    assert res.status_code == 200
    body = res.json()
    assert body['corrected'] == 'Batman'
    assert body['changes'] == [{'from': 'Batmen', 'to': 'Batman', 'distance': 1}]
    assert upstream.calls == []


def test_search_corrects_embeds_and_queries(client, upstream):
    res = client.post(
        '/v1/search',
        json={
            'collection': 'images',
            'query': '  Batmen   in the rain ',
            'filter': {'must': [{'key': 'nsfwLevel', 'match': {'any': [1]}}]},
            'limit': 2,
            'offset': 4,
        },
        headers=AUTH,
    )
    assert res.status_code == 200, res.text
    assert res.json() == {
        'query': '  Batmen   in the rain ',
        'corrected': '  Batman   in the rain ',
        'changes': [{'from': 'Batmen', 'to': 'Batman', 'distance': 1}],
        'hits': [{'id': 7, 'score': 0.9}, {'id': 3, 'score': 0.5}],
    }
    (embed,) = upstream.sent(host='orchestrator.test')
    assert embed.url.path == '/v2/consumer/recipes/multimodalEmbedding'
    assert embed.headers['authorization'] == 'Bearer orch-secret'
    assert json.loads(embed.content) == {
        'model': EMBED_MODEL,
        'dimensions': 256,
        'precision': 'float32',
        'text': 'Batman in the rain',
    }
    (query,) = upstream.sent(path='/collections/images_semantic/points/query')
    assert json.loads(query.content) == {
        'query': VECTOR,
        'filter': {'must': [{'key': 'nsfwLevel', 'match': {'any': [1]}}]},
        'offset': 4,
        'limit': 2,
        'params': {'quantization': {'rescore': True, 'oversampling': 2}},
        'with_payload': False,
    }


def test_search_returns_payload_when_asked(client):
    res = client.post(
        '/v1/search', json={'collection': 'images', 'query': 'cat', 'with_payload': True}, headers=AUTH
    )
    assert res.json()['hits'][0] == {'id': 7, 'score': 0.9, 'payload': {'nsfwLevel': 1}}


def test_search_without_spellcheck_embeds_the_query_as_given(client, upstream):
    res = client.post(
        '/v1/search', json={'collection': 'images', 'query': 'Batmen', 'spellcheck': False}, headers=AUTH
    )
    assert res.json()['corrected'] == 'Batmen'
    assert res.json()['changes'] == []
    (embed,) = upstream.sent(host='orchestrator.test')
    assert json.loads(embed.content)['text'] == 'Batmen'


def test_query_vectors_are_cached(client, upstream):
    for _ in range(3):
        assert client.post('/v1/search', json={'collection': 'images', 'query': 'cat'}, headers=AUTH).status_code == 200
    assert len(upstream.sent(host='orchestrator.test')) == 1
    assert len(upstream.sent(path='/collections/images_semantic')) == 1
    assert len(upstream.sent(path='/collections/images_semantic/points/query')) == 3


def test_model_mismatch_is_refused_and_not_cached(client, upstream):
    upstream.embedding = {'embedding': VECTOR, 'modelRevision': 'rev-2', 'profile': 'p1'}
    res = client.post('/v1/search', json={'collection': 'images', 'query': 'cat'}, headers=AUTH)
    assert res.status_code == 503
    assert upstream.sent(path='/collections/images_semantic/points/query') == []
    upstream.embedding = {'embedding': VECTOR, **STAMP}
    assert client.post('/v1/search', json={'collection': 'images', 'query': 'cat'}, headers=AUTH).status_code == 200


def test_empty_index_is_unavailable(client, upstream):
    upstream.stamp = {}
    res = client.post('/v1/search', json={'collection': 'images', 'query': 'cat'}, headers=AUTH)
    assert res.status_code == 503


def test_missing_collection_is_not_found(client):
    res = client.post('/v1/search', json={'collection': 'models', 'query': 'cat'}, headers=AUTH)
    assert res.status_code == 404
    res = client.post('/v1/search', json={'collection': 'nope', 'query': 'cat'}, headers=AUTH)
    assert res.status_code == 404


@pytest.mark.parametrize(
    'body',
    [
        {'collection': 'images', 'query': ''},
        {'collection': 'images', 'query': '   '},
        {'collection': 'images', 'query': 'cat', 'limit': 101},
        {'collection': 'images', 'query': 'cat', 'offset': 2001},
    ],
)
def test_search_rejects_bad_input(client, upstream, body):
    assert client.post('/v1/search', json=body, headers=AUTH).status_code == 422
    assert upstream.sent(host='orchestrator.test') == []


def test_secrets_never_reach_the_log(spelling_dir, loaded_corrector, upstream, caplog):
    caplog.set_level('DEBUG')
    settings = Settings(
        qdrant_url='http://qdrant.test:6333',
        qdrant_api_key='qdrant-secret',
        orchestrator_endpoint='https://orchestrator.test',
        orchestrator_access_token='orch-secret',
        service_tokens=frozenset({TOKEN}),
        spelling_dir=str(spelling_dir),
    )
    upstream.embedding = {'embedding': VECTOR, 'modelRevision': 'rev-2'}
    with TestClient(create_app(settings, corrector=loaded_corrector, transport=httpx.MockTransport(upstream))) as c:
        c.post('/v1/search', json={'collection': 'images', 'query': 'cat'}, headers=AUTH)
    assert 'model mismatch' in caplog.text
    for secret in ['qdrant-secret', 'orch-secret', TOKEN]:
        assert secret not in caplog.text
    assert 'qdrant-secret' not in repr(settings)




def test_fake_embeddings_refuse_a_real_index(spelling_dir, loaded_corrector, upstream):
    settings = Settings(
        qdrant_url='http://qdrant.test:6333',
        orchestrator_endpoint='https://orchestrator.test',
        service_tokens=frozenset({TOKEN}),
        spelling_dir=str(spelling_dir),
        fake_embeddings=True,
    )
    app = create_app(settings, corrector=loaded_corrector, transport=httpx.MockTransport(upstream))
    with TestClient(app) as c:
        res = c.post('/v1/search', json={'collection': 'images', 'query': 'cat'}, headers=AUTH)
        assert res.status_code == 503
    assert upstream.sent(host='orchestrator.test') == []


# --- passthrough bounds ----------------------------------------------------------------------

QUERY = '/qdrant/collections/images/points/query'


def test_passthrough_body_over_64kb_is_refused(client, upstream):
    big = b'{"limit": 1, "pad": "' + b'x' * (64 * 1024) + b'"}'
    res = client.post(QUERY, content=big, headers={**AUTH, 'content-type': 'application/json'})
    assert res.status_code == 413
    # Without a content-length the stream is still cut off at the cap.
    res = client.post(
        QUERY, content=iter([big[:40000], big[40000:]]), headers={**AUTH, 'content-type': 'application/json'}
    )
    assert res.status_code == 413
    assert upstream.calls == []
    ok = b'{"limit": 1, "pad": "' + b'x' * 60000 + b'"}'
    assert client.post(QUERY, content=ok, headers={**AUTH, 'content-type': 'application/json'}).status_code == 200


@pytest.mark.parametrize(
    'op,body,message',
    [
        ('query', {'limit': 101}, 'limit'),
        ('search', {'vector': [0.1], 'limit': 1000}, 'limit'),
        ('scroll', {'limit': 5000}, 'limit'),
        ('recommend', {'positive': [1], 'limit': 101}, 'limit'),
        ('query', {'limit': 10, 'prefetch': [{'query': [0.1], 'limit': 10000}]}, 'limit'),
        ('query', {'prefetch': {'prefetch': [{'limit': 101}]}}, 'limit'),
        ('query', {'limit': 10, 'offset': 2001}, 'offset'),
        ('search', {'vector': [0.1], 'offset': 100000}, 'offset'),
        ('query', {'with_vector': True}, 'with_vector'),
        ('scroll', {'with_vector': ['default']}, 'with_vector'),
        ('query', {'prefetch': [{'query': 1, 'with_vectors': True}]}, 'with_vector'),
    ],
)
def test_passthrough_bounds_are_refused(client, upstream, op, body, message):
    res = client.post(f'/qdrant/collections/images/points/{op}', json=body, headers=AUTH)
    assert res.status_code == 400
    assert message in res.json()['detail']
    assert upstream.calls == []


@pytest.mark.parametrize(
    'op,body',
    [
        ('query', {'limit': 100, 'offset': 2000, 'with_vector': False}),
        ('query', {'prefetch': [{'query': [0.1], 'limit': 100}], 'limit': 10}),
        # A scroll offset is a point id, so a large one is a position, not a cost.
        ('scroll', {'limit': 100, 'offset': 9_999_999}),
        ('count', {'exact': True}),
    ],
)
def test_passthrough_bounds_allow_the_ceiling(client, upstream, op, body):
    assert client.post(f'/qdrant/collections/images/points/{op}', json=body, headers=AUTH).status_code == 200


def test_passthrough_refuses_a_body_that_is_not_json(client, upstream):
    res = client.post(QUERY, content=b'{"limit": 1000', headers={**AUTH, 'content-type': 'application/json'})
    assert res.status_code == 400
    assert upstream.calls == []
