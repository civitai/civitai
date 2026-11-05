"""Parity with the prototype's spelling tests, plus the build path over a synthetic catalog."""

import json
import shutil

import pytest
from symspellpy import SymSpell

from search_service.spelling import POLICY, Corrector, build, quoted_mask


@pytest.fixture
def corrector():
    c = Corrector.__new__(Corrector)
    c.sym = SymSpell(max_dictionary_edit_distance=2)
    for word, count in [
        ('naruto', 3000),
        ('watercolor', 2000),
        ('lighting', 1000),
        ('anima', 10),
        ('anime', 100000),
    ]:
        c.sym.create_dictionary_entry(word, count)
    c.protected = {'naruto', 'watercolor', 'lighting', 'anima'}
    c.creators = {'natuto'}
    c.meta = {'version': 'test'}
    return c


def test_corrects_typo_but_preserves_known_name_and_identifier(corrector):
    assert corrector.correct('natuto watercolor')['query'] == 'naruto watercolor'
    for query in ['anima', 'natuto', 'natuto_v2', 'natuto-123', 'https://host/natuto']:
        assert corrector.correct(query)['query'] == query


def test_preserves_quoted_tokens_with_smart_quotes_and_escapes(corrector):
    for query in ['"natuto" watercolr', '“natuto” watercolr', '"natuto \\"name\\"" watercolr']:
        assert corrector.correct(query)['query'] == query.replace('watercolr', 'watercolor')
    assert not any(quoted_mask(r'\"natuto\"'))


def test_does_not_rewrite_foreign_language_queries(corrector):
    for query in ['natuto lumière', 'natuto 水彩', 'paisajes de fantasía con castillos']:
        assert corrector.correct(query)['query'] == query


def test_ambiguous_suggestions_are_left_unchanged(corrector):
    corrector.sym = SymSpell(max_dictionary_edit_distance=2)
    corrector.sym.create_dictionary_entry('stone', 100)
    corrector.sym.create_dictionary_entry('stove', 90)
    assert corrector.correct('stome')['query'] == 'stome'


def test_change_keeps_the_case_of_the_source(corrector):
    result = corrector.correct('Natuto WATERCOLR')
    assert result['query'] == 'Naruto WATERCOLOR'
    assert result['changes'] == [
        {'from': 'Natuto', 'to': 'Naruto', 'distance': 1},
        {'from': 'WATERCOLR', 'to': 'WATERCOLOR', 'distance': 1},
    ]


def test_built_dictionary_corrects_batmen_and_protects_creators(loaded_corrector):
    c = loaded_corrector
    assert c.meta['policy'] == POLICY
    assert c.correct('Batmen')['query'] == 'Batman'
    assert c.correct('batmen in the rain')['query'] == 'batman in the rain'
    # A whole query that is a creator's name is never rewritten, nor is any token of it.
    assert c.correct('darkknightfan')['query'] == 'darkknightfan'


def test_build_refuses_nothing_private_into_the_dictionary(spelling_dir):
    # Usernames are protected terms, never dictionary entries a query could be corrected TO.
    terms = {line.split(' ')[0] for line in (spelling_dir / 'spelling-dictionary.txt').open()}
    assert 'darkknightfan' not in terms
    protected = json.loads((spelling_dir / 'spelling-protected.private.json').read_text())
    assert 'darkknightfan' in protected['creators']


def test_corrector_refuses_another_policy(spelling_dir, tmp_path):
    copy = shutil.copytree(spelling_dir, tmp_path / 'copy')
    manifest = json.loads((copy / 'spelling.json').read_text())
    (copy / 'spelling.json').write_text(json.dumps({**manifest, 'policy': 'other'}))
    with pytest.raises(RuntimeError, match='policy'):
        Corrector(copy)


def test_build_is_deterministic(tmp_path, catalog_jsonl):
    a = build(catalog_jsonl, tmp_path / 'a')
    b = build(catalog_jsonl, tmp_path / 'b')
    assert a['version'] == b['version']
    assert (tmp_path / 'a/spelling-dictionary.txt').read_bytes() == (
        tmp_path / 'b/spelling-dictionary.txt'
    ).read_bytes()
