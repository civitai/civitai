#!/usr/bin/env python3
"""Emit a PNG of exact dimensions and (optionally) an exact byte size.

🔴 SCOPE: this is for the STORE-BOUNDS gate only — dimension/aspect/byte/count
arithmetic. It is deliberately NOT used for the cropper, whose fixtures are the
REAL captures next to this file: a clean synthetic page carries no footer and no
right-edge furniture, which are exactly the two traps that made the cropper
silently no-op. Synthesising a cropper fixture would produce a gate that passes
on a page that does not exist.

  mkpng.py OUT W H [--bytes N] [--noise]

--bytes pads with a tEXt chunk to land on EXACTLY N bytes, so a `<=` vs `<`
off-by-one on a size limit is reachable by a test.
"""
import argparse
import os
import struct
import sys
import zlib


def chunk(typ, body):
    return (struct.pack(">I", len(body)) + typ + body
            + struct.pack(">I", zlib.crc32(typ + body) & 0xFFFFFFFF))


def build(w, h, noise, text_len=None):
    raw = bytearray()
    for y in range(h):
        raw.append(0)  # filter: None
        if noise:
            raw += os.urandom(w * 3)
        else:
            raw += bytes([0x1A, 0x1B, 0x1E] * w)
    out = b"\x89PNG\r\n\x1a\n"
    out += chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
    if text_len is not None:
        out += chunk(b"tEXt", b"pad\x00" + b"P" * text_len)
    out += chunk(b"IDAT", zlib.compress(bytes(raw), 9 if not noise else 0))
    out += chunk(b"IEND", b"")
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("w", type=int)
    ap.add_argument("h", type=int)
    ap.add_argument("--bytes", type=int, default=None,
                    help="pad to EXACTLY this many bytes")
    ap.add_argument("--noise", action="store_true",
                    help="incompressible pixels, for 'too large' cases")
    a = ap.parse_args()

    data = build(a.w, a.h, a.noise)
    if a.bytes is not None:
        base = len(build(a.w, a.h, a.noise, text_len=0))
        pad = a.bytes - base
        if pad < 0:
            sys.exit("cannot pad down to %d: the bare image is already %d bytes"
                     % (a.bytes, base))
        data = build(a.w, a.h, a.noise, text_len=pad)
        if len(data) != a.bytes:
            sys.exit("padding arithmetic wrong: wanted %d got %d" % (a.bytes, len(data)))
    with open(a.out, "wb") as fh:
        fh.write(data)
    print("%s %dx%d %d bytes" % (a.out, a.w, a.h, len(data)))


if __name__ == "__main__":
    main()
