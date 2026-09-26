#!/usr/bin/env python3
# ============================================================================
# frame.py — the PURE half of app-capture's image work.
#
# Pure given a file: it reads pixels, it does arithmetic, it prints JSON. It
# performs NO navigation, NO network, NO browser, and (unless you pass --exec to
# `render`) it spawns nothing. That is the only reason any of this is testable
# offline — see tests/run-tests-app-capture.sh.
#
# Subcommands
#   measure <png>          content bounding box of one capture       -> JSON
#   check-states <json>    the identical-box gate across states      -> JSON
#   bounds <kind> <file..> the store-bounds gate                     -> JSON
#   render <png> --out F   the crop/resize argv for the measured box -> JSON
#
# 🔴 WHY THE EXCLUSION BANDS EXIST. Content bounds are found by differencing
# against the flat page background. Three regions must be excluded first or the
# detector silently returns the whole frame and the crop becomes a no-op that
# still prints plausible numbers:
#   - top chrome   (header + nav + breadcrumb)
#   - footer       ("(c) Civitai ... Terms of Service ...") — spans FULL WIDTH,
#                  so leaving it in pins the box to full width
#   - right furniture (scrollbar / floating support button) — spans FULL HEIGHT,
#                  so leaving it in pins the box to full height
# This shipped broken twice on 2026-08-13, each time producing candidates that
# were ~60% dead space. Both failure shapes are reproduced from the REAL
# fixtures in tests/fixtures/app-capture/ as negative controls, by zeroing one
# band at a time.
#
# 🔴 The band values are NOT universal truths. They are viewport-specific and
# recipe-overridable (`crop` in a recipe, or the --chrome-top/--footer/--right
# flags). The measured values for the 1709x1314 POC captures are pinned in
# tests/fixtures/app-capture/manifest.json, not asserted as constants here.
#
# 🔴 AND A FIXED `chromeTop` IS NOT MERELY IMPRECISE — IT IS UNSATISFIABLE ON
# THIS PAGE. `civitai.com/apps/run/<slug>` carries a CONDITIONAL, full-width
# rewards banner ("BONUS REWARDS ACTIVE", ~32-36 px) ABOVE the app iframe, and it
# appears asynchronously after a Buzz-multiplier query resolves. Measured on the
# real captures in tests/fixtures/app-capture/ (2026-08-22):
#   banner absent : full-width furniture ends ~163, app content starts 194
#                   -> every chromeTop in 163..196 measures the app column
#   banner present: the same two edges move +36
#                   -> every chromeTop in 199..232 measures the app column
# Two 34-value windows, and they are DISJOINT — no constant satisfies both.
# Too small and the breadcrumb bar is sampled as content (full width -> the
# `full_frame` refusal); too large and the top of the app's own header is
# clipped. `crop.fromAppFrame` is the way out: the app iframe's own bounding
# rect IS the boundary, it is known exactly, and it moves WITH the banner.
# See app_frame_bands below.
#
# 🔴 THOSE FOUR NUMBERS ARE DATED, AND THE IFRAME TOP HAS MOVED SINCE. They are a
# property of the 2026-08-22 FIXTURES, which is the only thing gate F11 claims
# and the only thing it needs. Re-measured live on 2026-08-26, same shell, same
# 1709px width: the rewards banner occupies rows 68..104 (height 37) and the app
# iframe starts at 141 with it PRESENT — so the absent layout would be ~104, and
# both live values are NUMERICALLY SMALLER than both windows above, i.e. higher
# up the page. THE IFRAME TOP moved up ~58 px in four days (199->141 with the
# banner, 163->~104 without). WHERE in the stack that height went is NOT measured
# — the new reading puts the breadcrumb BELOW the banner, so it could sit either
# side, and "the stack above the banner shrank" is a decomposition nobody took.
# The premise is untouched (the two layouts still differ by the banner's height,
# so no constant serves both); what is dead is any reading of 163/199 as CURRENT.
# This is the whole argument for deriving the edge rather than pinning it — do
# not "correct" a recipe to these numbers.
# ============================================================================
import argparse
import json
import os
import struct
import sys
import zlib
from collections import Counter, namedtuple

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_BOUNDS = os.path.join(HERE, "store-bounds.json")

# Defaults measured on the 1709x1314 POC captures (2026-08-13). Overridable per
# recipe and per invocation; pinned as data in the fixture manifest.
DEF_CHROME_TOP = 182
DEF_FOOTER = 110
DEF_RIGHT = 70
DEF_STRIDE = 4
DEF_TOLERANCE = 8

# A box filling this fraction of the usable band on EITHER axis means the
# detector found the furniture, not the content.
#
# 🔴 OR, NOT AND — and the discriminating case is the RIGHT-EDGE furniture, not
# the footer. Measured on the fixtures in tests/fixtures/app-capture/:
#     right-margin band dropped -> 78.7% wide x 100.0% tall   <- AND misses this
#     footer band dropped       -> 100.0% wide x  98.2% tall   (AND still fires)
#     all bands dropped         -> 100.0% wide x  99.4% tall   (AND still fires)
# So an AND rule looks fine on two of the three broken shapes and silently ships
# the third. tests/mutants-app-capture.sh M21 is the lock on that.
FULL_FRAME_FRAC = 0.97
# ...and a box this small means it found nothing but antialiasing.
MIN_FILL_FRAC = 0.02
# Floor for a DECLARED cropRect. MIN_FILL_FRAC is a fraction of the usable band and
# is the right unit for a DETECTED box; a declared rect is absolute, so it gets an
# absolute floor. 128 is the store's own minimum icon edge (store-bounds.json), so
# a rect below it cannot produce a shippable asset on any axis.
MIN_DECLARED_PX = 128

# 🔴 THE THIRD CROP FORM: A DECLARED RECT WHOSE `y` IS MEASURED FROM THE APP
# IFRAME'S TOP EDGE. It exists because the two forms above cannot both be had:
# detection is unusable on a scrolling, content-dense app (it fills the band and
# `full_frame` refuses, correctly — app-requests 46.9% x 98.3%,
# playable-collections 63.9% x 100.0%, talos-infra #1297), while a plain declared
# rect is ABSOLUTE and is therefore wrong by the conditional rewards banner's
# ~36 px in the other layout — the very defect `fromAppFrame` exists to remove.
#
# 🔴 ONLY `y` IS ANCHORED — AND HERE IS EXACTLY HOW FAR THAT IS MEASURED, which
# is less far than the obvious wording claims. What a real pair of captures
# established is the TOP-EDGE SHIFT: the app's top edge moves 194 -> 230 when the
# banner appears (2026-08-22). The companion claim — that x, w and h are
# unchanged — is asserted against the banner state cut by
# tests/fixtures/app-capture/bannershift.py, and that fixture builds the second
# layout by inserting a strip and translating every row below it, so x/w/h
# identity there is TRUE BY CONSTRUCTION, not evidence. Gate F13's pixel
# comparison therefore grades the resolution ARITHMETIC (hard: sign flips,
# wrong-axis application, max-instead-of-plus and off-by-ones all die on it),
# not the physical claim.
#
# 🔴 SO STATE THE LIMIT: the banner also SHORTENS the iframe by ~36 px, because
# the viewport height is fixed. An app whose internal layout responds to its
# frame's HEIGHT — vertical centring, a 100%-height pane, a virtualised list
# whose row count depends on it — can move in ways this anchor does not model,
# and no fixture in this repo would show it. Both apps using the form are plain
# top-aligned scrolling lists, which is why it is sound for them. Check that
# before adding a third.
RECT_Y_APP_FRAME = "appFrame"

# 🔴 THE HORIZONTAL AXIS, ADDED 2026-09-02 — AND IT NEEDED A PROBE CHANGE, WHICH
# IS THE FIRST THING TO KNOW ABOUT IT. Until this, the probe answered five
# numbers: `top,bottomGap,rightGap,viewportW,viewportH`. The third is the gap
# between the iframe's RIGHT edge and the viewport's right edge
# (`Math.floor((innerWidth - r.right) * dpr)` in app_frame_rect_js), so the frame's
# right edge was derivable as `vw - rightGap` — but its LEFT edge and its WIDTH
# were not derivable from anything. `x` and `w` therefore had NO live witness at
# all, which is exactly what VIEWPORT_RECORD_SLACK's note below records as the
# cause of the 2026-09-02 incident. The probe now appends a SIXTH number, the
# frame's left inset, and these two markers spend it:
#
#   xFrom: "appFrame"       -> `x` is measured RIGHT from the frame's LEFT edge
#   wFrom: "appFrameRight"  -> `w` is RE-READ as an inset measured LEFT from the
#                              frame's RIGHT edge, i.e. the pair (x, w) becomes
#                              (left inset, right inset) and the box spans
#                              [frameLeft + x, frameRight - w).
#
# 🔴 THE TWO MARKER VALUES ARE DELIBERATELY DIFFERENT TOKENS. `yFrom`/`xFrom`
# both anchor a COORDINATE to the frame's near edge, so they share `"appFrame"`.
# `wFrom` does something else entirely — it changes what the number MEANS, from a
# length to a gap — and a shared token is exactly how someone copies `"appFrame"`
# across and gets a plausible wrong box. A distinct value that names the edge is
# what makes that copy REFUSE instead.
#
# 🔴 WHAT EACH FORM IS AND IS NOT VIEWPORT-INDEPENDENT ABOUT, because the
# difference is the whole reason both exist:
#   - `xFrom` ALONE tracks a frame that MOVES at constant width (a max-width
#     container centred in a wider window). It does nothing at all for a
#     full-bleed iframe, where the left edge is 0 at every viewport — every
#     shipped recipe's probe answer reads `rightGap=-1` at 1709, i.e. full-bleed,
#     so on those apps `xFrom` alone is a NO-OP and must not be sold as a fix.
#   - `xFrom` + `wFrom` is the only form whose box is viewport-independent BY
#     CONSTRUCTION on this axis: both of its edges are gaps from the frame's own
#     edges, so it carries no absolute horizontal coordinate to be wrong.
# `wFrom` therefore REQUIRES `xFrom` — a far-edge width against an absolute left
# edge is the half-specified shape, and it would silently absorb the drift it
# looks like it removes.
RECT_X_APP_FRAME = "appFrame"
RECT_W_APP_FRAME_RIGHT = "appFrameRight"
# 🔴 STRICT, because a misspelt marker degrades SILENTLY to the absolute form.
# `_`-prefixed keys are the recipes' comment convention and are ignored.
RECT_KEYS = ("x", "y", "w", "h")
RECT_KEYS_OPTIONAL = ("yFrom", "xFrom", "wFrom")


# 🔴 THE TOP-FRAME HANDLE ON THE APP IFRAME, IN PREFERENCE ORDER. All three are
# tried in ONE evaluation, so a rename of any single one is not an outage:
#   1. data-testid="app-page-iframe" — set by civitai's PageBlockHost and
#      exercised by that repo's own browser tests, so it is a maintained handle
#      rather than a scraped one.
#   2. an <iframe> whose src carries the recipe's frameHost — independent of the
#      host page's markup entirely.
#   3. the page's ONLY <iframe>, if there is exactly one.
# A rect can only ever WIDEN the recipe's bands (see app_frame_bands), so a
# wrong match cannot smuggle furniture INTO the detection region.
APP_FRAME_TESTID = "app-page-iframe"
APP_FRAME_TOKEN = "APPFRAME_RECT:"
APP_FRAME_ABSENT = "APPFRAME_ABSENT"

# The scale agreement between what the page reports and what the bridge captured
# is allowed to be off by this much: `captureVisibleTab` writes device pixels and
# window.innerWidth * devicePixelRatio is a float rounded once, so a fractional
# DPR can land a pixel either side. Anything larger is a real disagreement about
# what was photographed, and the derived bands would be in the wrong units.
APP_FRAME_SCALE_SLACK = 2

# 🔴 AND THAT CHECK IS INTERNAL CONSISTENCY, NOT CORRECTNESS — WHICH IS HOW A
# BADLY WRONG ASSET SHIPPED WITH EXIT 0 ON 2026-09-02. `app_frame_scale` asks
# whether the page's own viewport reading agrees with the PNG the bridge wrote.
# Both come from the SAME run, so they agree whatever window the tab was in: the
# incident capture reported 3431x1286 and the PNG was 3431x1286, and it passed.
# What nothing asked was whether that is the window the RECT was measured in.
# Measured that day: sensei's rect (x=0 y=64 w=1694 h=982) was chosen against a
# 1709x1255 viewport — recorded in the recipe as `crop._measuredGeometry.viewport`
# — and the operator's window had since become ~3008 CSS px wide at
# devicePixelRatio 1.140625, i.e. 3431 device px. Applied to a frame twice as
# wide, `x=0 w=1694` photographed the LEFT HALF and shoved the app into a corner
# of the canvas. Nothing refused: 1694 fits inside 3431, so the only x-axis check
# there has ever been (`x0 + bw > w`, against the PNG) gets LOOSER as the window
# grows. Two runs an hour apart in the same session read 1709x1255 and 3431x1286,
# so this is not a one-off — nothing pins the viewport and nothing checked it.
#
# 🔴 SO THE PAIR MATTERS: this gate is CAPTURE-vs-RECORD, across two sessions;
# app_frame_scale is PROBE-vs-CAPTURE, within one. Neither can see the other's
# failure and they share no clause, which is deliberate — a redundant second
# reading of the same pair would let a mutant in one die to the other and record
# coverage that does not exist.
#
# TOLERANCE. Both numbers are device pixels from `Math.round(innerWidth * dpr)`
# on a float, so a fractional DPR can round a pixel either side on each axis —
# the same physical cause APP_FRAME_SCALE_SLACK exists for, hence the same
# magnitude, kept as its own constant because the two answer different questions
# and may legitimately diverge. It is small enough to catch every real resize
# ever measured here: the smallest genuine difference in this repo's own corpus
# is 59 px (the fixture captures are 1709x1314, one browser-toolbar row taller
# than the 1709x1255 live captures the shipped rects were measured on), and the
# incident's width delta was 1722 px. 2 px separates rounding from the smallest
# real difference by ~30x.
VIEWPORT_RECORD_SLACK = 2

# 🔴 THE SAME BAN evidence.PROBE_FORBIDDEN CARRIES, RESTATED HERE BECAUSE THIS
# MODULE IS DEPENDENCY-FREE ON PURPOSE (see png_decode). This is injected JS: our
# own code, in the MAIN world of a live, logged-in, mod-gated page, and it
# interpolates a value that comes from a RECIPE. It may MEASURE and must not
# ACTUATE. tests/run-tests-app-capture.sh F12 asserts this tuple still COVERS
# evidence.PROBE_FORBIDDEN, so a token added there cannot quietly go unbanned
# here — a two-file ledger rather than a copy that drifts.
RECT_JS_FORBIDDEN = (".click(", ".submit(", "requestSubmit", "window.open",
                     "location.href", "location.replace", "location.assign",
                     "activate", "xdotool", "document.forms")


class Refuse(Exception):
    def __init__(self, code, msg):
        super().__init__(msg)
        self.code = code
        self.msg = msg


# ---------------------------------------------------------------- image I/O --
def png_decode(path):
    """Decode an 8-bit truecolour non-interlaced PNG with the stdlib only.

    Returns (width, height, bytearray of RGB rows). Deliberately dependency
    free: the suite must run offline with no pip, no Pillow, no imagemagick.
    """
    with open(path, "rb") as fh:
        d = fh.read()
    if d[:8] != b"\x89PNG\r\n\x1a\n":
        raise Refuse("not_png", "%s is not a PNG" % path)
    pos, idat, w, h = 8, bytearray(), None, None
    while pos + 8 <= len(d):
        ln, typ = struct.unpack(">I4s", d[pos:pos + 8])
        body = d[pos + 8:pos + 8 + ln]
        if typ == b"IHDR":
            w, h, bd, ct, _cm, _fm, il = struct.unpack(">IIBBBBB", body)
            if bd != 8 or ct != 2 or il != 0:
                raise Refuse(
                    "unsupported_png",
                    "%s: need 8-bit truecolour non-interlaced (got depth=%d colour=%d "
                    "interlace=%d)" % (path, bd, ct, il),
                )
        elif typ == b"IDAT":
            idat += body
        elif typ == b"IEND":
            break
        pos += 12 + ln
    if w is None:
        raise Refuse("not_png", "%s: no IHDR" % path)
    raw = zlib.decompress(bytes(idat))
    bpp, stride = 3, w * 3
    out = bytearray(h * stride)
    prev = bytearray(stride)
    p = 0
    for y in range(h):
        ft = raw[p]
        p += 1
        line = bytearray(raw[p:p + stride])
        p += stride
        if ft == 0:
            pass
        elif ft == 1:
            for i in range(bpp, stride):
                line[i] = (line[i] + line[i - bpp]) & 255
        elif ft == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 255
        elif ft == 3:
            for i in range(stride):
                a = line[i - bpp] if i >= bpp else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 255
        elif ft == 4:
            for i in range(stride):
                a = line[i - bpp] if i >= bpp else 0
                b = prev[i]
                c = prev[i - bpp] if i >= bpp else 0
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 255
        else:
            raise Refuse("bad_png_filter", "%s: unknown PNG filter %d" % (path, ft))
        out[y * stride:(y + 1) * stride] = line
        prev = line
    return w, h, out


def image_size(path):
    """(width, height) for PNG or JPEG, header only. Used by the bounds gate,
    which must work on whatever a listing is about to be handed."""
    with open(path, "rb") as fh:
        head = fh.read(2)
        if head == b"\x89P":
            fh.seek(0)
            d = fh.read(26)
            if d[:8] != b"\x89PNG\r\n\x1a\n":
                raise Refuse("not_image", "%s: bad PNG signature" % path)
            w, h = struct.unpack(">II", d[16:24])
            return w, h
        if head == b"\xff\xd8":
            while True:
                b = fh.read(1)
                if not b:
                    raise Refuse("not_image", "%s: truncated JPEG" % path)
                if b != b"\xff":
                    continue
                marker = fh.read(1)
                while marker == b"\xff":
                    marker = fh.read(1)
                m = marker[0]
                if m in (0xD8, 0x01) or 0xD0 <= m <= 0xD7:
                    continue
                seg = fh.read(2)
                if len(seg) < 2:
                    raise Refuse("not_image", "%s: truncated JPEG" % path)
                ln = struct.unpack(">H", seg)[0]
                if 0xC0 <= m <= 0xCF and m not in (0xC4, 0xC8, 0xCC):
                    body = fh.read(5)
                    h, w = struct.unpack(">HH", body[1:5])
                    return w, h
                fh.seek(ln - 2, 1)
    raise Refuse("not_image", "%s: not a PNG or JPEG" % path)


# ----------------------------------------------------------------- measure --
def content_box(path, chrome_top, footer, right, stride, tolerance):
    w, h, px = png_decode(path)
    rowbytes = w * 3
    band_y0 = min(chrome_top, h)
    band_y1 = max(band_y0, h - footer)
    band_x0 = 0
    band_x1 = max(band_x0, w - right)
    if band_y1 - band_y0 < stride or band_x1 - band_x0 < stride:
        raise Refuse("bands_exceed_frame",
                     "%s: exclusion bands leave no usable region" % path)

    samples = {}
    for y in range(band_y0, band_y1, stride):
        base = y * rowbytes
        for x in range(band_x0, band_x1, stride):
            o = base + x * 3
            samples[(x, y)] = (px[o], px[o + 1], px[o + 2])
    bg = Counter(samples.values()).most_common(1)[0][0]

    xs, ys = [], []
    for (x, y), v in samples.items():
        if (abs(v[0] - bg[0]) > tolerance or abs(v[1] - bg[1]) > tolerance
                or abs(v[2] - bg[2]) > tolerance):
            xs.append(x)
            ys.append(y)
    if not xs:
        raise Refuse("no_content", "%s: every sampled pixel matches the background" % path)

    # 🔴 CLAMP to the usable band. `max(xs) + stride` can overshoot the frame,
    # and a box wider than the image it came from crops to nothing.
    x0, y0 = min(xs), min(ys)
    x1, y1 = min(max(xs) + stride, band_x1), min(max(ys) + stride, band_y1)

    usable_w = band_x1 - band_x0
    usable_h = band_y1 - band_y0
    fill_w = (x1 - x0) / float(usable_w)
    fill_h = (y1 - y0) / float(usable_h)
    return {
        "file": os.path.basename(path),
        "frame": {"w": w, "h": h},
        "bands": {"chromeTop": chrome_top, "footer": footer, "right": right},
        "usable": {"w": usable_w, "h": usable_h},
        "bg": "#%02x%02x%02x" % bg,
        "box": {"x": x0, "y": y0, "w": x1 - x0, "h": y1 - y0},
        "fill": {"w": round(fill_w, 4), "h": round(fill_h, 4)},
    }


RectAnchors = namedtuple("RectAnchors", "y x w")


def rect_anchors(rect):
    """Which of this declared rect's numbers are measured from the app frame?

    Returns RectAnchors(y, x, w) — three booleans, one per marker — and REFUSES
    every malformed or half-specified spelling on the way. Three flags rather
    than one because they do different work: `y` is what the top-edge resolution
    and the iframe-BOTTOM bound key on, `x` is what the left-edge resolution and
    the iframe-RIGHT bound key on, and `w` is what re-reads `w` as a far-edge gap.
    Collapsing them (the pre-2026-09-02 single boolean) would apply the vertical
    anchor to a rect that only asked for a horizontal one.

    🔴 THE KEY SET IS CHECKED, because a misspelt `yFrom` is not a syntax error
    anywhere else in this file — it would simply be ignored, leaving an ABSOLUTE
    rect that measures plausibly and crops the wrong region in one of the two
    layouts. That is the reassuring-fallback shape, so an unrecognised key is
    REFUSED rather than dropped.

    🔴 BUT BE HONEST ABOUT HOW MUCH OF THAT THIS CHECK ACTUALLY BUYS. In the
    shape it names — a misspelt marker in a recipe that ALSO sets `fromAppFrame`
    — the mutual-exclusion seam in app_frame_from already refuses, and with a
    message that names the correct fix. What this adds on top is (a) the recipe
    that misspells the marker and does NOT set `fromAppFrame`, where nothing else
    would say a word, and (b) a real behaviour change on the CLI: `--crop-rect`
    carrying any extra key used to be accepted and is now refused. Keep the check
    for (a); (b) is the deliberate cost.
    """
    if not isinstance(rect, dict):
        raise Refuse("crop_rect_invalid",
                     "crop.rect must be an object with x, y, w, h — got %r" % (rect,))
    known = RECT_KEYS + RECT_KEYS_OPTIONAL
    for k in rect:
        if k.startswith("_"):
            continue                      # the recipes' comment convention
        if k not in known:
            raise Refuse(
                "crop_rect_invalid",
                "crop.rect carries an unknown key %r (known: %s, plus `_`-prefixed "
                "comments). A misspelt marker (%s) would be IGNORED, leaving an absolute "
                "rect that is wrong by the ~36px rewards-banner shift in the other banner "
                "layout, or by however far the app frame has moved horizontally — "
                "refusing rather than silently cropping the wrong region."
                % (k, ", ".join(known), ", ".join(RECT_KEYS_OPTIONAL)))
    if "yFrom" in rect and rect["yFrom"] != RECT_Y_APP_FRAME:
        raise Refuse(
            "crop_rect_invalid",
            "crop.rect.yFrom is %r; the only supported value is %r, which means `y` is "
            "measured DOWN FROM THE APP IFRAME'S TOP EDGE (and the recipe must also set "
            "crop.fromAppFrame so the probe that reads that edge actually runs)."
            % (rect["yFrom"], RECT_Y_APP_FRAME))
    if "xFrom" in rect and rect["xFrom"] != RECT_X_APP_FRAME:
        raise Refuse(
            "crop_rect_invalid",
            "crop.rect.xFrom is %r; the only supported value is %r, which means `x` is "
            "measured RIGHT FROM THE APP IFRAME'S LEFT EDGE (and the recipe must also "
            "set crop.fromAppFrame so the probe that reads that edge actually runs)."
            % (rect["xFrom"], RECT_X_APP_FRAME))
    if "wFrom" in rect and rect["wFrom"] != RECT_W_APP_FRAME_RIGHT:
        raise Refuse(
            "crop_rect_invalid",
            "crop.rect.wFrom is %r; the only supported value is %r, which RE-READS `w` "
            "as a gap measured LEFT from the app iframe's RIGHT edge rather than as a "
            "width. It is deliberately NOT %r: `yFrom`/`xFrom` anchor a coordinate to "
            "the frame's near edge and share that token, while `wFrom` changes what the "
            "number MEANS, and a shared token is how that value gets copied across into "
            "a plausible wrong box."
            % (rect["wFrom"], RECT_W_APP_FRAME_RIGHT, RECT_X_APP_FRAME))
    if "wFrom" in rect and "xFrom" not in rect:
        raise Refuse(
            "crop_rect_invalid",
            "crop.rect sets wFrom=%r but NOT xFrom. That is the half-specified form: the "
            "right edge would track the app frame while the left edge stayed an ABSOLUTE "
            "column, so the box's width would silently absorb every pixel the frame moved "
            "— drift hidden inside the one number that looks like it removed it. Anchor "
            "both edges (xFrom=%r with wFrom=%r) or neither."
            % (RECT_W_APP_FRAME_RIGHT, RECT_X_APP_FRAME, RECT_W_APP_FRAME_RIGHT))
    return RectAnchors(y="yFrom" in rect, x="xFrom" in rect, w="wFrom" in rect)


def rect_is_frame_relative(rect):
    """Does this rect need the app-frame probe at all? — ANY anchor, on either axis.

    Kept as its own name because it is what the `fromAppFrame` seam in
    app_frame_from asks, in both directions: a rect carrying any marker needs the
    probe to have run, and a probe handed to a recipe that declares no marker is
    a disagreement about which crop this is.
    """
    return any(rect_anchors(rect))


def parse_measured_viewport(text):
    """`WxH` -> (w, h). The CLI spelling of `crop._measuredGeometry.viewport`.

    It exists so the `--crop-rect` path is not an EXEMPTION. A rect typed on the
    command line is just as absolute as one in a recipe, so it needs the same
    operand; without a flag the only honest alternatives are to refuse the CLI
    form outright or to let it through unchecked, and the second is the shape
    this whole gate exists to remove.
    """
    parts = str(text).lower().split("x")
    nums = []
    for p in parts:
        p = p.strip()
        if not p or not all("0" <= c <= "9" for c in p):
            nums = []
            break
        nums.append(int(p))
    if len(nums) != 2 or nums[0] <= 0 or nums[1] <= 0:
        raise Refuse(
            "viewport_unrecorded",
            "--measured-viewport must be two positive integers as WxH (the device-pixel "
            "viewport the rect's absolute coordinates were measured in, e.g. 1709x1255) "
            "— got %r. It is not optional: a declared rect that records nothing about "
            "the canvas it was measured on cannot be checked against the one it is "
            "applied to." % (text,))
    return (nums[0], nums[1])


def viewport_of_record(crop, cli):
    """The viewport a DECLARED rect's absolute coordinates were measured in.

    🔴 REQUIRED, NOT OPTIONAL, AND THAT IS THE DECISION THIS FUNCTION ENCODES.
    A declared rect with no record of its canvas is unverifiable by anything —
    the numbers look exactly as plausible at 1709 as at 3431 — so an absent
    record cannot be allowed to mean "skip the check". Measured 2026-09-02:
    every shipped declared-rect recipe already carries
    `crop._measuredGeometry.viewport` (app-requests, model-benchmarking,
    playable-collections, sensei — all four recording 1709x1255), so requiring it
    cost nothing then and makes the absence loud the first time someone adds a
    recipe without one. The asserted ledger is gate C8, which reads the recipes
    directory; this list is a dated note, not the check.

    🔴 BOTH DIRECTIONS OF THE SEAM REFUSE, the way app_frame_from's do. A recipe
    record and a `--measured-viewport` together mean the caller and the recipe
    disagree about which measurement session this rect belongs to; picking one
    silently is how the wrong number gets used. Both raise the same code because
    both are the same operator action — fix the recipe or drop the flag — and
    capture.sh maps both to the same exit.
    """
    geo = (crop or {}).get("_measuredGeometry")
    rec = geo.get("viewport") if isinstance(geo, dict) else None
    if rec is not None and cli is not None:
        raise Refuse(
            "viewport_record_conflict",
            "the recipe records crop._measuredGeometry.viewport = %r AND "
            "--measured-viewport %r was supplied. Two records of the same fact, and "
            "nothing here can tell which measurement session the rect belongs to. "
            "Drop the flag to use the recipe's, or use --crop-rect with the flag to "
            "declare both halves on the command line." % (rec, cli))
    if cli is not None:
        return parse_measured_viewport(cli)
    if rec is None:
        raise Refuse(
            "viewport_unrecorded",
            "this crop declares a `rect` but records no viewport for it. A declared "
            "rect is ABSOLUTE — x and w in particular have no live anchor at all — so "
            "it is only meaningful on the canvas it was measured on, and without that "
            "number nothing can tell a correct rect from one measured in a window that "
            "no longer exists. Add `crop._measuredGeometry.viewport: [W, H]` to the "
            "recipe (the device-pixel viewport the run's own APPFRAME_RECT probe "
            "reported when the rect was chosen), or pass --measured-viewport WxH "
            "alongside --crop-rect. Refusing rather than cropping unchecked.")
    if (not isinstance(rec, list) or len(rec) != 2
            or not all(isinstance(v, int) and not isinstance(v, bool) and v > 0
                       for v in rec)):
        raise Refuse(
            "viewport_unrecorded",
            "crop._measuredGeometry.viewport must be two positive integers [W, H] — "
            "got %r. A malformed record is not a record: it cannot be compared with "
            "the capture, which would leave the rect unchecked." % (rec,))
    # 🔴 THE THIRD SLOT IS OPTIONAL HERE AND REQUIRED THERE. Only a rect anchored
    # on BOTH horizontal edges is graded against the app frame's width rather than
    # the window's, so only that form needs `appFrameW` — and gate_of_record is
    # what refuses its absence, at the point where it knows the rect's shape. This
    # function's job is to hand over whatever the recipe recorded, VALIDATED; it is
    # not the place to decide who needs it. A 2-tuple where there is no record
    # keeps every existing caller (and every hand-built tuple in the suite) exact.
    fw = geo.get("appFrameW") if isinstance(geo, dict) else None
    if fw is None:
        return (rec[0], rec[1])
    if not isinstance(fw, int) or isinstance(fw, bool) or fw <= 0:
        raise Refuse(
            "viewport_unrecorded",
            "crop._measuredGeometry.appFrameW must be a positive integer (the app "
            "iframe's own device-pixel WIDTH when the rect was measured, i.e. "
            "viewportW - leftInset - rightGap off the probe answer) — got %r." % (fw,))
    return (rec[0], rec[1], fw)


def gate_viewport_of_record(path, recorded, png_w, png_h):
    """🔴 IS THIS THE WINDOW THE RECT WAS MEASURED IN? — the CORRECTNESS half.

    Read the constant's note above for the incident. In one sentence: a declared
    rect's x/w have no live anchor whatsoever, and the only bound they ever had
    is the capture's own width, which a bigger window makes LOOSER rather than
    tighter. So a rect measured at 1709 and applied at 3431 crops the left half
    and every other check agrees it is fine.

    🔴 THE OPERAND IS THE CAPTURE, NOT THE PROBE, and that is not arbitrary: the
    rect is applied to these pixels. It also means the check is total — an
    absolute rect on a recipe with no `fromAppFrame` has no probe at all, and
    would otherwise be the one form with no guard.

    🔴 BOTH AXES, and the height half is NOT redundant with the frame-relative
    bound. That bound (declared_box, `limit_h`) catches a rect running PAST the
    iframe's lower edge — the too-short-viewport direction. A viewport that is
    TALLER than the record fails the other way: the crop ends early and simply
    misses the app's bottom furniture, which is silent because ending early is
    not running past an edge. sensei's own recipe documents exactly that as its
    open limit.
    """
    vw, vh = recorded[0], recorded[1]
    if abs(vw - png_w) > VIEWPORT_RECORD_SLACK or abs(vh - png_h) > VIEWPORT_RECORD_SLACK:
        raise Refuse(
            "viewport_of_record",
            "%s: this crop's rect was measured at a %dx%d viewport, and the capture is "
            "%dx%d (off by %dx%d, tolerance %d). A declared rect is ABSOLUTE — its x "
            "and w have no live anchor — so applying it to a differently sized window "
            "crops a region the rect never described, and NOTHING downstream can see "
            "that: a rect narrower than the frame passes every bound, so a WIDER window "
            "makes the checks looser, not tighter. This is not a defect in the rect. "
            "Either put the browser window back to the %dx%d device-pixel viewport the "
            "recipe records (that is CSS pixels x devicePixelRatio — a DPR change moves "
            "it too), or re-measure the rect against the new window and update BOTH "
            "`crop.rect` and `crop._measuredGeometry` in the same edit. Refusing rather "
            "than shipping a plausible-looking wrong crop."
            % (path, vw, vh, png_w, png_h, abs(vw - png_w), abs(vh - png_h),
               VIEWPORT_RECORD_SLACK, vw, vh))
    return recorded


def gate_of_record(path, recorded, png_w, png_h, anch, app_frame):
    """🔴 IS THIS THE GEOMETRY THE RECT WAS MEASURED IN? — one question, two operands.

    🔴 THE DECISION THIS FUNCTION ENCODES, and it is the one the horizontal
    anchor forced. `viewport_of_record` exists because a declared rect's `x`/`w`
    had no live witness, so the capture's own size was the only thing they could
    be checked against. A rect anchored on BOTH horizontal edges
    (`xFrom` + `wFrom`) no longer carries an absolute horizontal coordinate at
    all: its left edge is a gap from the frame's left edge and its right edge is
    a gap from the frame's right edge, so the window's WIDTH is not a fact about
    it any more and refusing on it would be refusing on a number the rect does
    not use.

    🔴 SO IT IS RE-BASED, NOT EXEMPTED, AND THE DIFFERENCE IS THE WHOLE POINT.
    An exemption would leave that form with NOTHING checking its horizontal axis,
    which is precisely the hole `viewport_of_record` was written to close. What
    actually threatens a fully-anchored rect is the app REFLOWING — a grid going
    from three columns to four — and the observable for that is the app frame's
    own width, which the probe now reports. So the width axis is graded against
    `_measuredGeometry.appFrameW` instead of against the window.

    🔴 AND THE HEIGHT AXIS IS NOT RE-BASED, because `h` is still ABSOLUTE. There
    is no `hFrom`: the vertical form anchors `y` and bounds the bottom by the
    live iframe edge, but that bound is ONE-SIDED — ending EARLY is not running
    past an edge, which is exactly the open limit sensei's own recipe documents.
    So the recorded viewport HEIGHT stays the operand on that axis for every
    declared rect, anchored or not, and it is the same refusal it always was.

    🔴 WHAT NEITHER HALF BUYS, stated so nobody reads this as more than it is:
    both are RECORD-vs-LIVE comparisons against a number the recipe's own author
    wrote down. Nothing here verifies provenance, and a fully-anchored rect whose
    frame is the recorded width can still be a badly framed picture. The
    identical-box check remains inert for any declared rect — verify by eye.
    """
    # 🔴 `app_frame[5] is not None` IS PART OF THE CONDITION, NOT AN ASSUMPTION.
    # A five-field (pre-2026-09-02) probe answer carries no left inset, and
    # `left or 0` would compute a frame width that is silently too WIDE — a wrong
    # number arrived at without an error, which is the shape of every defect in
    # this module's history. Falling through to the plain viewport gate is the
    # strictly SAFER branch, and `app_frame_left_missing` fires a few lines later
    # in declared_box with the sentence that actually names the cause.
    if anch.x and anch.w and app_frame is not None and app_frame[5] is not None:
        if len(recorded) < 3:
            raise Refuse(
                "frame_width_unrecorded",
                "%s: this crop's rect is anchored on BOTH horizontal edges (xFrom + "
                "wFrom), so it is graded against the APP FRAME's width rather than the "
                "window's — and the recipe records no `crop._measuredGeometry.appFrameW`. "
                "An absent record cannot mean 'skip the check': that is how the axis "
                "went unguarded in the first place. Add appFrameW: the iframe's own "
                "device-pixel width when the rect was measured, which is "
                "`viewportW - leftInset - rightGap` off the run's own APPFRAME_RECT "
                "probe answer. (There is deliberately no --measured-viewport spelling "
                "of this: the CLI form cannot express it, so a fully anchored rect "
                "belongs in a recipe.)" % path)
        live_fw = app_frame[3] - app_frame[2] - app_frame[5]
        rec_fw = recorded[2]
        if abs(live_fw - rec_fw) > VIEWPORT_RECORD_SLACK:
            raise Refuse(
                "frame_of_record",
                "%s: this crop's rect was measured against a %dpx-wide app frame and "
                "this capture's frame is %dpx (off by %d, tolerance %d). Both of its "
                "horizontal edges are gaps from the frame's own edges, so the WINDOW's "
                "width no longer matters to it — but the FRAME's does: a frame of a "
                "different width is a different layout, and the app may have reflowed "
                "inside it (a column count, a wrapped row, a collapsed sidebar), which "
                "no arithmetic here can see. Either restore the frame to %dpx (that is "
                "usually the window width, and a devicePixelRatio change moves it too), "
                "or re-measure the rect and update `crop._measuredGeometry.appFrameW` in "
                "the same edit. Refusing rather than shipping a crop of a layout the "
                "rect was never measured against."
                % (path, rec_fw, live_fw, abs(live_fw - rec_fw),
                   VIEWPORT_RECORD_SLACK, rec_fw))
        # the height axis, on the operand that is still absolute. Same code and
        # same exit as the unanchored form: to an operator it is the same fact and
        # the same fix.
        if abs(recorded[1] - png_h) > VIEWPORT_RECORD_SLACK:
            raise Refuse(
                "viewport_of_record",
                "%s: this crop's rect was measured at a %dx%d viewport and the capture "
                "is %dx%d. Its HEIGHT is what refuses here: `h` is absolute in every "
                "form — there is no `hFrom` — and the live iframe bound is one-sided, so "
                "a TALLER window ends the crop early and silently. The width axis is "
                "graded against the app frame instead (this rect sets xFrom + wFrom) and "
                "is fine. Restore the window height, or re-measure the rect and "
                "`crop._measuredGeometry` together."
                % (path, recorded[0], recorded[1], png_w, png_h))
        return recorded
    return gate_viewport_of_record(path, recorded, png_w, png_h)


def declared_box(path, rect, chrome_top, footer, right, app_frame, measured_viewport):
    """Use a crop rectangle DECLARED by the recipe instead of detecting one.

    🔴 Why this exists. content_box finds the content by looking for pixels that
    differ from the modal background — which assumes the app's content is an
    ISLAND inside page furniture. That holds for an app rendered as a centred
    column on a dark page. It is false for a FULL-BLEED app: sensei fills its
    frame edge to edge (session sidebar + chat pane), so the detector finds the
    whole band and `full_frame` refuses at 100% x 98.1%, at every band setting.
    The gate is right to refuse — a detected box that fills the band IS
    furniture-shaped — so the fix is to stop detecting, not to widen the gate.

    A declared rect is trusted about WHERE the content is, and checked about
    everything else: it must lie inside the frame, be non-degenerate, and must
    not be the whole frame (a full-frame rect is a no-op crop, which is the very
    thing full_frame exists to prevent — declaring it must not buy a bypass).

    🔴 `y` MAY BE FRAME-RELATIVE (`yFrom: "appFrame"`), and every gate below then
    runs on the RESOLVED value, not the declared one. That ordering is the point:
    the frame check, the floor and the no-op check all describe the region that
    will actually be cropped, so a rect that is legal on paper and off the bottom
    of the capture in one banner layout still refuses.
    """
    w, h, px = png_decode(path)
    # 🔴 FIRST, BEFORE ANY OTHER VERDICT ABOUT THIS RECT. If the capture and the
    # rect are in different coordinate spaces then every number computed below —
    # the frame bound, the floor, the no-op check, the resolved `y` — is arithmetic
    # in the wrong units, and each one would return a confident, meaningless
    # answer. `measured_viewport` is a REQUIRED positional on purpose: a keyword
    # default is a way to call this unguarded, and there is no legitimate caller
    # that has no record (viewport_of_record raises before we get here).
    anch = rect_anchors(rect)
    gate_of_record(path, measured_viewport, w, h, anch, app_frame)
    relative = any(anch)
    for k in RECT_KEYS:
        if k not in rect:
            raise Refuse("crop_rect_invalid",
                         "%s: cropRect is missing '%s' (needs x, y, w, h)" % (path, k))
        if not isinstance(rect[k], int) or isinstance(rect[k], bool) or rect[k] < 0:
            raise Refuse("crop_rect_invalid",
                         "%s: cropRect.%s must be a non-negative integer, got %r"
                         % (path, k, rect[k]))
    x0, y0, bw, bh = rect["x"], rect["y"], rect["w"], rect["h"]
    frame_top = frame_left = frame_right = None
    if relative:
        if app_frame is None:
            raise Refuse(
                "app_frame_rect_missing",
                "%s: cropRect declares a frame-relative marker (%s) but no app-frame "
                "rect reached the measurement, so there is no edge to resolve it "
                "against. The recipe must set crop.fromAppFrame, which is what makes "
                "capture.sh run the probe."
                % (path, ", ".join(k for k in RECT_KEYS_OPTIONAL if k in rect)))
    if anch.y:
        frame_top = app_frame[0]
        if frame_top < 0:
            raise Refuse(
                "crop_rect_outside",
                "%s: the app-frame probe reports a NEGATIVE top gap (%d) — the iframe "
                "starts above the viewport, i.e. the page is scrolled. A frame-relative "
                "cropRect.y is measured DOWN from that edge, so resolving it would place "
                "the crop off the top of the capture. Refusing rather than cropping to a "
                "plausible-looking wrong region." % (path, frame_top))
        y0 = frame_top + y0
    # 🔴 THE HORIZONTAL ANCHOR. `app_frame[5]` is the frame's LEFT inset and it is
    # the number that did not exist before 2026-09-02; `app_frame[2]` is the RIGHT
    # gap, which did, so the frame's right edge has always been derivable and was
    # simply never used. Both are resolved BEFORE any bound below, for the same
    # reason `y` is: every gate must describe the region that will actually be
    # cropped, not the one the recipe wrote down.
    if anch.x:
        frame_left = app_frame[5]
        if frame_left is None:
            raise Refuse(
                "app_frame_left_missing",
                "%s: cropRect declares xFrom=%r, but the app-frame probe answered with "
                "only the FIVE pre-2026-09-02 numbers (top,bottom,right,viewportW,"
                "viewportH) — no left inset, so there is no left edge to resolve `x` "
                "against. That means a stale or foreign probe, not a page state: this "
                "module emits the probe itself and its own version reports six. "
                "REFUSING rather than reading `x` as an absolute column, which is "
                "precisely the silent fallback this form exists to remove."
                % (path, RECT_X_APP_FRAME))
        if frame_left < 0:
            raise Refuse(
                "crop_rect_outside",
                "%s: the app-frame probe reports a NEGATIVE left inset (%d) — the iframe "
                "starts left of the viewport, i.e. the page is scrolled horizontally. A "
                "frame-relative cropRect.x is measured RIGHT from that edge, so resolving "
                "it would place the crop off the left of the capture. Refusing rather "
                "than cropping to a plausible-looking wrong region." % (path, frame_left))
        x0 = frame_left + x0
        # `w` = the viewport width the probe reported, NOT the PNG's, because that
        # is the coordinate space the right gap was measured in. app_frame_bands
        # has already refused any disagreement between the two beyond
        # APP_FRAME_SCALE_SLACK, so they are the same number to within rounding —
        # but taking it from the probe keeps the whole right-edge derivation in
        # ONE space rather than mixing two that merely agree.
        frame_right = app_frame[3] - app_frame[2]
    if anch.w:
        # 🔴 `w` IS A GAP HERE, NOT A WIDTH — see RECT_W_APP_FRAME_RIGHT. The
        # resolved width is what is left of the frame once both declared insets
        # are taken off it, so it TRACKS the frame instead of restating a number
        # that was only ever true at one window size.
        bw = frame_right - rect["w"] - x0
        if bw <= 0:
            raise Refuse(
                "crop_rect_invalid",
                "%s: cropRect resolves to a width of %d. `xFrom`+`wFrom` read x=%d and "
                "w=%d as insets from the app frame's LEFT and RIGHT edges (%d and %d on "
                "this capture), and the two insets meet or cross — the frame is narrower "
                "than the margins the recipe asks for. The commonest cause is a rect "
                "converted to this form without re-reading `w`: under `wFrom` it is a "
                "GAP, so a leftover width (a number in the hundreds or thousands) "
                "produces exactly this."
                % (path, bw, rect["x"], rect["w"], frame_left, frame_right))
    if bw < MIN_DECLARED_PX or bh < MIN_DECLARED_PX:
        # 🔴 ON THE RESOLVED VALUES. Under `wFrom` the declared `w` is a gap of a
        # few pixels and the floor would refuse every legitimate rect if it ran on
        # what the recipe wrote; the floor is about the ASSET, which is the
        # resolved box. For an absolute rect the two are the same number.
        raise Refuse("crop_rect_invalid",
                     "%s: cropRect is %dx%d — below the %dpx minimum on an axis%s"
                     % (path, bw, bh, MIN_DECLARED_PX,
                        "" if not anch.w else
                        " (the width is RESOLVED: w=%d is a gap from the app frame's "
                        "right edge, not a width)" % rect["w"]))
    # 🔴 BOUND A FRAME-RELATIVE RECT BY THE IFRAME, NOT ONLY BY THE PNG. The probe
    # already reports the bottom gap and this path used to throw it away, so a
    # rect anchored to the iframe's TOP could run past its BOTTOM and photograph
    # the page footer below the app — the "plausible-looking wrong region" every
    # other refusal in this module exists to prevent, reachable with the two
    # numbers needed to catch it already in hand. Measured: top=163 bottom=900
    # (a 251px iframe) with h=1000 was ACCEPTED, putting 749px of page furniture
    # in the asset, while the DETECT path refuses the same shape.
    #
    # A NEGATIVE bottom gap means the iframe extends past the viewport, so there
    # is nothing below it to fall into and the PNG edge is the real limit —
    # `max(0, ...)` keeps that degenerate reading SAFE by construction, the same
    # way app_frame_bands does, rather than by a clamp someone has to remember.
    limit_h = h
    if anch.y:
        limit_h = h - max(0, app_frame[1])
    # 🔴 THE HORIZONTAL TWIN OF limit_h, and it is a genuinely NEW safety property
    # rather than a symmetry for its own sake: an x-anchored rect can run out of
    # the app's right edge into the host page exactly the way a y-anchored one can
    # run out of its bottom, and `x0 + bw > w` (the PNG) gets LOOSER as the window
    # grows — which is the whole shape of the 2026-09-02 incident. `min` with the
    # PNG keeps a degenerate reading SAFE by construction: a NEGATIVE right gap
    # means the iframe runs past the viewport, so `frame_right` exceeds `w` and
    # the PNG edge stays the real limit.
    limit_w = w
    if anch.x:
        limit_w = min(w, frame_right)
    if x0 + bw > limit_w or y0 + bh > limit_h:
        why = ""
        if anch.y:
            why += (" (y was declared %d and RESOLVED to %d against an app-frame top "
                    "edge of %d, and the bottom limit is the IFRAME'S OWN lower edge "
                    "at %d, not the %dpx frame — below that is page furniture, not "
                    "app. A frame-relative rect that fits in one banner layout can "
                    "also run off the bottom in the other, which is the other way "
                    "this fires.)" % (rect["y"], y0, frame_top, limit_h, h))
        if anch.x:
            why += (" (x was declared %d and RESOLVED to %d against an app-frame LEFT "
                    "edge of %d, and the right limit is the IFRAME'S OWN right edge at "
                    "%d, not the %dpx frame — right of that is host page, not app.)"
                    % (rect["x"], x0, frame_left, limit_w, w))
        raise Refuse("crop_rect_outside",
                     "%s: cropRect %dx%d+%d+%d runs outside the %dx%d frame — it would "
                     "crop to nothing or to a short image%s"
                     % (path, bw, bh, x0, y0, w, h, why))
    if bw >= w * FULL_FRAME_FRAC and bh >= h * FULL_FRAME_FRAC:
        raise Refuse("full_frame",
                     "%s: cropRect %dx%d covers >= %.0f%% of the %dx%d frame on BOTH axes "
                     "— that is a no-op crop. Declaring the rect does not buy a bypass of "
                     "the gate that exists to catch exactly this."
                     % (path, bw, bh, FULL_FRAME_FRAC * 100, w, h))
    # 🔴 STILL sample the background. Skipping detection does not mean skipping
    # this: render_argv pads the crop out to the store canvas with `-background
    # <bg>`, so a None here is not a missing nicety, it is a TypeError deep in
    # subprocess when magick is spawned — which is exactly how this was found,
    # by running the path rather than trusting the suite that had just gone
    # green over it.
    bg = Counter(
        (px[o], px[o + 1], px[o + 2])
        for y in range(0, h, DEF_STRIDE)
        for o in (y * w * 3 + x * 3 for x in range(0, w, DEF_STRIDE))
    ).most_common(1)[0][0]
    out = {
        "file": os.path.basename(path),
        "frame": {"w": w, "h": h},
        "bands": {"chromeTop": chrome_top, "footer": footer, "right": right},
        "usable": {"w": w, "h": h},
        "bg": "#%02x%02x%02x" % bg,
        "box": {"x": x0, "y": y0, "w": bw, "h": bh},
        "fill": {"w": round(bw / float(w), 4), "h": round(bh / float(h), 4)},
        # 🔴 Consumed by check_states: identical extents across states are EXPECTED
        # here (the rect is declared once), so the broken-cropper check must not
        # read them as evidence of a broken cropper.
        "mode": "declared",
    }
    if relative:
        # 🔴 REPORTED, not merely applied. A frame-relative rect is the one form
        # whose `box` differs from what the recipe says, so an operator reading
        # a measurement has no other way to tell a working resolution from a rect
        # that happened to land plausibly. This is also what the both-layouts gate
        # reads.
        #
        # 🔴 ONE KEY PER ANCHOR THAT ACTUALLY FIRED, never a fixed set. A report
        # that always names `xFrom` would say the horizontal anchor resolved on a
        # rect that never asked for it — a claim of coverage where there is none,
        # which is the exact defect class this whole change was written after.
        res = {}
        if anch.y:                    # report the VERTICAL anchor only when it fired
            res.update({"yFrom": RECT_Y_APP_FRAME, "declaredY": rect["y"],
                        "appFrameTop": frame_top})
        if anch.x:                    # report the LEFT-edge anchor only when it fired
            res.update({"xFrom": RECT_X_APP_FRAME, "declaredX": rect["x"],
                        "appFrameLeft": frame_left, "appFrameRight": frame_right})
        if anch.w:                    # report the FAR-edge width only when it fired
            res.update({"wFrom": RECT_W_APP_FRAME_RIGHT, "declaredW": rect["w"],
                        "resolvedW": bw})
        out["resolved"] = res
    return out


# ------------------------------------------------- bands from the app frame --
def app_frame_rect_js(frame_host):
    """The top-frame probe that measures the app iframe, as ONE LINE of JS.

    🔴 IT RETURNS A BARE TOKEN, never JSON. The bridge wraps a `js` result in
    `{"data":{"value":...}}` and backslash-escapes every quote inside it, so a
    JSON payload comes back needing two levels of unescaping and any needle a
    caller greps for would not match. plan.py's app-ready probe answers the same
    way for the same reason.

    🔴 IT REPORTS GAPS, NOT COORDINATES, AND IT REPORTS THE VIEWPORT TOO. Gaps
    are what the bands are, so nothing downstream has to know the frame size;
    and the viewport is the POSITIVE CONTROL — app_frame_bands refuses when it
    disagrees with the PNG the bridge actually wrote, which is the only way a
    devicePixelRatio this code cannot see is caught rather than silently applied
    in the wrong units.

    Rounding is deliberately asymmetric — ceil on the top gap, floor on the far
    edges — so the derived rect is INSCRIBED in the iframe. A half-pixel rounded
    the other way would readmit the bottom border row of the breadcrumb bar
    above it, which is full width, which is the whole defect.

    🔴 SIX NUMBERS SINCE 2026-09-02, AND THE SIXTH IS APPENDED, NOT INSERTED.
    `left` is last so that every index a five-field consumer reads keeps its
    meaning — the parser still accepts a five-number answer (see
    parse_app_frame_rect) and every existing fixture and test stays valid. It
    exists because the first five could place the frame's TOP, BOTTOM and RIGHT
    edges but NOT its left edge or its width, so the horizontal axis had no live
    witness of any kind; RECT_X_APP_FRAME's note above is the whole story.
    `Math.ceil` matches the TOP gap rather than the far edges: `left` is a NEAR
    edge, an anchor that a coordinate is added to, and rounding an anchor
    outwards would put the crop's first column in the host page.
    """
    host = json.dumps(frame_host)
    js = ('(function(){var d=document,w=window,H=%s;'
          'var f=d.querySelector(\'iframe[data-testid="%s"]\');'
          'var L=d.getElementsByTagName("iframe");'
          'if(!f){for(var i=0;i<L.length;i++){if((L[i].getAttribute("src")||"").indexOf(H)>=0){f=L[i];break}}}'
          'if(!f&&L.length===1){f=L[0]}'
          'if(!f)return "%s";'
          'var r=f.getBoundingClientRect(),p=w.devicePixelRatio||1;'
          'return "%s"+Math.ceil(r.top*p)+","'
          '+Math.floor((w.innerHeight-r.bottom)*p)+","'
          '+Math.floor((w.innerWidth-r.right)*p)+","'
          '+Math.round(w.innerWidth*p)+","+Math.round(w.innerHeight*p)+","'
          '+Math.ceil(r.left*p)})()'
          % (host, APP_FRAME_TESTID, APP_FRAME_ABSENT, APP_FRAME_TOKEN))
    guard_rect_js(js)
    if "\n" in js or "\r" in js:      # the argv seam: one line per element
        raise Refuse("rect_js_multiline",
                     "the app-frame probe is not one line — capture.sh hands it "
                     "to the bridge as a single argv element")
    return js


def guard_rect_js(js):
    for tok in RECT_JS_FORBIDDEN:
        if tok in js:
            raise Refuse(
                "rect_js_actuates",
                "the app-frame probe contains %r, which can ACTUATE the page. It "
                "runs in the MAIN world of a live, logged-in app; capture never "
                "spends and never mutates. Refusing to emit it." % tok)


def parse_app_frame_rect(text):
    """(top, bottom, right, vw, vh, left) out of whatever the bridge printed.

    Scans for the token rather than parsing the envelope: the bridge's JSON
    shape has changed before, and this only ever needs five or six integers.

    🔴 FIVE OR SIX, AND `left` IS `None` ON A FIVE-FIELD ANSWER — WHICH IS NOT A
    FALLBACK. A five-number answer is the pre-2026-09-02 probe, and the only
    thing that could ever produce one now is a stale or foreign probe. Accepting
    it keeps every band, every bound and every `yFrom` rect working exactly as
    before, because none of them ever read a left edge. What it must NOT do is
    let an `xFrom` rect quietly resolve against something: `declared_box` refuses
    with `app_frame_left_missing` the moment a horizontal anchor meets a `None`
    here. That split is deliberate — degrading the OLD forms would be a gratuitous
    outage, and degrading the NEW one would be the silent-fallback defect this
    whole form exists to remove.
    """
    if APP_FRAME_TOKEN not in text:
        if APP_FRAME_ABSENT in text:
            raise Refuse(
                "app_frame_absent",
                "the app-frame probe found NO iframe in the top frame — not by "
                "data-testid=%r, not by a src carrying the recipe's frameHost, "
                "and the page does not have exactly one. The recipe asked for "
                "`crop.fromAppFrame`, so there is no band to derive and this run "
                "will not fall back to the static ones: a static chromeTop is "
                "unsatisfiable on a page whose rewards banner may or may not be "
                "showing, and falling back would restore exactly the defect this "
                "exists to remove. Check the app really rendered, then re-measure "
                "the handle in the host page." % APP_FRAME_TESTID)
        raise Refuse(
            "app_frame_unreadable",
            "the app-frame probe returned neither %r nor %r. The bridge answered: "
            "%s" % (APP_FRAME_TOKEN, APP_FRAME_ABSENT, text.strip()[:200] or "(nothing)"))
    tail = text.split(APP_FRAME_TOKEN, 1)[1]
    # 🔴 ASCII DIGITS ONLY, and a lone "-" is not a number. `str.isdigit()` is true
    # for Arabic-Indic and other non-ASCII digits, which `int()` then happily
    # accepts — and `int("-")` raises. Neither is reachable from the real bridge
    # (this text is our own probe's output), but a parser that raises where it
    # promises to REFUSE turns a bad read into a traceback instead of a sentence,
    # and this one runs on whatever a bridge error happened to print.
    num, out = "", []
    for ch in tail:
        if ("0" <= ch <= "9") or (ch == "-" and not num):
            num += ch
        elif ch == "," and num not in ("", "-"):
            out.append(int(num)); num = ""
        else:
            break
    if num not in ("", "-"):
        out.append(int(num))
    if len(out) not in (5, 6):
        raise Refuse("app_frame_unreadable",
                     "the app-frame probe returned %d number(s), not 5 or 6 "
                     "(top,bottom,right,viewportW,viewportH[,left]): %s"
                     % (len(out), tail[:80]))
    if len(out) == 5:
        out.append(None)
    return tuple(out)


def app_frame_bands(ct, ft, rt, rect, png_w, png_h):
    """🔴 THE RECT WIDENS THE BANDS; IT NEVER NARROWS THEM.

    The iframe rect answers "where does the app begin", which is what a fixed
    `chromeTop` gets wrong the moment the rewards banner appears. It does NOT
    answer "what furniture is drawn on top of the app": the window scrollbar and
    the floating support button are top-frame, position-fixed, and OVERLAP the
    iframe, which is what `right: 70` has always been for. So the rect is a FLOOR
    on each exclusion and the recipe's own value is the other floor — `max` of
    the two.

    That is not a nicety, it is what makes every degenerate reading SAFE by
    construction rather than by a clamp someone has to remember: an iframe that
    extends below the viewport reports a NEGATIVE bottom gap, a scrolled page
    reports a negative top gap, and both simply lose to the recipe's value. The
    derivation therefore cannot introduce the "a band was dropped" failure that
    F2/F3/F4 pin — it can only ever exclude MORE.
    """
    # `rect[:5]` and not a six-way unpack: the bands have never had anything to
    # do with the frame's LEFT edge, and slicing keeps every hand-built 5-tuple
    # in the suite meaning exactly what it meant before the sixth number existed.
    top, bottom, right, vw, vh = rect[:5]
    if abs(vw - png_w) > APP_FRAME_SCALE_SLACK or abs(vh - png_h) > APP_FRAME_SCALE_SLACK:
        raise Refuse(
            "app_frame_scale",
            "the page reports a %dx%d device-pixel viewport but the capture is "
            "%dx%d. The rect is measured in CSS pixels and scaled by "
            "devicePixelRatio; a disagreement bigger than %dpx means the two are "
            "not describing the same photograph (a DPR the probe read differently "
            "from the one the bridge captured at, a resize mid-run, or a "
            "screenshot from another tab), and the derived bands would be in the "
            "wrong units. Refusing rather than cropping to a plausible-looking "
            "wrong region." % (vw, vh, png_w, png_h, APP_FRAME_SCALE_SLACK))
    return max(ct, top), max(ft, bottom), max(rt, right)


def gate_box(m):
    """The full-frame / empty-frame refusals. Separated from content_box so the
    suite can assert the arithmetic and the verdict independently."""
    if m.get("mode") == "declared":
        return m          # already gated in declared_box, on different criteria
    fw, fh = m["fill"]["w"], m["fill"]["h"]
    if fw >= FULL_FRAME_FRAC or fh >= FULL_FRAME_FRAC:
        # 🔴 THIS MEASUREMENT HAS TWO CAUSES AND THE MESSAGE MUST NAME BOTH.
        # Until 2026-08-25 it asserted only the first, and sent the reader to
        # tune exclusion bands on a frame that can never be trimmed below the
        # threshold — app-requests (46.9% x 98.3%) and playable-collections
        # (63.9% x 100.0%) are both scrolling, content-dense apps whose content
        # legitimately fills the vertical band. A one-cause message on a
        # two-cause measurement is an instruction to the wrong file.
        raise Refuse(
            "full_frame",
            "%s: content box fills %.1f%% x %.1f%% of the usable band (>= %.0f%% on an "
            "axis). TWO CAUSES, and the axis tells you which:\n"
            "  (a) the detector found page FURNITURE, not content — the footer pins "
            "WIDTH, the right-edge scrollbar/support button pins HEIGHT. Fix the "
            "exclusion bands (chromeTop=%d footer=%d right=%d), do not widen this gate.\n"
            "  (b) the app's content GENUINELY fills the band — a full-bleed or "
            "scrolling, content-dense app. No band setting can fix this and the gate "
            "is right to refuse. Declare the crop instead: `crop.rect` in the recipe, "
            "as sensei.json does (in its ANCHORED form — see below). A declared rect bypasses "
            "DETECTION only (it is still "
            "checked for lying inside the frame, a %d px floor per axis, for not "
            "being the whole frame ON BOTH AXES — note that is AND, while this gate is "
            "OR, so a declared rect may legitimately be ~100%% on ONE axis — and, if it is "
            "FRAME-RELATIVE, for not running past the iframe's own lower edge), and it "
            "makes the identical-box check inert for these states — so verify such a "
            "crop BY EYE.\n"
            "  🔴 WHICH RECT, and getting this wrong is a SECOND refusal: a bare `rect` "
            "is ABSOLUTE and is MUTUALLY EXCLUSIVE with `fromAppFrame` "
            "(crop_rect_invalid), which most shipped recipes set. EVERY app here is on "
            "an `apps/run/<slug>` page, so the conditional banner moves them all ~36 px "
            "— an absolute rect is wrong in one of the two layouts by construction, and "
            "NO SHIPPED RECIPE TAKES THAT TRADE any more. sensei.json used to and was "
            "cited here as the exception; measured 2026-08-27, it was not an exception "
            "but an unfixed instance, and it converted. So the bare form is right only "
            "where the page has no conditional banner — which is nowhere in this "
            "corpus. The one constraint on the anchored form: the crop must start AT OR "
            "BELOW the iframe's top edge, because a frame-relative `y` cannot be "
            "negative. Keep `fromAppFrame` and give "
            "the rect a yFrom of %r: `y` is then measured DOWN FROM THE IFRAME'S TOP "
            "EDGE and moves with the banner, while x/w/h stay absolute. Its limits — "
            "`y` cannot be negative, so a crop starting ABOVE the iframe top cannot use "
            "it, and an app whose layout responds to its frame's HEIGHT is not modelled "
            "— are in "
            ".claude/skills/app-capture/reference/cropping-and-attaching.md. "
            "Read it before taking either."
            % (m["file"], fw * 100, fh * 100, FULL_FRAME_FRAC * 100,
               m["bands"]["chromeTop"], m["bands"]["footer"], m["bands"]["right"],
               MIN_DECLARED_PX, RECT_Y_APP_FRAME),
        )
    if fw <= MIN_FILL_FRAC or fh <= MIN_FILL_FRAC:
        raise Refuse(
            "empty_frame",
            "%s: content box fills only %.1f%% x %.1f%% — nothing rendered, or the tab "
            "was still throttled when it was captured (wake before every screenshot)."
            % (m["file"], fw * 100, fh * 100),
        )
    return m


# ------------------------------------------------------------- check-states --
def check_states(measures):
    """🔴 THE CHEAPEST REAL CHECK AVAILABLE. Different screens cannot have
    identical content extents. When the cropper is broken every state reports
    the SAME box — that is the tell, and it is the tell precisely because the
    numbers themselves look plausible.

    Compares EVERY pair, not just adjacent ones: the broken-cropper shapes make
    3-of-4 identical as readily as 4-of-4, and a first-two-only comparison
    passes those."""
    if len(measures) < 2:
        raise Refuse("too_few_states",
                     "check-states needs >= 2 states; got %d (a single state cannot "
                     "distinguish a working cropper from a broken one)" % len(measures))
    # 🔴 A DECLARED rect is exempt, and this is a REAL loss of coverage, not a
    # technicality. The check works because a DETECTED box is evidence about the
    # picture; a declared rect is the same constant on every state by
    # construction, so comparing them tests the JSON file, not the cropper. Left
    # in, it would refuse every full-bleed app; taken out silently, the safety
    # net would vanish unannounced. So: exempt them, and SAY SO in the result —
    # `declared` in the output is the operator's cue that for those states
    # nothing checked the crop is right except a human looking at it.
    detected = [m for m in measures if m.get("mode") != "declared"]
    n_declared = len(measures) - len(detected)
    if not detected:
        return {"states": len(measures), "distinct_boxes": 0, "declared": n_declared,
                "ok": True,
                "note": "every state used a DECLARED cropRect — the identical-box check "
                        "cannot say anything about these; verify the crop by eye"}
    seen = {}
    dupes = []
    for m in detected:
        b = m["box"]
        key = (b["x"], b["y"], b["w"], b["h"])
        if key in seen:
            dupes.append((seen[key], m["file"], key))
        else:
            seen[key] = m["file"]
    if dupes:
        detail = "; ".join(
            "%s and %s both report %dx%d+%d+%d" % (a, b, k[2], k[3], k[0], k[1])
            for a, b, k in dupes)
        raise Refuse(
            "identical_boxes",
            "IDENTICAL CONTENT BOXES ACROSS STATES — %s. Different screens cannot have "
            "identical content extents; the cropper is measuring page furniture. Check "
            "the right-edge and footer exclusion bands." % detail,
        )
    return {"states": len(measures), "distinct_boxes": len(seen),
            "declared": n_declared, "ok": True}


# ------------------------------------------------------------------ bounds --
def load_bounds(path):
    with open(path) as fh:
        return json.load(fh)


def gate_bounds(kind, files, bounds_path, count_override=None):
    cfg = load_bounds(bounds_path)
    assets = cfg["assets"]
    if kind not in assets:
        raise Refuse("unknown_kind", "unknown asset kind %r (known: %s)"
                     % (kind, ", ".join(sorted(assets))))
    b = assets[kind]
    problems = []
    results = []
    n = count_override if count_override is not None else len(files)
    if n > b["max_count"]:
        problems.append("count %d exceeds the %s limit of %d" % (n, kind, b["max_count"]))
    for f in files:
        w, h = image_size(f)
        size = os.path.getsize(f)
        ar = w / float(h)
        rec = {"file": os.path.basename(f), "w": w, "h": h,
               "aspect": round(ar, 4), "bytes": size}
        if ar < b["aspect_min"] or ar > b["aspect_max"]:
            problems.append("%s: aspect %.3f outside %s range %s-%s"
                            % (rec["file"], ar, kind, b["aspect_min"], b["aspect_max"]))
        if "min_dimension" in b and min(w, h) < b["min_dimension"]:
            problems.append("%s: smallest dimension %d below the %s minimum %d"
                            % (rec["file"], min(w, h), kind, b["min_dimension"]))
        if "max_dimension" in b and max(w, h) > b["max_dimension"]:
            problems.append("%s: largest dimension %d above the %s maximum %d"
                            % (rec["file"], max(w, h), kind, b["max_dimension"]))
        if "min_width" in b and w < b["min_width"]:
            problems.append("%s: width %d below the %s minimum width %d"
                            % (rec["file"], w, kind, b["min_width"]))
        if size > b["max_bytes"]:
            problems.append("%s: %d bytes exceeds the %s limit of %d"
                            % (rec["file"], size, kind, b["max_bytes"]))
        results.append(rec)
    if problems:
        raise Refuse("store_bounds", "%s bounds violated: %s" % (kind, "; ".join(problems)))
    out = {"kind": kind, "count": n, "assets": results, "ok": True}
    if kind == "icon":
        out["warning"] = ("an icon is re-encoded server-side to PNG and the re-encode is "
                          "capped separately — a detailed 1024x1024 icon can pass here and "
                          "still be refused on attach")
    return out


# ------------------------------------------------------------------ render --
def render_argv(src, m, out, bounds_path, pad):
    cfg = load_bounds(bounds_path)
    r = cfg["render"]
    W, H = r["width"], r["height"]
    b = m["box"]
    fw, fh = m["frame"]["w"], m["frame"]["h"]
    top = m["bands"]["chromeTop"]
    if m.get("mode") == "declared":
        # 🔴 A DECLARED rect is used VERBATIM: no pad, and clamped to the FRAME
        # rather than to the detection bands. Padding a detected box is right —
        # the detector returns the tight ink extent and a margin looks better —
        # but the author of a declared rect already said exactly what they want,
        # and the band clamp below is meaningless when nothing was detected.
        #
        # This shipped WRONG for one revision and produced a plausible image from
        # the wrong geometry: `y0 = max(top, y - pad)` clamped a declared y=97 up
        # to chromeTop=182, and `x1 = min(fw, x + w + pad)` widened 1694 back out
        # to the full 1709, so two different rects rendered byte-identical output
        # (same md5) that still looked like a reasonable screenshot. Caught only
        # by diffing two renders that were supposed to differ.
        x0, y0 = max(0, b["x"]), max(0, b["y"])
        x1, y1 = min(fw, b["x"] + b["w"]), min(fh, b["y"] + b["h"])
    else:
        x0 = max(0, b["x"] - pad)
        y0 = max(top, b["y"] - pad)
        x1 = min(fw, b["x"] + b["w"] + pad)
        y1 = min(fh, b["y"] + b["h"] + pad)
    argv = ["magick", src,
            "-crop", "%dx%d+%d+%d" % (x1 - x0, y1 - y0, x0, y0), "+repage",
            "-resize", "%dx%d" % (W, H),
            "-background", m["bg"], "-gravity", "center",
            "-extent", "%dx%d" % (W, H)]
    if out.lower().endswith((".jpg", ".jpeg")):
        argv += ["-quality", "92"]
    argv.append(out)
    return {"src": src, "out": out, "canvas": {"w": W, "h": H},
            "crop": {"x": x0, "y": y0, "w": x1 - x0, "h": y1 - y0}, "argv": argv}


# -------------------------------------------------------------------- main --
def band_args(ap):
    ap.add_argument("--chrome-top", type=int, default=DEF_CHROME_TOP)
    ap.add_argument("--footer", type=int, default=DEF_FOOTER)
    ap.add_argument("--right", type=int, default=DEF_RIGHT)
    ap.add_argument("--stride", type=int, default=DEF_STRIDE)
    ap.add_argument("--tolerance", type=int, default=DEF_TOLERANCE)
    ap.add_argument("--recipe", help="read crop band overrides from a recipe's `crop` block")
    ap.add_argument("--crop-rect",
                    help='declare the crop instead of detecting it: \'{"x":0,"y":100,"w":1694,"h":1085}\'. '
                         'For FULL-BLEED apps, where content-detection cannot work. Add '
                         '"yFrom":"appFrame" (and the recipe\'s crop.fromAppFrame) to anchor y '
                         'to the app iframe\'s top edge, for a scrolling app on a page whose '
                         'rewards banner moves it.')
    ap.add_argument("--measured-viewport",
                    help="WxH — the device-pixel viewport a --crop-rect was measured in. "
                         "REQUIRED with --crop-rect, and REFUSED alongside a recipe that "
                         "already records `crop._measuredGeometry.viewport` (two records "
                         "of one fact). The capture must match it, or the rect is being "
                         "applied to a window it never described.")
    ap.add_argument("--app-frame-rect",
                    help="the app-frame probe's answer (a file written by capture.sh, "
                         "or the token itself). Required by, and only accepted for, a "
                         "recipe whose `crop` sets fromAppFrame.")


def bands_from(a):
    ct, ft, rt = a.chrome_top, a.footer, a.right
    st, tol = a.stride, a.tolerance
    if a.recipe:
        with open(a.recipe) as fh:
            crop = json.load(fh).get("crop", {})
        ct = crop.get("chromeTop", ct)
        ft = crop.get("footer", ft)
        rt = crop.get("right", rt)
        st = crop.get("stride", st)
        tol = crop.get("tolerance", tol)
    return ct, ft, rt, st, tol


def rect_from(a):
    """The DECLARED crop rect, or None to detect one. Recipe `crop.rect`."""
    if getattr(a, "crop_rect", None):
        try:
            return json.loads(a.crop_rect)
        except ValueError:
            raise Refuse("crop_rect_invalid",
                         "--crop-rect is not JSON: %r" % a.crop_rect)
    if a.recipe:
        with open(a.recipe) as fh:
            return json.load(fh).get("crop", {}).get("rect")
    return None


def crop_block(a):
    if getattr(a, "recipe", None):
        with open(a.recipe) as fh:
            return json.load(fh).get("crop") or {}
    return {}


def app_frame_from(a, crop, declared):
    """The parsed app-frame rect, or None — plus the two SEAM refusals.

    🔴 BOTH DIRECTIONS OF THE SEAM ARE REFUSALS, and that is the point. A recipe
    that asks for a derived band and gets none must STOP, or the run silently
    reverts to the static band that cannot be right in both banner states — the
    reassuring-fallback shape. And a rect handed to a recipe that never asked for
    one means the caller and the recipe disagree about which crop this is, so it
    is refused too rather than quietly applied or quietly dropped.
    """
    wants = bool(crop.get("fromAppFrame"))
    raw = getattr(a, "app_frame_rect", None)
    relative = bool(declared) and rect_is_frame_relative(declared)
    if wants and declared and not relative:
        raise Refuse(
            "crop_rect_invalid",
            "the recipe declares BOTH an ABSOLUTE crop `rect` and `fromAppFrame`. A "
            "declared rect bypasses detection entirely, so a derived detection band "
            "would have nothing to act on, and an absolute rect is wrong by the "
            "rewards banner's ~36px in the other layout — which is what `fromAppFrame` "
            "is there to remove, so the pair is incoherent. Pick one: an absolute "
            "`rect` for a full-bleed app on a page with NO conditional banner (no "
            "shipped recipe is one — sensei was, and converted), `fromAppFrame` alone "
            "for a centred-column one, or — for an app that needs "
            "BOTH — add `\"yFrom\": \"%s\"` to the rect, which anchors its `y` to the "
            "iframe's top edge and is the only form in which the two combine."
            % RECT_Y_APP_FRAME)
    if relative and not wants:
        raise Refuse(
            "crop_rect_invalid",
            "the recipe's crop `rect` sets yFrom=%r but the crop does NOT set "
            "`fromAppFrame`. `fromAppFrame` is what makes capture.sh run the probe "
            "that reads the iframe's top edge, so without it there is nothing to "
            "resolve `y` against and the rect would silently be read as ABSOLUTE — "
            "wrong by the rewards banner's ~36px in one of the two layouts. Set both, "
            "or drop the marker and own the absolute rect." % RECT_Y_APP_FRAME)
    if wants and not raw:
        raise Refuse(
            "app_frame_rect_missing",
            "the recipe's crop sets `fromAppFrame`, but no --app-frame-rect was "
            "supplied. capture.sh reads the app iframe's rect once per state and "
            "passes it here; if that wiring is gone, the crop would fall back to a "
            "static chromeTop, which is unsatisfiable on a page carrying a "
            "conditional rewards banner. Refusing rather than shipping the old bug.")
    if raw and not wants:
        raise Refuse(
            "app_frame_rect_unexpected",
            "an --app-frame-rect was supplied for a recipe whose crop does not set "
            "`fromAppFrame`. The caller and the recipe disagree about how this app "
            "is cropped; applying it silently would make the recipe's own bands a "
            "lie.")
    if not raw:
        return None
    text = open(raw).read() if os.path.exists(raw) else raw
    return parse_app_frame_rect(text)


def resolve_bands(png, a, declared):
    """The bands this capture is actually measured with — one place, so `measure`
    and `render` cannot drift (which they did once, over the declared-rect path:
    see render_argv's note).

    Returns the parsed app-frame rect alongside the bands: a frame-relative
    declared rect needs the same tuple, and reading it TWICE would be two chances
    for `measure` and `render` to disagree about the edge they anchored to.

    🔴 `app_frame_bands` still runs on the declared path even though nothing
    detects there. It is not doing band work — it is the VIEWPORT CROSS-CHECK,
    the only thing that catches a devicePixelRatio this code cannot see, and a
    rect anchored to an edge measured in the wrong units is exactly as wrong as a
    band derived from one.
    """
    ct, ft, rt, st, tol = bands_from(a)
    rect = app_frame_from(a, crop_block(a), declared)
    if rect:
        w, h = image_size(png)
        ct, ft, rt = app_frame_bands(ct, ft, rt, rect, w, h)
    return ct, ft, rt, st, tol, rect


def boxed(png, a, gate=True):
    """One place that decides detect-vs-declare, so measure and render cannot drift."""
    declared = rect_from(a)
    cli_vp = getattr(a, "measured_viewport", None)
    ct, ft, rt, st, tol, app_frame = resolve_bands(png, a, declared)
    if declared:
        return declared_box(png, declared, ct, ft, rt, app_frame,
                            viewport_of_record(crop_block(a), cli_vp))
    if cli_vp is not None:
        # The other direction of the same seam. `is not None`, not truthiness, so
        # that `--measured-viewport ""` refuses too rather than being the one
        # spelling this branch lets through silently. Nothing DETECTED is measured in a
        # recorded viewport — the bands are re-derived per capture — so a flag
        # that only means something for a declared rect, on a run that declares
        # none, means the caller thinks a rect is in play and it is not (a
        # mistyped --crop-rect is the reachable case). Same code, same operator
        # action, same exit as the other conflict.
        raise Refuse(
            "viewport_record_conflict",
            "--measured-viewport %r was supplied but this run DETECTS its crop — no "
            "rect is declared, so there is nothing whose absolute coordinates that "
            "viewport could describe. Did --crop-rect (or the recipe's `crop.rect`) "
            "not arrive?" % (cli_vp,))
    m = content_box(png, ct, ft, rt, st, tol)
    return gate_box(m) if gate else m


def main(argv=None):
    ap = argparse.ArgumentParser(prog="frame.py")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("measure")
    p.add_argument("png")
    band_args(p)
    p.add_argument("--no-gate", action="store_true",
                   help="report the box WITHOUT the full-frame refusal (diagnosis only)")

    p = sub.add_parser("frame-rect-js",
                       help="print the one-line top-frame JS that measures this "
                            "recipe's app iframe. capture.sh runs it; the SOURCE "
                            "lives here so it is pinned, guarded and testable.")
    p.add_argument("--recipe", required=True)

    p = sub.add_parser("check-states")
    p.add_argument("measures", help="JSON file: a list of `measure` outputs, or '-' for stdin")

    p = sub.add_parser("bounds")
    p.add_argument("kind")
    p.add_argument("files", nargs="+")
    p.add_argument("--bounds", default=DEFAULT_BOUNDS)
    p.add_argument("--count", type=int, default=None,
                   help="total assets that WOULD be on the listing (default: len(files))")

    p = sub.add_parser("render")
    p.add_argument("png")
    p.add_argument("--out", required=True)
    p.add_argument("--pad", type=int, default=18)
    p.add_argument("--bounds", default=DEFAULT_BOUNDS)
    p.add_argument("--exec", action="store_true", help="actually run magick (impure)")
    band_args(p)

    a = ap.parse_args(argv)
    try:
        if a.cmd == "measure":
            print(json.dumps(boxed(a.png, a, gate=not a.no_gate),
                             indent=2, sort_keys=True))
        elif a.cmd == "frame-rect-js":
            with open(a.recipe) as fh:
                rec = json.load(fh)
            # plan.py validates frameHost long before a real run reaches here, but
            # this subcommand is reachable on its own — and a bare KeyError under a
            # handler that promises a REFUSE line is a traceback where the caller
            # is looking for a sentence.
            if not rec.get("frameHost"):
                raise Refuse("bad_recipe",
                             "%s declares no `frameHost`, so there is no iframe for the "
                             "app-frame probe to look for. Every recipe needs one — it "
                             "is how the app's own frame is told from the host page."
                             % a.recipe)
            print(app_frame_rect_js(rec["frameHost"]))
        elif a.cmd == "check-states":
            src = sys.stdin.read() if a.measures == "-" else open(a.measures).read()
            print(json.dumps(check_states(json.loads(src)), indent=2, sort_keys=True))
        elif a.cmd == "bounds":
            print(json.dumps(gate_bounds(a.kind, a.files, a.bounds, a.count),
                             indent=2, sort_keys=True))
        elif a.cmd == "render":
            m = boxed(a.png, a)
            r = render_argv(a.png, m, a.out, a.bounds, a.pad)
            if a.exec:
                import subprocess
                rc = subprocess.call(r["argv"])
                if rc != 0:
                    raise Refuse("render_failed",
                                 "magick exited %d (is imagemagick on PATH? on NixOS: "
                                 "nix-shell -p imagemagick)" % rc)
                r["executed"] = True
            print(json.dumps(r, indent=2, sort_keys=True))
    except Refuse as e:
        sys.stderr.write("REFUSE[%s]: %s\n" % (e.code, e.msg))
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
