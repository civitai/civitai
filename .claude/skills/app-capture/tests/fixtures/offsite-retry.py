#!/usr/bin/env python3
"""Gate O — attach-offsite.py's transport policy, exercised OFFLINE.

No network, no credential, no listing. The module is imported with
CIVITAI_CONFIG pointed at a throwaway file, which is the only reason it can be
imported at all: it resolves its token at module scope, and before that env
override existed a `import attach_offsite` on a box without a config died in
`load_cfg`.

What this grades is the SAFETY claim, not the convenience one: which calls may
be re-sent. Retrying a listing mutation is how one "failed" upload becomes two
attachments, so `RETRYABLE_ROUTES` is an asserted LEDGER — it fails when the set
grows as well as when it shrinks.
"""
import importlib.util
import os
import sys
import tempfile

SCRIPTS = sys.argv[1]
bad = []

# ── import the module offline ────────────────────────────────────────────────
tmp = tempfile.mkdtemp()
cfg = os.path.join(tmp, "config.yaml")
with open(cfg, "w") as fh:
    fh.write('token: "test-token-not-a-credential"\nbase_url: "https://example.invalid"\n')
os.environ["CIVITAI_CONFIG"] = cfg

spec = importlib.util.spec_from_file_location("attach_offsite",
                                              os.path.join(SCRIPTS, "attach-offsite.py"))
if spec is None or spec.loader is None:
    print(f"could not load attach-offsite.py from {SCRIPTS}")
    sys.exit(1)
mod = importlib.util.module_from_spec(spec)
try:
    spec.loader.exec_module(mod)
except SystemExit as e:
    print(f"module refused to import offline: {e}")
    sys.exit(1)

# The override must actually have been used — otherwise this whole file graded
# whatever real credential happens to be on the box.
if getattr(mod, "BASE", None) != "https://example.invalid":
    bad.append(f"CIVITAI_CONFIG was ignored — BASE={getattr(mod, 'BASE', None)!r}, "
               "so this gate read a real config")

# 🔴 CHECK THE SURFACE EXISTS BEFORE GRADING IT. Without this the gate dies on an
# AttributeError at the first missing name — which stops at ONE finding and reads
# in the harness like the test is broken rather than like the feature is absent.
# Run against the pre-retry version of this file, that is exactly what happened.
REQUIRED = ("retry_delay", "RETRYABLE_ROUTES", "RETRYABLE_CODES",
            "MAX_ATTEMPTS", "BACKOFF_BASE", "HTTP_TIMEOUT")
missing = [n for n in REQUIRED if not hasattr(mod, n)]
if missing:
    print("attach-offsite.py is missing its transport policy: " + ", ".join(missing))
    print("  (no bounded retry / no explicit timeout — a transient endpoint is a hard failure)")
    sys.exit(1)

# ── O1: the retryable-route LEDGER, asserted whole ───────────────────────────
EXPECTED = {
    "appListings.getMyListingForEdit",
    "appListings.getAssetScanStatuses",
    "appListings.ingestAssetFromDataUri",
    "appListings.persistAssetImage",
}
if set(mod.RETRYABLE_ROUTES) != EXPECTED:
    grew = set(mod.RETRYABLE_ROUTES) - EXPECTED
    shrank = EXPECTED - set(mod.RETRYABLE_ROUTES)
    bad.append(f"RETRYABLE_ROUTES drifted — added={sorted(grew)} removed={sorted(shrank)}")

# 🔴 The four that must NEVER be retryable, named individually so the failure
# message says WHICH one was let in. These change the listing.
#
# addScreenshot is the sharpest of them: setIcon/setCover at least overwrite a
# single slot, so a duplicate send is idempotent-ish. addScreenshot APPENDS, so a
# re-send leaves TWO screenshots on a live listing.
for route in ("appListings.setIcon", "appListings.setCover",
              "appListings.addScreenshot", "appListings.submitListingRevision"):
    if route in mod.RETRYABLE_ROUTES:
        bad.append(f"{route} is RETRYABLE — a re-send of a listing mutation duplicates media")

# ── O6: the screenshot path exists and gates before sending ──────────────────
for name in ("existing_screenshot_count", "gate_bounds", "CAPTION_MAX"):
    if not hasattr(mod, name):
        bad.append(f"attach-offsite.py has no {name} — the screenshot path is not wired")
if getattr(mod, "CAPTION_MAX", None) != 280:
    bad.append(f"CAPTION_MAX={getattr(mod, 'CAPTION_MAX', None)}, "
               "server LISTING_SCREENSHOT_CAPTION_MAX is 280")

# ── O2: the pure policy, both directions ─────────────────────────────────────
# NEGATIVE: a 4xx that is not a transient must not be retried, ever.
for code in (400, 401, 403, 404, 409, 422):
    if mod.retry_delay(1, code=code) is not None:
        bad.append(f"HTTP {code} is retried — it is a statement about the request")

# POSITIVE control for that zero: the transients MUST be retried on attempt 1,
# or the negative above is passing because retry_delay returns None for everything.
for code in (408, 429, 500, 502, 503, 504):
    if mod.retry_delay(1, code=code) is None:
        bad.append(f"HTTP {code} is NOT retried — the transient set is wired to nothing")

# A socket-level failure carries no code and must still be retried.
if mod.retry_delay(1, exc=OSError("connection reset")) is None:
    bad.append("a socket failure is not retried — that is the measured failure mode")

# ── O3: the attempt ceiling actually stops ───────────────────────────────────
if mod.retry_delay(mod.MAX_ATTEMPTS, code=500) is not None:
    bad.append("retry_delay does not stop at MAX_ATTEMPTS — an outage becomes a hang")
if mod.retry_delay(mod.MAX_ATTEMPTS + 5, exc=OSError("x")) is not None:
    bad.append("retry_delay does not stop past MAX_ATTEMPTS")
# ...and that it permits enough attempts to cover the MEASURED failure: three
# consecutive failures, success on the fourth. A ceiling of 3 would not.
if mod.MAX_ATTEMPTS < 4:
    bad.append(f"MAX_ATTEMPTS={mod.MAX_ATTEMPTS} cannot cover the measured 3-fail/4th-succeeds case")
if mod.retry_delay(3, code=503) is None:
    bad.append("the third failure is not retried — the measured case needs a fourth attempt")

# ── O4: the backoff widens rather than hammering ─────────────────────────────
delays = [mod.retry_delay(i, code=503) for i in range(1, mod.MAX_ATTEMPTS)]
if any(d is None for d in delays):
    bad.append(f"a pre-ceiling attempt returned None: {delays}")
elif not all(b > a for a, b in zip(delays, delays[1:])):
    bad.append(f"backoff does not widen: {delays}")

# ── O5: a timeout is actually set ────────────────────────────────────────────
# urlopen's default is None (block forever), so this constant existing is the
# whole guard against a silent hang.
if not isinstance(mod.HTTP_TIMEOUT, (int, float)) or mod.HTTP_TIMEOUT <= 0:
    bad.append(f"HTTP_TIMEOUT is not a positive number: {mod.HTTP_TIMEOUT!r}")

print("\n".join(bad))
sys.exit(1 if bad else 0)
