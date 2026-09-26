#!/usr/bin/env python3
# ============================================================================
# framewiden.py — cut a WIDER-WINDOW state out of a real capture.
#
# 🔴 WHY THIS EXISTS. `bannershift.py` models the VERTICAL thing that moves the
# app frame: a conditional banner that pushes the iframe down. This models the
# HORIZONTAL one, which is the operator's own window. Measured 2026-09-02, the
# capture viewport went 1709x1255 -> 3431x1286 -> 1135x1314 inside one session,
# because the operator tiles their i3 workspace and Brave resizes with it; the
# host page lays the app out in a max-width container, so above that breakpoint
# the frame keeps its WIDTH and both of its insets GROW.
#
# That is exactly what this does. It inserts `--pad` columns of host-page ink at
# the app frame's LEFT edge and another `--pad` at its RIGHT edge, so:
#
#     out = row[0:L] + pad + row[L:R] + pad + row[R:w]
#
# The frame's own pixels are carried across BYTE FOR BYTE and land `--pad`
# columns further right; its width is unchanged; the viewport is `2*pad` wider.
# A rect anchored to the frame's edges must therefore photograph the identical
# region in both files, and an ABSOLUTE one must not — which is the negative
# control that keeps the gate from measuring addition.
#
# 🔴 STATE WHAT THIS IS AND IS NOT EVIDENCE FOR, the way bannershift.py's own
# note does. The claim "the app's content does not move relative to its frame
# when the window widens" is TRUE BY CONSTRUCTION here, because the construction
# is a translation — it is not evidence about any real app, and a real app CAN
# reflow inside a constant-width frame (nothing here would show that; that is
# what a live re-shoot is for). What this fixture grades is the RESOLUTION
# ARITHMETIC — sign flips, the wrong axis, an inset read as a coordinate, a width
# read as a gap, off-by-ones — and it grades that hard.
#
# 🔴 INDEPENDENT OF THE CODE UNDER TEST, on purpose: it shares no PNG code with
# frame.py, the same way bannershift.py and domsurgery.py do not. A fixture built
# by the decoder it is meant to challenge cannot challenge it.
#
#   framewiden.py <in.png> <out.png> [--left 0] [--right W] [--pad 400]
#                 [--rgb 24,26,27]
# ============================================================================
import argparse
import struct
import sys
import zlib


def read_png(path):
    with open(path, "rb") as fh:
        data = fh.read()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        sys.exit("%s: not a PNG" % path)
    pos, idat, w, h = 8, bytearray(), None, None
    while pos + 8 <= len(data):
        ln, typ = struct.unpack(">I4s", data[pos:pos + 8])
        body = data[pos + 8:pos + 8 + ln]
        if typ == b"IHDR":
            w, h, depth, colour, _c, _f, interlace = struct.unpack(">IIBBBBB", body)
            if (depth, colour, interlace) != (8, 2, 0):
                sys.exit("%s: need 8-bit truecolour non-interlaced" % path)
        elif typ == b"IDAT":
            idat += body
        elif typ == b"IEND":
            break
        pos += 12 + ln
    raw = zlib.decompress(bytes(idat))
    stride = w * 3
    rows, prev, p = [], bytearray(stride), 0
    for _y in range(h):
        ft = raw[p]; p += 1
        line = bytearray(raw[p:p + stride]); p += stride
        if ft == 1:
            for i in range(3, stride):
                line[i] = (line[i] + line[i - 3]) & 255
        elif ft == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 255
        elif ft == 3:
            for i in range(stride):
                a = line[i - 3] if i >= 3 else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 255
        elif ft == 4:
            for i in range(stride):
                a = line[i - 3] if i >= 3 else 0
                b = prev[i]
                c = prev[i - 3] if i >= 3 else 0
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 255
        elif ft != 0:
            sys.exit("%s: unknown filter %d" % (path, ft))
        rows.append(line)
        prev = line
    return w, h, rows


def write_png(path, w, h, rows):
    raw = bytearray()
    for line in rows:
        raw.append(0)          # filter 0: no prediction. Bigger, and unambiguous.
        raw += line
    def chunk(typ, body):
        return (struct.pack(">I", len(body)) + typ + body
                + struct.pack(">I", zlib.crc32(typ + body) & 0xFFFFFFFF))
    with open(path, "wb") as fh:
        fh.write(b"\x89PNG\r\n\x1a\n")
        fh.write(chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)))
        fh.write(chunk(b"IDAT", zlib.compress(bytes(raw), 6)))
        fh.write(chunk(b"IEND", b""))


def main():
    ap = argparse.ArgumentParser(prog="framewiden.py")
    ap.add_argument("src")
    ap.add_argument("out")
    ap.add_argument("--left", type=int, default=0,
                    help="the app frame's left edge in the SOURCE, in device px "
                         "(default 0: every live probe answer in this repo's corpus "
                         "reads the frame as full-bleed at a 1709px viewport)")
    ap.add_argument("--right", type=int, default=None,
                    help="the app frame's right edge in the SOURCE (default: the "
                         "source's own width)")
    ap.add_argument("--pad", type=int, default=400,
                    help="columns of host ink inserted at EACH of the frame's two "
                         "edges. The viewport grows by twice this; the frame does not.")
    ap.add_argument("--rgb", default="24,26,27",
                    help="the inserted host-page ink. It must DIFFER from the app's "
                         "own background or the fixture cannot show a crop landing "
                         "outside the frame.")
    a = ap.parse_args()
    r, g, b = (int(v) for v in a.rgb.split(","))
    w, h, rows = read_png(a.src)
    right = w if a.right is None else a.right
    if not 0 <= a.left < right <= w:
        sys.exit("--left %d / --right %d is not a band inside the %dx%d frame"
                 % (a.left, right, w, h))
    if a.pad < 1:
        sys.exit("--pad must be at least 1 — a zero-width pad makes the two "
                 "captures identical, and a fixture that cannot disagree with "
                 "itself proves nothing")
    pad = bytes((r, g, b)) * a.pad
    out = [bytearray(bytes(line[:a.left * 3]) + pad + bytes(line[a.left * 3:right * 3])
                     + pad + bytes(line[right * 3:]))
           for line in rows]
    write_png(a.out, w + 2 * a.pad, h, out)
    print("%s -> %s: viewport %d -> %d, app frame [%d,%d) width %d UNCHANGED and "
          "moved +%d, insets %d/%d -> %d/%d"
          % (a.src, a.out, w, w + 2 * a.pad, a.left, right, right - a.left,
             a.pad, a.left, w - right, a.left + a.pad, (w - right) + a.pad))


if __name__ == "__main__":
    main()
