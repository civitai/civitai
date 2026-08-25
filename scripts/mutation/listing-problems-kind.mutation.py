#!/usr/bin/env python3
"""Mutation battery for the KIND dimension of the listing-completeness advisory.

Committed so the PR's mutation claims are AUDITABLE FROM ARTIFACTS rather than
reconstructible only from a table in the PR body. Re-run it and diff the output.

    scripts/mutation/listing-problems-kind.mutation.py            # run the battery
    scripts/mutation/listing-problems-kind.mutation.py --list     # just print the mutants

Method, and why each part is there:

  * Each mutant asserts its target text occurs EXACTLY ONCE before replacing. A
    `count=1` replace on an ambiguous pattern hits an occurrence you did not picture.
  * Each mutant is the NARROWEST expression that can be wrong. None removes a guard
    together with its enclosing condition — that kind of mutant dies for the wrong
    reason and proves nothing about the guard.
  * BASELINE RECONCILIATION: the baseline total is measured at the start, and every
    mutant's run must produce the SAME total. A run whose total differs was truncated
    or panicked, so its verdict is UNATTRIBUTED — never SURVIVED. (A sibling battery
    once scored a mutant SURVIVED off a run that died a quarter of the way in.)
  * DEFINED vs VERDICTS-PRODUCED are reported separately, so a mutant that silently
    failed to apply cannot be counted as coverage.
  * M0 is a POSITIVE CONTROL: a mutant known to be caught, kept in the batch so a run
    that has stopped executing anything cannot report a clean sweep.

Every mutation is reverted from a byte copy of the original in a `finally`, so an
interrupted run leaves the tree clean.
"""
from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RUNNER = ROOT / "scripts/mutation/listing-problems-kind.suite.sh"
RUN_LOG = ROOT / ".mutation-run.log"

LP = "src/server/services/blocks/listing-problems.ts"
AA = "src/server/services/blocks/app-access.service.ts"
BR = "src/server/routers/blocks.router.ts"
OS_ = "src/server/services/blocks/offsite-listing.service.ts"

CAT_ONSITE = (
    "'Missing category — resubmit to apply it; "
    "set \"category\" in block.manifest.json first if your app has none'"
)

# id, file, find, replace, what defect it expresses
MUTANTS: list[tuple[str, str, str, str, str]] = [
    ("M0-CTRL", LP,
     "'empty-tagline': 'Missing tagline',",
     "'empty-tagline': 'MUTANT-CONTROL',",
     "POSITIVE CONTROL: off-site tagline label is garbage. Must die loudly."),

    ("M1", LP,
     "listing.kind === 'onsite' ? TEXT_PROBLEM.onsite : TEXT_PROBLEM.offsite",
     "listing.kind === 'offsite' ? TEXT_PROBLEM.onsite : TEXT_PROBLEM.offsite",
     "the kind comparison names the WRONG literal (arms swapped)."),

    ("M2", LP,
     "listing.kind === 'onsite' ? TEXT_PROBLEM.onsite : TEXT_PROBLEM.offsite",
     "listing.kind === 'onsite' ? TEXT_PROBLEM.offsite : TEXT_PROBLEM.offsite",
     "the ON-SITE arm collapses to off-site == THE ORIGINAL DEFECT, exactly."),

    ("M3", LP,
     "listing.kind === 'onsite' ? TEXT_PROBLEM.onsite : TEXT_PROBLEM.offsite",
     "listing.kind === 'onsite' ? TEXT_PROBLEM.onsite : TEXT_PROBLEM.onsite",
     "the OFF-SITE arm gets manifest advice (the defect pointing the other way)."),

    ("M4", LP,
     "'empty-tagline': 'Missing tagline — set \"tagline\" in block.manifest.json and resubmit',",
     "'empty-tagline': 'Missing tagline',",
     "ONE on-site label regresses to the original; the others stay correct."),

    ("M5", LP,
     "'empty-description':\n      'Missing description — set \"description\" in block.manifest.json and resubmit',",
     "'empty-description':\n      'Missing description — set \"tagline\" in block.manifest.json and resubmit',",
     "an on-site label names the WRONG manifest key."),

    ("M6", LP,
     "problems.push({ code: 'empty-tagline', label: text['empty-tagline'], severity: 'advisory' });",
     "problems.push({ code: 'empty-tagline', label: text['empty-description'], severity: 'advisory' });",
     "the label lookup uses the WRONG key at one push site."),

    ("M7", LP,
     "  if (isEmpty(listing.category))\n    problems.push({ code: 'empty-category', label: text['empty-category'], severity: 'advisory' });",
     "  if (isEmpty(listing.category))\n    problems.push({ code: 'empty-category', label: TEXT_PROBLEM.offsite['empty-category'], severity: 'advisory' });",
     "one code stays kind-BLIND while the other two are fixed (a PARTIAL fix)."),

    ("M8", AA,
     "          kind,\n          iconId: r.iconId ?? null,",
     "          kind: 'offsite' as typeof kind,\n          iconId: r.iconId ?? null,",
     "CALLER 1 (listMine) hardcodes offsite instead of threading the row's kind."),

    ("M9", AA,
     "          kind,\n          iconId: r.iconId ?? null,",
     "          kind: 'onsite' as typeof kind,\n          iconId: r.iconId ?? null,",
     "CALLER 1 hardcodes onsite (the mirror of M8)."),

    ("M10", BR,
     "              kind: listing.kind as ListingProblemKind,",
     "              kind: 'onsite' as ListingProblemKind,",
     "CALLER 2 spells its where-clause's conclusion instead of reading the column."),

    ("M11", BR,
     "          status: true,\n          kind: true,\n          iconId: true,",
     "          status: true,\n          iconId: true,",
     "CALLER 2 stops PROJECTING kind (the silent-revert route)."),

    ("M12", OS_,
     "          kind: (r.appListing.kind ?? 'offsite') as ListingProblemKind,",
     "          kind: 'offsite' as ListingProblemKind,",
     "CALLER 3 hardcodes offsite — wrong for the on-site media revisions it returns."),

    ("M13", OS_,
     "      kind: true,\n      iconId: true,\n      coverId: true,",
     "      iconId: true,\n      coverId: true,",
     "CALLER 3 stops PROJECTING the listing's kind."),

    # --- added after the #4370 adversarial audit ------------------------------
    ("M14", OS_,
     "          kind: (r.appListing.kind ?? 'offsite') as ListingProblemKind,",
     "          kind: (r.kind ?? 'offsite') as ListingProblemKind,",
     "CALLER 3 reads the REQUEST's kind instead of the LISTING's. SURVIVED the "
     "pre-audit battery, because every fixture set the two equal — the audit found "
     "it. Killed now by the one fixture that makes them disagree."),

    ("M15", LP,
     "    'empty-category':\n      " + CAT_ONSITE + ",",
     "    'empty-category': 'Missing category — set \"category\" in block.manifest.json and resubmit',",
     "the on-site category label reverts to MANIFEST-FIRST — the wrong diagnosis the "
     "audit caught: inert once a moderator has curated, because (3a)'s null-gate no "
     "longer fires."),
]


def run() -> tuple[int | None, int | None, list[str]]:
    p = subprocess.run(["bash", str(RUNNER), str(RUN_LOG)], capture_output=True, text=True)
    out = p.stdout
    m = re.search(
        r"Tests\s+(?:(\d+) failed \| )?(\d+) passed(?: \| (\d+) skipped)? \((\d+)\)", out
    )
    if not m:
        return None, None, ["<<UNPARSEABLE>>: " + out.strip()[:400]]
    return int(m.group(1) or 0), int(m.group(4)), [l for l in out.splitlines() if l.startswith("× ")]


def main() -> int:
    if "--list" in sys.argv:
        for mid, rel, _f, _r, why in MUTANTS:
            print(f"{mid:9} {rel.split('/')[-1]:28} {why}")
        return 0

    print("measuring baseline (unmutated tree)...", flush=True)
    base_failed, baseline_total, _ = run()
    if base_failed is None:
        print("FATAL: could not parse the baseline run; is the suite runnable?")
        return 2
    if base_failed:
        print(f"FATAL: baseline is RED ({base_failed} failing). Fix that before mutating.")
        return 2
    print(f"baseline: {baseline_total} tests, 0 failing\n", flush=True)

    results = []
    for mid, rel, find, repl, why in MUTANTS:
        path = ROOT / rel
        orig = path.read_text()
        n = orig.count(find)
        if n != 1:
            results.append({"id": mid, "file": rel, "why": why,
                            "verdict": "NOT-APPLIED", "occurrences": n})
            print(f"{mid}: NOT-APPLIED (target occurs {n}x, expected exactly 1)", flush=True)
            continue
        backup = path.with_suffix(path.suffix + ".mutbak")
        shutil.copyfile(path, backup)
        try:
            path.write_text(orig.replace(find, repl, 1))
            failed, total, names = run()
            if failed is None:
                verdict = "UNATTRIBUTED (unparseable run)"
            elif total != baseline_total:
                verdict = f"UNATTRIBUTED (total {total} != baseline {baseline_total})"
            elif failed > 0:
                verdict = "KILLED"
            else:
                verdict = "SURVIVED"
            results.append({"id": mid, "file": rel, "why": why, "verdict": verdict,
                            "failed": failed, "total": total, "killers": names})
            print(f"{mid}: {verdict}  failed={failed} total={total}", flush=True)
            for nm in names[:6]:
                print("      " + nm, flush=True)
        finally:
            shutil.copyfile(backup, path)
            backup.unlink()

    (ROOT / "scripts/mutation/listing-problems-kind.results.json").write_text(
        json.dumps({"baselineTotal": baseline_total, "results": results}, indent=2) + "\n"
    )
    RUN_LOG.unlink(missing_ok=True)

    defined = len(MUTANTS)
    produced = sum(1 for r in results if r.get("verdict") in ("KILLED", "SURVIVED"))
    killed = sum(1 for r in results if r.get("verdict") == "KILLED")
    survived = sum(1 for r in results if r.get("verdict") == "SURVIVED")
    print(f"\nDEFINED={defined}  VERDICTS-PRODUCED={produced}  KILLED={killed}  "
          f"SURVIVED={survived}  OTHER={defined - produced}")
    return 0 if (produced == defined and killed == defined) else 1


if __name__ == "__main__":
    sys.exit(main())
