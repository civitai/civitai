# Tests and the mutation battery

Demoted from `SKILL.md` 2026-08-24 (size prune). VERBATIM from the pre-prune core — this
replaces an earlier summarised copy that had silently dropped the `apply_mutant` counting
rule and the fixture provenance (caught by the prune's own gap audit).

Tests (offline, no browser, no imagemagick): `tests/run-tests-app-capture.sh`, and the
mutation battery `tests/mutants-app-capture.sh` (count it, don't quote one — "89" rotted).
🔴 **They differ in cost by two orders of magnitude — the suite is ~100 s, the battery re-runs
it once per mutant, so a full sweep is HOURS** (measured 2026-08-23: ~101 s per suite run,
once for every `apply_mutant` line — count them, as above, rather than quoting a number).
After touching one guard re-measure only its own: `MUTANTS_ONLY="M59 M60"`, which prints a
PARTIAL banner and fails if a name matched nothing, so it can never be mistaken for a sweep.
🔴 The battery exits **3** for "could not measure" (dead interpreter / unparseable tree)
and **1** for a verdict; a 3 is never a claim about a mutant.
🔴 **A PREFLIGHT checks EVERY mutant's `sed` target — including the ones a scoped run skips**
(added 2026-09-02). `apply_mutant` has always reported BROKEN when a target stops matching,
but only for a mutant the run REACHES, so the recommended `MUTANTS_ONLY=` re-measurement could
silently unhook a *neighbouring* mutant and leave no trace. Four were found sitting broken that
day (M169/M174/M178, and M128 on `trunk`). A target that matches nothing leaves the file
pristine, the suite passes, and **the battery reads as coverage**. The preflight is a BROKEN
count (exit 1) — a claim about the battery's wiring, not about the box — and costs milliseconds
against an hours-long sweep. Fixtures are REAL captured
DOM; where a case needs a screen the corpus lacks — an empty list, a repeated grid — it is
cut from a real capture by `tests/fixtures/app-capture/domsurgery.py`, an independent
scanner that shares no code with the parser under test.

The two SCREEN fixtures follow the same rule and are the same kind of thing on the two axes:
`tests/fixtures/app-capture/bannershift.py` cuts the rewards-banner layout (the frame moves
DOWN at constant width), `tests/fixtures/app-capture/framewiden.py` cuts the re-tiled-window
layout (the frame moves RIGHT at constant width). 🔴 **Both build the second state by
TRANSLATING pixels, so "the app does not move relative to its frame" is true BY CONSTRUCTION
in each and is not evidence about any real app.** They grade the resolution arithmetic — sign
flips, the wrong axis, an inset read as a coordinate, off-by-ones — which they do hard; the
physical claim needs a live re-shoot.
