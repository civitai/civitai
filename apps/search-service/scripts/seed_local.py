"""Create a local `images_semantic` collection with fake vectors, for running the service offline.

Usage: python scripts/seed_local.py [--qdrant http://localhost:6333] [--catalog examples/sample-catalog.jsonl]

Points get ids 1..N, the payload fields the main app filters on, and vectors from the same fake
embedding FAKE_EMBEDDINGS=1 uses, so a query for "batman" ranks the Batman rows first.
Refuses to touch a collection that does not carry the fake stamp.
"""

import argparse
import json
import sys
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from search_service.app import EMBED_DIMENSIONS, FAKE_STAMP, fake_embedding  # noqa: E402

COLLECTION = 'images_semantic'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--qdrant', default='http://localhost:6333')
    parser.add_argument('--catalog', default=str(Path(__file__).resolve().parents[1] / 'examples/sample-catalog.jsonl'))
    args = parser.parse_args()
    q = httpx.Client(base_url=args.qdrant, timeout=30)

    existing = q.get(f'/collections/{COLLECTION}')
    if existing.status_code == 200:
        metadata = existing.json()['result']['config'].get('metadata') or {}
        if metadata.get('modelRevision') != FAKE_STAMP['modelRevision']:
            sys.exit(f'{COLLECTION} exists and is not a local fake collection; refusing to touch it')
        q.delete(f'/collections/{COLLECTION}').raise_for_status()

    q.put(
        f'/collections/{COLLECTION}',
        json={'vectors': {'size': EMBED_DIMENSIONS, 'distance': 'Cosine'}, 'metadata': FAKE_STAMP},
    ).raise_for_status()
    points = []
    for i, line in enumerate(Path(args.catalog).read_text().splitlines(), start=1):
        doc = json.loads(line)
        points.append(
            {
                'id': i,
                'vector': fake_embedding(doc['name']),
                'payload': {'name': doc['name'], 'nsfwLevel': 1, 'tagIds': [], 'type': 'image'},
            }
        )
    q.put(f'/collections/{COLLECTION}/points?wait=true', json={'points': points}).raise_for_status()
    print(f'seeded {len(points)} points into {COLLECTION} at {args.qdrant}')


if __name__ == '__main__':
    main()
