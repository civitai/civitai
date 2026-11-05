import os
from dataclasses import dataclass, field


def _collections(raw: str) -> dict[str, str]:
    out = {}
    for pair in raw.split(','):
        if not pair.strip():
            continue
        name, _, alias = pair.partition('=')
        out[name.strip()] = (alias or name).strip()
    return out


@dataclass(frozen=True)
class Settings:
    qdrant_url: str = 'http://localhost:6333'
    qdrant_api_key: str = field(default='', repr=False)
    orchestrator_endpoint: str = 'https://orchestration.civitai.com'
    orchestrator_access_token: str = field(default='', repr=False)
    service_tokens: frozenset[str] = field(default=frozenset(), repr=False)
    # Public collection name -> Qdrant collection or alias. Only these are reachable.
    collections: dict[str, str] = field(
        default_factory=lambda: {'images': 'images_semantic', 'models': 'models_semantic'}
    )
    spelling_dir: str = '/data/spelling'
    rate_limit_per_minute: int = 600
    query_cache_size: int = 5000
    # Local development only: embed with a deterministic hash instead of the orchestrator. The fake
    # vectors carry their own model revision, so the index stamp check refuses them on a real index.
    fake_embeddings: bool = False

    @classmethod
    def from_env(cls) -> 'Settings':
        e = os.environ
        default = cls()
        return cls(
            qdrant_url=e.get('QDRANT_URL', default.qdrant_url).rstrip('/'),
            qdrant_api_key=e.get('QDRANT_API_KEY', ''),
            orchestrator_endpoint=(
                e.get('ORCHESTRATOR_ENDPOINT') or default.orchestrator_endpoint
            ).rstrip('/'),
            orchestrator_access_token=e.get('ORCHESTRATOR_ACCESS_TOKEN', ''),
            service_tokens=frozenset(
                t.strip() for t in e.get('SEARCH_SERVICE_TOKENS', '').split(',') if t.strip()
            ),
            collections=_collections(e['SEARCH_COLLECTIONS'])
            if e.get('SEARCH_COLLECTIONS')
            else default.collections,
            spelling_dir=e.get('SPELLING_DIR', default.spelling_dir),
            rate_limit_per_minute=int(e.get('RATE_LIMIT_PER_MINUTE', default.rate_limit_per_minute)),
            query_cache_size=int(e.get('QUERY_CACHE_SIZE', default.query_cache_size)),
            fake_embeddings=e.get('FAKE_EMBEDDINGS', '').lower() in ('1', 'true'),
        )
