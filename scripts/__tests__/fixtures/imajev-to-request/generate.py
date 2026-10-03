"""Regenerates golden.json from cases.json with imajev's own jev_api.to_request.

    git -C <imajev> checkout <IMAJEV_TO_REQUEST_COMMIT in scripts/decision-eval/trainer-dataset.ts>
    python generate.py <imajev>      # needs pydantic>=2,<3

Re-run it whenever that pin moves, and commit the result with the new pin.
"""
import hashlib
import json
import subprocess
import sys
from pathlib import Path

imajev = Path(sys.argv[1]).resolve()
sys.path.insert(0, str(imajev / "src"))
from vision_decision.jev_api import to_request  # noqa: E402

here = Path(__file__).resolve().parent
if subprocess.check_output(["git", "-C", str(imajev), "status", "--porcelain"], text=True).strip():
    sys.exit(f"{imajev} has uncommitted changes; the fixture must come from a clean commit")
commit = subprocess.check_output(["git", "-C", str(imajev), "rev-parse", "HEAD"], text=True).strip()


def js_key_order(pairs):
    """The order a JS object (what serving JSON-encodes) lists these keys in: array-index keys first, ascending."""
    def is_index(k):
        return k.isascii() and k.isdigit() and (k == "0" or not k.startswith("0")) and int(k) < 2**32 - 1
    indexed = sorted((p for p in pairs if is_index(p[0])), key=lambda p: int(p[0]))
    return indexed + [p for p in pairs if not is_index(p[0])]


def to_jev(questions):
    jev = {}
    for q in questions:
        if q["type"] == "choice":
            pairs = js_key_order([(o["key"], o["description"]) for o in q["options"]])
            jev[q["id"]] = {"type": "choice", "instructions": q["instructions"], "criteria": dict(pairs)}
        elif q["type"] == "score":
            jev[q["id"]] = {"type": "score", "instructions": q["instructions"], "criteria": list(q["criteria"])}
        else:
            jev[q["id"]] = {"type": "noul", "instructions": q["instructions"]}
    return jev


def expand(value):
    """{"$repeat": s, "times": n} stands for s * n, so boundary-sized strings stay small on disk."""
    if isinstance(value, dict):
        if set(value) == {"$repeat", "times"}:
            return value["$repeat"] * value["times"]
        return {k: expand(v) for k, v in value.items()}
    if isinstance(value, list):
        return [expand(v) for v in value]
    return value


out = []
for i, raw in enumerate(json.loads((here / "cases.json").read_text(encoding="utf-8"))):
    case = expand(raw)
    jev = to_jev(case["questions"])
    request_id = case.get("requestId", f"case-{i}")
    try:
        request = to_request({"state": case["state"], "questions": jev}, request_id).model_dump(mode="json")
    except Exception:
        request = None
    entry = {"name": case["name"], "requestId": request_id, "jev": jev, "request": request}
    compact = json.dumps(request, separators=(",", ":"), ensure_ascii=False)
    if len(compact) > 16384:
        # Kept as a digest of the compact JSON, which is order-sensitive and so at least as strict.
        entry = {**entry, "request": None, "requestSha256": hashlib.sha256(compact.encode("utf-8")).hexdigest()}
    out.append(entry)

golden = {"imajevCommit": commit, "cases": out}
(here / "golden.json").write_bytes((json.dumps(golden, indent=2, ensure_ascii=False) + "\n").encode("utf-8"))
print(f"{len(out)} cases at {commit}")
