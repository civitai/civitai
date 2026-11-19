#!/usr/bin/env python3
"""allocs/op regression gate for apps/feed-go benchmarks (run by .github/workflows/feed-go.yml).

Compares `go test -bench -benchmem -count=N` output of the merge-base (base) and the PR head and
exits 1 when a benchmark's allocs/op regressed significantly. ns/op and B/op are NOT gated: shared
runners make time noisy, and benchstat's report in the job log covers them.

Regression rule (explicit): a benchmark fails when it has at least MIN_SAMPLES samples on each side
and EVERY head sample exceeds EVERY base sample by more than THRESHOLD, i.e.
    min(head) > max(base) * (1 + THRESHOLD)    and    min(head) > max(base).
Complete separation of two samples of 6 is the most extreme rank order, so the exact two-sided
Mann-Whitney U test (benchstat's test) gives p = 2 / C(12, 6) = 0.0022 for it: the rule implies
"> THRESHOLD increase with p < 0.05" and is stricter than it. allocs/op is deterministic for these
benchmarks, so a real regression separates completely and noise does not.

Benchmarks present on one side only are reported, not gated (a new benchmark has no baseline).
"""

import re
import sys

THRESHOLD = 0.05
MIN_SAMPLES = 6

LINE = re.compile(r"^(Benchmark\S+?)(?:-\d+)?\s+\d+\s+.*?\s(\d+(?:\.\d+)?) allocs/op")


def parse(path):
    out = {}
    pkg = ""
    with open(path) as f:
        for line in f:
            if line.startswith("pkg: "):
                pkg = line[5:].strip().rsplit("/apps/feed-go/", 1)[-1]
                continue
            m = LINE.match(line)
            if m:
                out.setdefault(f"{pkg}.{m.group(1)}", []).append(float(m.group(2)))
    return out


def main(argv):
    if len(argv) != 3:
        sys.exit("usage: allocs_gate.py <base.txt> <head.txt>")
    base, head = parse(argv[1]), parse(argv[2])
    if not head:
        # Positive control: zero parsed lines means the benchmarks did not run or the format moved,
        # never "no regression".
        print(f"::error::allocs gate: no benchmark result with allocs/op parsed from {argv[2]}")
        return 1
    failures = []
    print(f"{'benchmark':<52} {'base allocs/op':>16} {'head allocs/op':>16}  verdict")
    for name in sorted(set(base) | set(head)):
        b, h = base.get(name), head.get(name)
        if b is None:
            print(f"{name:<52} {'-':>16} {_span(h):>16}  new (no baseline)")
            continue
        if h is None:
            print(f"{name:<52} {_span(b):>16} {'-':>16}  removed")
            continue
        if len(b) < MIN_SAMPLES or len(h) < MIN_SAMPLES:
            failures.append(f"{name}: {len(b)} base / {len(h)} head samples, need {MIN_SAMPLES} each")
            print(f"{name:<52} {_span(b):>16} {_span(h):>16}  too few samples")
            continue
        regressed = min(h) > max(b) and min(h) > max(b) * (1 + THRESHOLD)
        verdict = "REGRESSED" if regressed else "ok"
        if regressed:
            change = (min(h) / max(b) - 1) * 100 if max(b) else float("inf")
            failures.append(f"{name}: allocs/op {_span(b)} -> {_span(h)} (+{change:.1f}%, p=0.002)")
        print(f"{name:<52} {_span(b):>16} {_span(h):>16}  {verdict}")
    if failures:
        for f in failures:
            print(f"::error::allocs/op regression: {f}")
        return 1
    return 0


def _span(xs):
    lo, hi = min(xs), max(xs)
    return f"{lo:g}" if lo == hi else f"{lo:g}..{hi:g}"


if __name__ == "__main__":
    sys.exit(main(sys.argv))
