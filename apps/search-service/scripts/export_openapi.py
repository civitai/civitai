"""Write openapi.json from the app. CI-free: run it after changing a route or model.

Usage: python scripts/export_openapi.py [--check]
"""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from search_service.app import create_app  # noqa: E402
from search_service.config import Settings  # noqa: E402

spec = json.dumps(create_app(Settings()).openapi(), indent=2) + '\n'
target = ROOT / 'openapi.json'
if '--check' in sys.argv:
    if target.read_text() != spec:
        sys.exit('openapi.json is stale: run python scripts/export_openapi.py')
    print('openapi.json is current')
else:
    target.write_text(spec)
    print(f'wrote {target}')
