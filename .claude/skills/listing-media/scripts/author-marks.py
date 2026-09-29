#!/usr/bin/env python3
"""Author NEW offsite marks for radio + comfy — 2 candidates each, zero Buzz.

Grammar (operator-chosen): graphite plate + brand-hue mark, per the offsite
family rule that keeps hue non-scarce. Same 1024-unit design space and the same
draw helpers as the rev-5 author-assets.py, so these plug into the existing
light -> normalise pipeline unchanged.

🔴 The motifs are deliberately NOT the reverted ones. Those reused the very
motifs the PLACEHOLDERS already use (broadcast arcs / node graph), so they were
a restyle, not a re-imagining.

Renders each at 1024 (pipeline input) and 320 (the size the store actually
serves an icon at, which is where a motif fails).
"""
import colorsys
import os
import subprocess
import sys

OUT = sys.argv[1] if len(sys.argv) > 1 else "."
os.makedirs(OUT, exist_ok=True)

PLATE = "#24262B"  # graphite — the family signal, shared by every offsite app

HUE = {
    "radio": "#FF7A45",  # on-air lamp orange — native to the product, not imposed
    "comfy": "#3ECFE0",  # instrument cyan — the technical/graph register
}


def shade(hexs, dl):
    h = hexs.lstrip("#")
    r, g, b = (int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))
    hh, l, s = colorsys.rgb_to_hls(r, g, b)
    l = max(0.06, min(0.97, l + dl))
    r, g, b = colorsys.hls_to_rgb(hh, l, s)
    return "#%02X%02X%02X" % (round(r * 255), round(g * 255), round(b * 255))


def mark(name, hue):
    """Return magick draw args. 1024-unit space, centre 512,512."""
    lit = shade(hue, +0.20)   # a LIGHTER tint — on graphite a dark shade reads as a hole
    a = []

    if name == "radio-dial":
        # A tuning dial: ring + ticks + needle. Reads "tune a station" and is
        # geometric, so it authors exactly.
        a += ["-stroke", hue, "-strokewidth", "46", "-fill", "none"]
        a += ["-draw", "ellipse 512,512 292,292 0,360"]
        # ticks outside the ring, at the cardinal + diagonal angles
        import math
        a += ["-stroke", hue, "-strokewidth", "22"]
        for i in range(12):
            ang = math.radians(-90 + i * 30)
            x0, y0 = 512 + 356 * math.cos(ang), 512 + 356 * math.sin(ang)
            x1, y1 = 512 + 410 * math.cos(ang), 512 + 410 * math.sin(ang)
            a += ["-draw", f"line {x0:.1f},{y0:.1f} {x1:.1f},{y1:.1f}"]
        # needle, pointing up-right, plus a hub
        a += ["-stroke", lit, "-strokewidth", "40"]
        a += ["-draw", "line 512,512 700,324"]
        a += ["-stroke", "none", "-fill", lit]
        a += ["-draw", "circle 512,512 512,436"]

    elif name == "radio-onair":
        # An ON AIR sign: lit housing with two illuminated bars standing in for
        # the two words. Says "always on", which is the product's own claim.
        a += ["-stroke", "none", "-fill", hue]
        a += ["-draw", "roundrectangle 212,352 812,672 72,72"]
        a += ["-fill", PLATE]
        a += ["-draw", "roundrectangle 268,408 756,616 44,44"]
        a += ["-fill", lit]
        a += ["-draw", "roundrectangle 312,446 712,504 20,20"]
        a += ["-draw", "roundrectangle 312,528 604,586 20,20"]

    elif name == "comfy-patchbay":
        # A patch bay: a field of jack sockets with one cable patched across it.
        # Same "connect things" semantic as a node graph, different object.
        a += ["-stroke", hue, "-strokewidth", "20", "-fill", "none"]
        for x in (340, 684):
            for y in (380, 644):
                a += ["-draw", f"ellipse {x},{y} 54,54 0,360"]
        a += ["-stroke", hue, "-strokewidth", "34"]
        a += ["-draw", 'path "M 340,380 C 340,566 684,458 684,644"']
        a += ["-stroke", "none", "-fill", lit]
        a += ["-draw", "circle 340,380 340,346"]
        a += ["-draw", "circle 684,644 684,610"]

    elif name == "comfy-browser":
        # A browser window holding a flow: the only motif that says "in your
        # browser", which is half of what this app actually is.
        a += ["-stroke", hue, "-strokewidth", "26", "-fill", "none"]
        a += ["-draw", "roundrectangle 176,286 848,738 48,48"]
        a += ["-draw", "line 176,378 848,378"]
        a += ["-stroke", "none", "-fill", hue]
        for x in (238, 296, 354):
            a += ["-draw", f"circle {x},332 {x},316"]
        a += ["-draw", "roundrectangle 250,486 414,586 26,26"]
        a += ["-draw", "roundrectangle 610,486 774,586 26,26"]
        a += ["-stroke", lit, "-strokewidth", "24", "-fill", "none"]
        a += ["-draw", "line 414,536 610,536"]

    return a


CANDIDATES = [
    ("radio", "radio-dial"),
    ("radio", "radio-onair"),
    ("comfy", "comfy-patchbay"),
    ("comfy", "comfy-browser"),
]

for app, name in CANDIDATES:
    hue = HUE[app]
    big = f"{OUT}/{name}-1024.png"
    subprocess.run(
        ["magick", "-size", "1024x1024", f"xc:{PLATE}"] + mark(name, hue) + [big],
        check=True,
    )
    # the size the store actually serves — where a motif fails
    subprocess.run(
        ["magick", big, "-resize", "320x320", f"{OUT}/{name}-320.png"], check=True
    )
    print("authored", name, hue)
