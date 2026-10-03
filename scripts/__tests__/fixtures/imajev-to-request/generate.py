"""Regenerates golden.json from cases.json with imajev's own jev_api.to_request.

    git -C <imajev> checkout <IMAJEV_TO_REQUEST_COMMIT in scripts/decision-eval/trainer-dataset.ts>
    python generate.py <imajev>      # needs pydantic>=2,<3

Re-run it whenever that pin moves, and commit the result with the new pin.
"""
import json
import subprocess
import sys
from pathlib import Path

imajev = Path(sys.argv[1]).resolve()
sys.path.insert(0, str(imajev / "src"))
from vision_decision.jev_api import to_request  # noqa: E402

here = Path(__file__).resolve().parent
commit = subprocess.check_output(["git", "-C", str(imajev), "rev-parse", "HEAD"], text=True).strip()


def to_jev(questions):
    jev = {}
    for q in questions:
        if q["type"] == "choice":
            jev[q["id"]] = {"type": "choice", "instructions": q["instructions"],
                            "criteria": {o["key"]: o["description"] for o in q["options"]}}
        elif q["type"] == "score":
            jev[q["id"]] = {"type": "score", "instructions": q["instructions"], "criteria": list(q["criteria"])}
        else:
            jev[q["id"]] = {"type": "noul", "instructions": q["instructions"]}
    return jev


out = []
for i, case in enumerate(json.loads((here / "cases.json").read_text(encoding="utf-8"))):
    jev = to_jev(case["questions"])
    request_id = f"case-{i}"
    try:
        request = to_request({"state": case["state"], "questions": jev}, request_id).model_dump(mode="json")
    except Exception:
        request = None
    out.append({**case, "requestId": request_id, "jev": jev, "request": request})

golden = {"imajevCommit": commit, "cases": out}
(here / "golden.json").write_bytes((json.dumps(golden, indent=2, ensure_ascii=False) + "\n").encode("utf-8"))
print(f"{len(out)} cases at {commit}")
