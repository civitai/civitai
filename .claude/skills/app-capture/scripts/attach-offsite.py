#!/usr/bin/env python3
"""attach-offsite.py — attach media to an OFFSITE listing, which the CLI refuses.

  attach-offsite.py --app $SLUG [--icon F] [--cover F]
                    [--screenshot F [--caption C]]... --changelog "why" [--confirm]

🔴 WITHOUT --confirm IT MUTATES NOTHING. It resolves the listing, prints what it
would do, and exits 3 — mirroring attach.sh, which is the sibling path for ONSITE
apps. There is no env var and no interactive prompt a runaway loop could satisfy.

Why this exists at all
----------------------
`civitai app listing …` exits 4 for an offsite app: it resolves a listing through
the app's block submission, and an offsite app is a registered URL with no
submission. Its message goes further and says media changes are "only possible in
the App-store listing UI" — that part is WRONG. The listing id is published on the
public /api/v1/apps route and every listing proc accepts it. Verified 2026-08-16
on both offsite apps; see civitai/cli#422.

What it does, in the order the CLI itself would
-----------------------------------------------
  icon       -> appListings.ingestAssetFromDataUri     (the icon-only lean path)
  cover      -> /api/v1/image-upload -> presigned PUT -> appListings.persistAssetImage
  screenshot -> the same upload path, then appListings.addScreenshot
  all        -> setIcon / setCover / addScreenshot against the SHADOW revision,
                never the parent -> poll the scan, then submitListingRevision

🔴 EVERY ASSET IS GATED AGAINST store-bounds.json BEFORE ANYTHING IS SENT, in the
dry run too — delegated to `frame.py bounds`, the same call attach.sh makes, so
the offsite path cannot drift from the onsite one. The screenshot gate is passed
the TOTAL that would be on the listing (existing + new), not the number being
added: the max-count rule is about the end state, and passing only the new count
lets 3 additions onto a listing already holding 7 sail past a cap of 8.

🔴 setIcon/setCover MUST target the shadow. Addressing the parent is the same
id-space bug that made `reorder` 400 on every live listing (civitai/cli#430).

🔴 submitListingRevision is idempotent: on a shadow that was already submitted it
REPLACES the staged asset and returns the EXISTING publish-request id rather than
opening a second review.
"""
import argparse
import base64
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

# ── Transport policy ─────────────────────────────────────────────────────────
# 🔴 `urlopen` WITHOUT A TIMEOUT BLOCKS FOREVER. Python's default is
# `socket.getdefaulttimeout()`, which is None unless something sets it, and
# nothing here does — so before this constant existed a stalled connection hung
# the script with no output and no exit. That is a worse failure than the one
# this file's retry exists for, because a hang has no error message to read.
HTTP_TIMEOUT = 60

# Bounded retry for the SAFE steps only (see `RETRYABLE` below). Three attempts
# with a widening gap covers the measured failure — persistAssetImage failing
# three times CONSECUTIVELY and succeeding on the fourth — without turning a
# genuinely-down endpoint into a long silent wait.
MAX_ATTEMPTS = 4
BACKOFF_BASE = 2.0

# Server-side transients. 408/429 and 5xx are the ones where "try again" is a
# reasonable reading; a 4xx that is not one of those is a statement about the
# REQUEST and will fail identically forever.
RETRYABLE_CODES = frozenset({408, 429, 500, 502, 503, 504})

# Mirrors civitai/civitai LISTING_SCREENSHOT_CAPTION_MAX. Checked client-side so
# an over-long caption fails before anything is uploaded, rather than after.
CAPTION_MAX = 280


def retry_delay(attempt, code=None, exc=None):
    """PURE. Seconds to wait before re-attempting, or None to give up.

    Split out from the request path on purpose: it is the only DECISION in this
    file's transport, and a pure function is the half `run-tests-app-capture.sh`
    can exercise with no network, no credential and no listing — the same split
    plan.py/frame.py already use.

    `attempt` is 1-based and counts the try that just FAILED.
    """
    if attempt >= MAX_ATTEMPTS:
        return None
    if exc is not None:
        # A socket-level failure (connection reset, DNS, read timeout). The
        # request may or may not have reached the server — which is exactly why
        # only listing-SAFE calls are retried; see RETRYABLE.
        return BACKOFF_BASE ** (attempt - 1)
    if code in RETRYABLE_CODES:
        return BACKOFF_BASE ** (attempt - 1)
    return None

CFG = os.environ.get("CIVITAI_CONFIG") or os.path.expanduser("~/.config/civitai/config.yaml")
# Cloudflare 1010-bans the default Python-urllib signature on civitai.com; the Go
# CLI passes with no UA at all, so mirror an ordinary client string.
UA = "Go-http-client/2.0"


def load_cfg():
    cfg = {}
    with open(CFG) as fh:
        for line in fh:
            if ":" in line:
                k, v = line.split(":", 1)
                cfg[k.strip()] = v.strip().strip('"')
    token = cfg.get("token") or cfg.get("access_token")
    if not token:
        sys.exit(f"no credential in {CFG} — run `civitai login`")
    return token, cfg.get("base_url", "https://civitai.com")


TOKEN, BASE = load_cfg()


def req(url, data=None, headers=None, method=None, retry=False):
    """One HTTP round trip.

    🔴 `retry=True` IS NOT A FREE UPGRADE — it is only correct for a call that
    cannot change the LISTING. See `RETRYABLE` at the call sites: a client
    timeout is not evidence the server did nothing, so re-sending a listing
    mutation is how one "failed" upload becomes two attachments.

    Catches URLError as well as HTTPError. It used to catch only HTTPError, so a
    connection reset or read timeout escaped as an unhandled traceback — the
    exact failure this file's retry is for arrived in the least diagnosable
    shape available.
    """
    h = {"User-Agent": UA}
    if headers:
        h.update(headers)
    attempt = 0
    while True:
        attempt += 1
        r = urllib.request.Request(url, data=data, headers=h, method=method)
        code = exc = None
        try:
            with urllib.request.urlopen(r, timeout=HTTP_TIMEOUT) as resp:
                return resp.status, resp.read().decode(errors="replace")
        except urllib.error.HTTPError as e:
            code, body = e.code, e.read().decode(errors="replace")
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            exc, body = e, f"{type(e).__name__}: {e}"

        delay = retry_delay(attempt, code=code, exc=exc) if retry else None
        if delay is None:
            # A socket failure is reported as status 0 — shaped like an HTTP
            # failure so every caller's `code != 200` branch reports it instead
            # of unwinding as a traceback, and 0 is not a status any server
            # sends, so it cannot be mistaken for one. The `or 0` also keeps the
            # return type a plain int for callers that do `200 <= pc < 300`;
            # exactly one of `code`/`exc` is ever set, but the arithmetic should
            # not depend on a reader knowing that.
            return (code if code is not None else 0), body
        why = f"HTTP {code}" if code is not None else type(exc).__name__
        print(f"  transient {why} on attempt {attempt}/{MAX_ATTEMPTS} — retrying in {delay:.0f}s",
              file=sys.stderr)
        time.sleep(delay)


# 🔴 THE ONLY tRPC ROUTES THIS FILE MAY RETRY, and the list is a SAFETY claim,
# not a convenience one. Every route here is either a pure read or a call that
# provably does not touch the listing:
#
#   getMyListingForEdit / getAssetScanStatuses — reads.
#   ingestAssetFromDataUri / persistAssetImage — they MINT AN IMAGE and return
#     its id. Attachment happens later and separately, in setIcon/setCover. So a
#     re-send can at worst orphan an image row that nothing references; it
#     cannot produce a second attached asset.
#
# DELIBERATELY ABSENT, and they must stay absent: setIcon, setCover and
# submitListingRevision. Those DO change the listing, a client timeout is not
# evidence the server did nothing, and re-sending one is precisely how three
# "failed" uploads become three attachments.
RETRYABLE_ROUTES = frozenset({
    "appListings.getMyListingForEdit",
    "appListings.getAssetScanStatuses",
    "appListings.ingestAssetFromDataUri",
    "appListings.persistAssetImage",
})

# 🔴 appListings.addScreenshot is ABSENT from the set above and that is the whole
# point of the distinction: it APPENDS a row. `setIcon`/`setCover` at least
# overwrite a single slot, so a duplicate send is idempotent-ish; a re-sent
# addScreenshot leaves TWO screenshots on the listing. It is the single most
# dangerous route in this file to retry, which is why gate O1 names it.


def trpc(route, payload, query=False):
    auth = {"Authorization": f"Bearer {TOKEN}"}
    retry = route in RETRYABLE_ROUTES
    if query:
        q = urllib.parse.urlencode({"input": json.dumps({"json": payload})})
        code, body = req(f"{BASE}/api/trpc/{route}?{q}", headers=auth, retry=retry)
    else:
        code, body = req(f"{BASE}/api/trpc/{route}",
                         data=json.dumps({"json": payload}).encode(),
                         headers={**auth, "Content-Type": "application/json"},
                         retry=retry)
    if code != 200:
        sys.exit(f"{route} -> HTTP {code}: {body[:400]}")
    return json.loads(body)["result"]["data"]["json"]


def resolve_listing(slug):
    """The listing id comes off the PUBLIC route — the authed lookup needs an
    appBlockId an offsite app does not have.

    🔴 ALWAYS read the status code here. /api/v1/apps/<slug> has returned a 500
    whose BODY is shaped exactly like a valid response ({"iconUrl": null, ...}),
    which is indistinguishable from a real answer if you only parse the JSON.
    (`?limit=100` on the list route is rejected 400; 50 is accepted. Avoided
    entirely by asking for the one app.)"""
    code, body = req(f"{BASE}/api/v1/apps/{urllib.parse.quote(slug)}", retry=True)
    if code != 200:
        sys.exit(f"/api/v1/apps/{slug} -> HTTP {code} — fields would mean nothing")
    a = json.loads(body)
    if not a.get("id"):
        sys.exit(f"/api/v1/apps/{slug} returned 200 with no id — refusing to guess")
    return a["id"], a.get("kind")


def dims(path):
    """Width/height/mime without an ImageMagick dependency (PNG + JPEG only)."""
    with open(path, "rb") as fh:
        head = fh.read(32)
        fh.seek(0)
        blob = fh.read()
    if head[:8] == b"\x89PNG\r\n\x1a\n":
        return int.from_bytes(blob[16:20], "big"), int.from_bytes(blob[20:24], "big"), "image/png"
    if head[:2] == b"\xff\xd8":
        i = 2
        while i < len(blob) - 9:
            if blob[i] != 0xFF:
                i += 1
                continue
            m = blob[i + 1]
            if m in (0xC0, 0xC1, 0xC2, 0xC3):
                return (int.from_bytes(blob[i + 7:i + 9], "big"),
                        int.from_bytes(blob[i + 5:i + 7], "big"), "image/jpeg")
            i += 2 + int.from_bytes(blob[i + 2:i + 4], "big")
    sys.exit(f"{path}: only png and jpeg are supported here")


def ingest_icon(path):
    data = open(path, "rb").read()
    uri = "data:image/png;base64," + base64.b64encode(data).decode()
    return trpc("appListings.ingestAssetFromDataUri", {"dataUri": uri, "kind": "icon"})["imageId"]


def ingest_full(path):
    w, h, mime = dims(path)
    data = open(path, "rb").read()
    code, body = req(f"{BASE}/api/v1/image-upload", data=b"",
                     headers={"Authorization": f"Bearer {TOKEN}"}, method="POST",
                     retry=True)
    if code != 200:
        sys.exit(f"image-upload -> HTTP {code}: {body[:300]}")
    up = json.loads(body)
    # signed for a BARE put — no Content-Type, no Authorization, or the sig breaks
    pc, pb = req(up["uploadURL"], data=data, method="PUT", retry=True)
    if not (200 <= pc < 300):
        sys.exit(f"presigned PUT -> HTTP {pc}: {pb[:300]}")
    return trpc("appListings.persistAssetImage", {
        "url": up["id"], "width": w, "height": h,
        "mimeType": mime, "sizeBytes": len(data)})["imageId"]


def existing_screenshot_count(slug):
    """How many screenshots the listing ALREADY has, read WITHOUT mutating it.

    🔴 `civitai app listing status` is not a pure read — on a live listing it
    opens a shadow revision draft. The public per-app route is, and it is the
    only one that carries the field: `/api/v1/apps` (the LIST route) has no
    `screenshots` key at all, so a zero from there is a missing field rather
    than an empty set.
    """
    code, body = req(f"{BASE}/api/v1/apps/{urllib.parse.quote(slug)}", retry=True)
    if code != 200:
        sys.exit(f"/api/v1/apps/{slug} -> HTTP {code} — cannot count existing screenshots, "
                 "and guessing would let the max-count gate pass on a full listing")
    shots = json.loads(body).get("screenshots")
    if shots is None:
        sys.exit(f"/api/v1/apps/{slug} returned no `screenshots` field — refusing to "
                 "treat an absent field as zero")
    return len(shots)


def gate_bounds(kind, files, total_count):
    """Delegate to frame.py — the SINGLE source of the store bounds.

    🔴 Deliberately NOT a second copy of the numbers. `store-bounds.json` is the
    one place they live and `attach.sh` already gates the onsite path through
    exactly this call, so the offsite path gets the same rules instead of a
    parallel set that can drift.

    🔴 `--count` is the TOTAL that would be on the listing, not the number being
    added — the max-count rule is about the end state. Passing only the new
    count lets 3 additions onto a listing already holding 7 sail past a cap of 8.
    """
    import subprocess
    frame = os.environ.get("APP_CAPTURE_FRAME") or os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "frame.py")
    r = subprocess.run([sys.executable, frame, "bounds", kind, *files,
                        "--count", str(total_count)],
                       capture_output=True, text=True)
    if r.returncode != 0:
        sys.stderr.write(r.stdout + r.stderr)
        sys.exit(f"store bounds violated for {kind} — refusing to attach.")


def poll_scan(image_id, tries=20):
    for _ in range(tries):
        out = trpc("appListings.getAssetScanStatuses", {"imageIds": [image_id]}, query=True)
        st = (out.get("statuses") or [{}])[0].get("status")
        if st == "scanned":
            return True
        if st == "blocked":
            sys.exit(f"image {image_id} was BLOCKED by the content scanner")
        time.sleep(3)
    return False


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--app", required=True)
    p.add_argument("--icon")
    p.add_argument("--cover")
    # Mirrors attach.sh's interface on purpose: --caption attaches to the
    # --screenshot it follows, so the two lists stay index-aligned.
    p.add_argument("--screenshot", action="append", default=[], metavar="FILE")
    p.add_argument("--caption", action="append", default=[], metavar="TEXT")
    p.add_argument("--changelog", required=True,
                   help="shown to the moderator; mandatory because this opens a revision")
    p.add_argument("--confirm", action="store_true")
    a = p.parse_args()

    if len(a.caption) > len(a.screenshot):
        p.error("more --caption than --screenshot: each caption follows its screenshot")
    captions = a.caption + [None] * (len(a.screenshot) - len(a.caption))
    for cap in captions:
        if cap is not None and len(cap) > CAPTION_MAX:
            p.error(f"caption exceeds the server's {CAPTION_MAX}-character limit: {cap[:40]}…")
    # Usage refusals exit 2, matching attach.sh. `sys.exit("msg")` would exit 1,
    # which reads as a runtime failure rather than a bad invocation.
    if not (a.icon or a.cover or a.screenshot):
        p.error("nothing to do — pass --icon, --cover and/or --screenshot")
    for f in [a.icon, a.cover, *a.screenshot]:
        if f and not os.path.isfile(f):
            p.error(f"no such file: {f}")

    listing_id, kind = resolve_listing(a.app)
    view = trpc("appListings.getMyListingForEdit", {"listingId": listing_id}, query=True)
    target = view.get("shadowId") or view["parentId"]

    print(f"app          : {a.app}  (kind={kind})")
    print(f"parent       : {view['parentId']}")
    print(f"edit target  : {target}   <- assets are attached HERE, never the parent")
    print(f"pending      : {view.get('hasPendingRevision')}")
    for label, f in (("icon", a.icon), ("cover", a.cover)):
        if f:
            w, h, m = dims(f)
            print(f"{label:<13}: {f} ({w}x{h}, {m}, {os.path.getsize(f)/1024:.1f} KiB)")
    for i, f in enumerate(a.screenshot):
        w, h, m = dims(f)
        cap = captions[i]
        print(f"screenshot[{i}] : {f} ({w}x{h}, {m}, {os.path.getsize(f)/1024:.1f} KiB)"
              + (f'  caption={cap!r}' if cap else "  (no caption)"))

    # 🔴 GATE BEFORE SENDING, and gate in the DRY RUN too, so the dry run is a
    # real check rather than theatre — the same property attach.sh advertises.
    if a.screenshot:
        have = existing_screenshot_count(a.app)
        print(f"screenshots  : {have} already on the listing + {len(a.screenshot)} new "
              f"= {have + len(a.screenshot)} total")
        gate_bounds("screenshot", a.screenshot, have + len(a.screenshot))
    if a.icon:
        gate_bounds("icon", [a.icon], 1)
    if a.cover:
        gate_bounds("cover", [a.cover], 1)

    if kind != "offsite":
        print(f"\n{a.app} is {kind}, not offsite — use attach.sh, which gates against "
              f"store-bounds.json. Refusing.")
        return 2
    if not a.confirm:
        print("\nDRY RUN — nothing was sent. Re-run with --confirm to attach and submit.")
        return 3

    for label, f in (("icon", a.icon), ("cover", a.cover)):
        if not f:
            continue
        img = ingest_icon(f) if label == "icon" else ingest_full(f)
        res = trpc(f"appListings.set{label.capitalize()}",
                   {"listingId": target, "imageId": img})
        print(f"  set{label.capitalize()} imageId={img} -> {json.dumps(res)[:120]}")
        if res.get("scanPending"):
            print("  scanned" if poll_scan(img) else "  still scanning, continuing")

    # 🔴 addScreenshot APPENDS. Unlike setIcon/setCover it has no single slot to
    # overwrite, so a re-sent call leaves TWO rows — which is why it is not in
    # RETRYABLE_ROUTES, and why a failure here stops rather than continuing: the
    # remaining screenshots are better left unsent than interleaved with a
    # half-known state the operator has not read yet.
    for i, f in enumerate(a.screenshot):
        img = ingest_full(f)
        res = trpc("appListings.addScreenshot",
                   {"listingId": target, "imageId": img, "caption": captions[i]})
        print(f"  addScreenshot[{i}] imageId={img} -> {json.dumps(res)[:120]}")
        if res.get("scanPending"):
            print("  scanned" if poll_scan(img) else "  still scanning, continuing")

    sub = trpc("appListings.submitListingRevision",
               {"shadowId": target, "changelog": a.changelog})
    print(f"\nSUBMITTED publishRequestId={sub.get('publishRequestId')}")
    print("The live listing is UNCHANGED until a moderator approves it.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
