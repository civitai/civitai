#!/usr/bin/env python3
# ============================================================================
# bannershift.py — cut a BANNER STATE out of a real capture.
#
# 🔴 WHY THIS EXISTS. `civitai.com/apps/run/<slug>` renders a CONDITIONAL,
# full-width rewards banner ("BONUS REWARDS ACTIVE") above the app iframe. It is
# ~32-36 px tall and it appears asynchronously, after a Buzz-multiplier query
# resolves — so the SAME app, on the SAME viewport, has two layouts that differ
# by a constant vertical offset, and the whole `crop.fromAppFrame` change exists
# because no fixed `chromeTop` can be correct in both.
#
# The corpus has captures of the banner-ABSENT state only (they were shot on a
# session that had no bonus running). Rather than synthesise a page — a clean
# synthetic frame carries neither the full-width footer nor the right-edge
# furniture, which is exactly what made the cropper silently no-op twice — this
# cuts the banner state OUT of a real capture: insert an N-row full-width strip
# at `--at`, push everything below it down by N, and drop the N rows that fall
# off the bottom (which is what the viewport does).
#
# 🔴 INDEPENDENT OF THE CODE UNDER TEST, on purpose and in the same spirit as
# domsurgery.py: it shares no PNG code with frame.py. A fixture built by the
# decoder it is meant to challenge cannot challenge it.
#
#   bannershift.py <in.png> <out.png> [--at 100] [--height 36] [--rgb 82,52,10]
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
    ap = argparse.ArgumentParser(prog="bannershift.py")
    ap.add_argument("src")
    ap.add_argument("out")
    ap.add_argument("--at", type=int, default=100,
                    help="row the banner is inserted at (default 100: inside the "
                         "site header/subnav stack, above every exclusion band)")
    ap.add_argument("--height", type=int, default=36,
                    help="banner height in device pixels (measured: 194 -> 230 on "
                         "a real pair of captures, i.e. 36)")
    ap.add_argument("--rgb", default="82,52,10",
                    help="banner colour. It must DIFFER from the page background "
                         "or it is not furniture and the fixture proves nothing.")
    a = ap.parse_args()
    r, g, b = (int(v) for v in a.rgb.split(","))
    w, h, rows = read_png(a.src)
    if not 0 <= a.at < h:
        sys.exit("--at %d is outside the %dx%d frame" % (a.at, w, h))
    strip = [bytearray(bytes((r, g, b)) * w) for _ in range(a.height)]
    out = rows[:a.at] + strip + rows[a.at:]
    out = out[:h]              # the viewport is a fixed height: the tail falls off
    write_png(a.out, w, h, out)
    print("%s -> %s: %d-row banner at y=%d, everything below shifted +%d"
          % (a.src, a.out, a.height, a.at, a.height))


if __name__ == "__main__":
    main()
