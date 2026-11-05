import json

import pytest

from search_service.spelling import Corrector, build

# A synthetic catalog. Every name here is made up or a public franchise term; never put real
# usernames or catalog exports in this repository.
CATALOG = (
    [
        {
            'name': f'Batman style {i}',
            'tags': ['batman', 'comics'],
            'trigger_words': ['batman'],
            'username': 'darkknightfan',
        }
        for i in range(120)
    ]
    + [
        {'name': f'Watercolor landscape {i}', 'tags': ['watercolor'], 'trigger_words': [], 'username': 'paintpal'}
        for i in range(10)
    ]
)


@pytest.fixture(scope='session')
def catalog_jsonl(tmp_path_factory):
    path = tmp_path_factory.mktemp('catalog') / 'catalog.jsonl'
    path.write_text(''.join(json.dumps(doc) + '\n' for doc in CATALOG))
    return path


@pytest.fixture(scope='session')
def spelling_dir(tmp_path_factory, catalog_jsonl):
    out = tmp_path_factory.mktemp('spelling')
    build(catalog_jsonl, out)
    return out


@pytest.fixture(scope='session')
def loaded_corrector(spelling_dir):
    return Corrector(spelling_dir)
