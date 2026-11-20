#!/usr/bin/env python3
"""Coverage floors for apps/app-data-go (run by .github/workflows/app-data-go.yml; copied from apps/beacon-go/ci).

Reads a Go cover profile (go test -coverprofile) and a floors file, prints statement coverage per
package and in total, and exits 1 when the total or any listed package is below its floor, or when a
listed package is absent from the profile (a package that silently stopped being measured must not
pass as covered), or when a package that has tests (any test event for it in the `go test -json`
output) has no floor, so a new package cannot join unmeasured.

Coverage is statement-weighted, as `go tool cover -func` computes its total: a block counts its
statements once (blocks repeated in the profile are merged, covered if any copy is).

Floors file: one `<package> <percent>` per line, `<package>` relative to the module root
(`internal/store`) or the word `total`; `#` starts a comment. Floors are ratchets, set at a measured
value rounded DOWN to a whole percent: to raise one, read the measured value this script prints in
CI and set the floor to its integer part. Never lower one to get a red run green.
"""

import json
import sys

MODULE = "github.com/civitai/civitai/apps/app-data-go"


def read_profile(path):
    blocks = {}  # (file, span) -> (statements, covered)
    with open(path) as f:
        first = f.readline()
        if not first.startswith("mode:"):
            sys.exit(f"coverage_gate: {path} is not a cover profile (first line {first!r})")
        for line in f:
            line = line.strip()
            if not line:
                continue
            loc, stmts, count = line.rsplit(" ", 2)
            file, span = loc.rsplit(":", 1)
            prev = blocks.get((file, span))
            covered = int(count) > 0 or (prev is not None and prev[1])
            blocks[(file, span)] = (int(stmts), covered)
    return blocks


def per_package(blocks):
    pkgs = {}
    for (file, _), (stmts, covered) in blocks.items():
        pkg = file.rsplit("/", 1)[0]
        if pkg.startswith(MODULE + "/"):
            pkg = pkg[len(MODULE) + 1:]
        elif pkg == MODULE:
            pkg = "."
        total, cov = pkgs.get(pkg, (0, 0))
        pkgs[pkg] = (total + stmts, cov + (stmts if covered else 0))
    return pkgs


def pct(total, cov):
    return 100.0 * cov / total if total else 0.0


def read_floors(path):
    floors = {}
    with open(path) as f:
        for n, line in enumerate(f, 1):
            line = line.split("#", 1)[0].strip()
            if not line:
                continue
            parts = line.split()
            if len(parts) != 2:
                sys.exit(f"coverage_gate: {path}:{n}: want `<package> <percent>`, got {line!r}")
            floors[parts[0]] = float(parts[1])
    return floors


def packages_with_tests(path):
    """Module-relative packages with at least one test event in `go test -json` output."""
    out = set()
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line.startswith("{"):
                continue
            try:
                ev = json.loads(line)
            except ValueError:
                continue
            if ev.get("Test") and ev.get("Package"):
                pkg = ev["Package"]
                if pkg.startswith(MODULE + "/"):
                    pkg = pkg[len(MODULE) + 1:]
                elif pkg == MODULE:
                    pkg = "."
                out.add(pkg)
    return out


def main(argv):
    if len(argv) != 4:
        sys.exit("usage: coverage_gate.py <cover.out> <floors.txt> <test.json>")
    blocks = read_profile(argv[1])
    floors = read_floors(argv[2])
    pkgs = per_package(blocks)
    if not pkgs:
        sys.exit("coverage_gate: the profile holds no blocks; nothing was measured")
    all_stmts = sum(t for t, _ in pkgs.values())
    all_cov = sum(c for _, c in pkgs.values())
    measured = {p: pct(t, c) for p, (t, c) in pkgs.items()}
    measured["total"] = pct(all_stmts, all_cov)

    failures = []
    print(f"{'package':<28} {'stmts':>6} {'coverage':>9} {'floor':>6}")
    for p in sorted(pkgs) + ["total"]:
        stmts = all_stmts if p == "total" else pkgs[p][0]
        floor = floors.get(p)
        mark = ""
        if floor is not None and measured[p] < floor:
            mark = "  BELOW FLOOR"
            failures.append(f"{p}: {measured[p]:.2f}% < floor {floor:g}%")
        elif floor is not None and int(measured[p]) > floor:
            mark = f"  (floor can be raised to {int(measured[p])})"
        floor_s = "-" if floor is None else f"{floor:g}"
        print(f"{p:<28} {stmts:>6} {measured[p]:>8.2f}% {floor_s:>6}{mark}")
    tested = packages_with_tests(argv[3])
    if not tested:
        failures.append(f"no test events in {argv[3]}; cannot tell which packages need a floor")
    for p in sorted(tested):
        if p not in floors:
            failures.append(f"{p}: has tests but no floor in {argv[2]} (add one at its measured value, rounded down)")
    for p in sorted(floors):
        if p not in measured:
            failures.append(f"{p}: listed in the floors file but absent from the profile")
    if failures:
        for f in failures:
            print(f"::error::coverage: {f}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
