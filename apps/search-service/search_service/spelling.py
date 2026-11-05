"""Catalog-aware SymSpell correction applied to text queries before they are embedded.

Ported from the catalog search prototype with the same policy (`catalog-conservative-v1`), regexes and
thresholds. A change to any of them is a new policy, not a tweak: bump POLICY when you make one.

The dictionary files are produced by `python -m search_service.spelling build` and are NEVER
committed: the protected list holds creator usernames.
"""

import argparse
import hashlib
import json
import logging
import math
import re
import time
import unicodedata
from collections import Counter
from importlib.resources import files
from pathlib import Path

from symspellpy import SymSpell, Verbosity

TOKEN = re.compile(r"\b\w+(?:[-'.:/@]\w+)*\b", re.UNICODE)
WORD = re.compile(r'[^\W_]+', re.UNICODE)
POLICY = 'catalog-conservative-v1'

DICTIONARY_FILE = 'spelling-dictionary.txt'
PROTECTED_FILE = 'spelling-protected.private.json'
MANIFEST_FILE = 'spelling.json'

log = logging.getLogger(__name__)


def normalized(text):
    return unicodedata.normalize('NFKC', text).casefold()


def _rss():
    try:
        status = Path('/proc/self/status').read_text().splitlines()
        return int(next(line.split()[1] for line in status if line.startswith('VmRSS:'))) * 1024
    except (OSError, StopIteration):
        return 0


def build(source, out_dir, model_revision=None):
    """Write the three dictionary files from a JSONL of {name, tags, trigger_words, username}."""
    started = time.perf_counter()
    counts = Counter()
    protected = set()
    creators = set()
    documents = 0
    digest = hashlib.sha256()
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    with Path(source).open('rb') as f:
        for raw in f:
            digest.update(raw)
            doc = json.loads(raw)
            documents += 1
            for key in ['name', 'tags', 'trigger_words']:
                value = doc.get(key) or ''
                text = ' '.join(value) if isinstance(value, list) else value
                terms = set(
                    normalized(t) for t in WORD.findall(text) if 3 <= len(t) <= 32 and t.isalpha()
                )
                counts.update(terms)
                if key in ['name', 'trigger_words']:
                    protected.update(terms)
            creator = normalized(doc.get('username') or '')
            if creator:
                creators.add(creator)
                protected.update(normalized(t) for t in TOKEN.findall(creator))
    # General English words protect ordinary grammatical queries. Their counts are compressed so
    # catalog entities remain competitive with web frequencies.
    english = {}
    with files('symspellpy').joinpath('frequency_dictionary_en_82_765.txt').open() as f:
        for line in f:
            term, count = line.rsplit(' ', 1)
            if term.isascii() and term.isalpha():
                english[term] = max(3, int(math.log10(max(10, int(count))) ** 2))
    candidates = {word: count for word, count in counts.items() if count >= 3 and word.isascii()}
    for term, count in english.items():
        candidates[term] = max(count, candidates.get(term, 0))
    protected.update(english)
    version = hashlib.sha256((digest.hexdigest() + POLICY).encode()).hexdigest()
    dictionary = out_dir / DICTIONARY_FILE
    protected_path = out_dir / PROTECTED_FILE
    dictionary.write_text(''.join(f'{term} {count}\n' for term, count in sorted(candidates.items())))
    protected_path.write_text(json.dumps({'terms': sorted(protected), 'creators': sorted(creators)}))
    manifest = {
        'status': 'complete',
        'policy': POLICY,
        'version': version,
        'fingerprint': digest.hexdigest(),
        'documents': documents,
        'dictionary_terms': len(candidates),
        'protected_terms': len(protected),
        'creators': len(creators),
        'dictionary_bytes': dictionary.stat().st_size,
        'protected_bytes': protected_path.stat().st_size,
        'build_seconds': time.perf_counter() - started,
        'implementation': 'symspellpy 6.9.0 (Python port of SymSpell)',
        'model_revision': model_revision,
    }
    (out_dir / MANIFEST_FILE).write_text(json.dumps(manifest, indent=2))
    return manifest


def quoted_mask(query):
    """Mark literal quoted spans using the same escaping rules as the query parser."""
    query = query.replace('“', '"').replace('”', '"')
    mask = [False] * len(query)
    inside = False
    i = 0
    while i < len(query):
        c = query[i]
        if c == '\\' and i + 1 < len(query) and query[i + 1] in ('"', '\\'):
            mask[i] = mask[i + 1] = inside
            i += 2
            continue
        if c in ('"', '“', '”'):
            inside = not inside
            mask[i] = True
        else:
            mask[i] = inside
        i += 1
    return mask


class Corrector:
    def __init__(self, directory):
        started = time.perf_counter()
        before = _rss()
        directory = Path(directory)
        self.meta = json.loads((directory / MANIFEST_FILE).read_text())
        if self.meta.get('policy') != POLICY:
            raise RuntimeError(f"Spelling dictionary policy {self.meta.get('policy')!r} is not {POLICY!r}")
        # Optional: only checked when the directory also carries the embedding manifest it was built with.
        corpus_meta = directory / 'embedding.json'
        if (
            corpus_meta.exists()
            and json.loads(corpus_meta.read_text()).get('fingerprint') != self.meta['fingerprint']
        ):
            raise RuntimeError('Spelling dictionary belongs to another catalog snapshot')
        self.sym = SymSpell(max_dictionary_edit_distance=2, prefix_length=7)
        if not self.sym.load_dictionary(directory / DICTIONARY_FILE, 0, 1):
            raise RuntimeError('Spelling dictionary unavailable')
        protected = json.loads((directory / PROTECTED_FILE).read_text())
        self.protected = set(protected['terms'])
        self.creators = set(protected['creators'])
        self.load_seconds = time.perf_counter() - started
        self.rss_delta_bytes = max(0, _rss() - before)

    def correct(self, query):
        started = time.perf_counter()
        mask = quoted_mask(query)
        changes = []
        parts = []
        cursor = 0
        # This dictionary corrects English/catalog terms. Leave accented and non-Latin queries intact
        # instead of treating foreign words as typos.
        non_english = any(c.isalpha() and not c.isascii() and not mask[i] for i, c in enumerate(query))
        if normalized(query) not in self.creators and not non_english:
            for match in TOKEN.finditer(query):
                source = match.group()
                term = normalized(source)
                if any(mask[match.start() : match.end()]) or term in self.protected:
                    continue
                if not term.isascii() or not term.isalpha() or not 4 <= len(term) <= 32:
                    continue
                suggestions = self.sym.lookup(
                    term, Verbosity.CLOSEST, max_edit_distance=1 if len(term) < 8 else 2
                )
                if not suggestions or suggestions[0].distance == 0:
                    continue
                best = suggestions[0]
                runner = suggestions[1].count if len(suggestions) > 1 else 0
                if best.count < 5 or best.count < runner * 3:
                    continue
                replacement = (
                    best.term.upper()
                    if source.isupper()
                    else best.term.capitalize()
                    if source.istitle()
                    else best.term
                )
                parts.extend([query[cursor : match.start()], replacement])
                cursor = match.end()
                changes.append({'from': source, 'to': replacement, 'distance': best.distance})
        corrected = ''.join(parts) + query[cursor:] if changes else query
        return {
            'original': query,
            'query': corrected,
            'changed': bool(changes),
            'changes': changes,
            'ms': (time.perf_counter() - started) * 1000,
            'policy': POLICY,
            'version': self.meta['version'],
            'skipped': 'non_ascii_query' if non_english else None,
        }


def main():
    parser = argparse.ArgumentParser(description='Build the spelling dictionary files.')
    sub = parser.add_subparsers(dest='action', required=True)
    b = sub.add_parser('build')
    b.add_argument('--source', required=True, help='JSONL of {name, tags, trigger_words, username}')
    b.add_argument('--out', required=True, help='Directory to write the three files into')
    b.add_argument('--model-revision', default=None)
    args = parser.parse_args()
    print(json.dumps(build(args.source, args.out, args.model_revision)), flush=True)


if __name__ == '__main__':
    main()
