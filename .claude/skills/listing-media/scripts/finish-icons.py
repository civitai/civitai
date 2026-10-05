#!/usr/bin/env python3
"""Land the graphite plate WITHOUT desaturating the mark.

Three measurements drove this, in order, and each killed the previous approach:

  1. mark hue/sat/brightness modulate  -> drove a hue gate green while visibly
     wrecking the mark (muddy brown, grey core, red fringing). Vacuous gate.
  2. global plate gain                 -> lands the plate (dE 4.5 -> 0.2) but the
     gain is <1, so it pulls the MARK down with it and the icon goes dull.
  3. measured the RAW candidates       -> generation already lands the mark hue at
     0.02-0.37 deg. The mark needs NOTHING. Only the plate drifts.

So: apply the gain ONLY to the plate, masked by saturation. The plate is the
low-saturation region and the mark is the high-saturation region, which is exactly
the discriminator the offsite grammar creates by putting a neutral behind a
saturated mark.

CONTROL: an on-target swatch must survive at dE ~0 (a fully-neutral image is all
plate, so it exercises the mask's plate branch), and a PURE MARK swatch must come
through UNCHANGED (exercises the mask's mark branch). One control only proves half
the mask.
"""
import subprocess, os, math, glob, colorsys

W = os.path.dirname(os.path.abspath(__file__))
PLATE = '#24262B'
HUES = {'radio': '#FF7A45', 'comfy': '#3ECFE0'}
OUT = f'{W}/final2'
os.makedirs(OUT, exist_ok=True)


def sh(c):
    return subprocess.run(c, capture_output=True, text=True).stdout


def srgb_to_lab(r, g, b):
    def f(c):
        c /= 255.0
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = f(r), f(g), f(b)
    x = (r*.4124 + g*.3576 + b*.1805) / .95047
    y = r*.2126 + g*.7152 + b*.0722
    z = (r*.0193 + g*.1192 + b*.9505) / 1.08883
    h = lambda t: t ** (1/3) if t > 0.008856 else (7.787 * t + 16/116)
    fx, fy, fz = h(x), h(y), h(z)
    return (116*fy - 16, 500*(fx - fy), 200*(fy - fz))


def hexrgb(s):
    s = s.lstrip('#')
    return tuple(int(s[i:i+2], 16) for i in (0, 2, 4))


def de(a, b):
    return math.dist(srgb_to_lab(*a), srgb_to_lab(*b))


def px(path, geom):
    o = sh(['magick', path] + geom + ['-resize', '1x1!', '-depth', '8', 'txt:-'])
    for line in o.splitlines():
        if line.startswith('0,0:'):
            seg = line[line.index('(') + 1:line.index(')')]
            return tuple(int(float(v)) for v in seg.split(',')[:3])
    return None


def corner_mean(p):
    acc = [px(p, ['-gravity', g, '-crop', '10%x10%+0+0', '+repage'])
           for g in ('NorthWest', 'NorthEast', 'SouthWest', 'SouthEast')]
    acc = [a for a in acc if a]
    return tuple(sum(c[i] for c in acc) / len(acc) for i in range(3))


def mark_rgb(p, tag='x'):
    mask = f'{W}/_mk-{tag}.png'
    sh(['magick', p, '-colorspace', 'HSL', '-channel', 'G', '-separate', '+channel',
        '-threshold', '55%', mask])
    o = sh(['magick', p, mask, '-alpha', 'off', '-compose', 'CopyOpacity',
            '-composite', '-resize', '1x1!', '-depth', '8', 'txt:-'])
    for line in o.splitlines():
        if line.startswith('0,0:'):
            seg = line[line.index('(') + 1:line.index(')')]
            return tuple(int(float(v)) for v in seg.split(',')[:3])
    return None


def hue(rgb):
    return colorsys.rgb_to_hls(*[c/255 for c in rgb])[0] * 360


def satof(rgb):
    return colorsys.rgb_to_hls(*[c/255 for c in rgb])[2]


def plate_only_correct(src, dst, tag):
    """Per-channel gain applied ONLY where saturation is low (the plate)."""
    cm = corner_mean(src)
    tgt = hexrgb(PLATE)
    g = [(tgt[i] + 0.5) / (cm[i] + 0.5) for i in range(3)]
    gained = f'{W}/_g-{tag}.png'
    subprocess.run(['magick', src,
                    '-channel', 'R', '-evaluate', 'multiply', f'{g[0]:.5f}',
                    '-channel', 'G', '-evaluate', 'multiply', f'{g[1]:.5f}',
                    '-channel', 'B', '-evaluate', 'multiply', f'{g[2]:.5f}',
                    '+channel', gained], check=True)
    # plate mask = LOW saturation, blurred so the mark's edge does not get a seam
    pmask = f'{W}/_pm-{tag}.png'
    subprocess.run(['magick', src, '-colorspace', 'HSL', '-channel', 'G', '-separate',
                    '+channel', '-threshold', '55%', '-negate',
                    '-blur', '0x2', pmask], check=True)
    subprocess.run(['magick', src, gained, pmask, '-compose', 'over', '-composite',
                    dst], check=True)
    return g


# ---- CONTROLS: both branches of the mask ------------------------------------
c1 = f'{W}/_c1.png'
subprocess.run(['magick', '-size', '256x256', f'xc:{PLATE}', c1], check=True)
plate_only_correct(c1, f'{W}/_c1o.png', 'c1')
d1 = de(corner_mean(f'{W}/_c1o.png'), hexrgb(PLATE))
print(f'CONTROL plate-branch : on-target neutral survives at dE {d1:.3f}')

c2 = f'{W}/_c2.png'
subprocess.run(['magick', '-size', '256x256', f'xc:{HUES["radio"]}', c2], check=True)
plate_only_correct(c2, f'{W}/_c2o.png', 'c2')
before = px(c2, ['-gravity', 'Center', '-crop', '50%x50%+0+0', '+repage'])
after = px(f'{W}/_c2o.png', ['-gravity', 'Center', '-crop', '50%x50%+0+0', '+repage'])
d2 = de(before, after)
print(f'CONTROL mark-branch  : pure mark colour passes through at dE {d2:.3f}')
if d1 > 1.0 or d2 > 2.0:
    print('  !! mask does not do what it claims -- ABORT'); raise SystemExit(1)

print()
print(f'{"cand":<9} {"plate dE":>8} {"mark hue":>9} {"mark sat":>9} {"size":>10} {"KB":>6}  gate')
for app, h in HUES.items():
    for cand in sorted(glob.glob(f'{W}/lit/{app}-*.jpg')):
        n = os.path.basename(cand).replace('.jpg', '')
        dst = f'{OUT}/icon-{n}.png'
        plate_only_correct(cand, dst, n)
        pd = de(corner_mean(dst), hexrgb(PLATE))
        mr = mark_rgb(dst, n)
        raw = mark_rgb(cand, n + 'r')
        dh = abs(((hue(mr) - hue(hexrgb(h)) + 180) % 360) - 180)
        wh = sh(['magick', 'identify', '-format', '%w %h', dst]).split()
        kb = os.path.getsize(dst) / 1024
        ar = int(wh[0]) / int(wh[1])
        keep = satof(mr) / satof(raw) if satof(raw) else 0
        ok = (pd <= 3.0 and dh <= 8.0 and kb <= 1024 and 0.9 <= ar <= 1.1
              and keep >= 0.95)
        print(f'{n:<9} {pd:8.2f} {dh:8.2f}d {satof(mr):9.3f} {wh[0]}x{wh[1]:<5} '
              f'{kb:6.0f}  {"PASS" if ok else "FAIL"}  (mark sat kept {keep*100:.1f}%)')
