#!/usr/bin/env python3
"""Titled-banner covers for the whole suite — supersedes the rev-5.1 analogy photos.

Operator decision 2026-08-17: move every app to a banner carrying its NAME and
TAGLINE over product imagery, because an untitled cinematic photograph is
anonymous in a marketplace grid.

Template is the comfy B-1 frame the operator picked: text block left (title on
ONE line, tagline beneath), product imagery right, dark ground carrying the
app's brand hue as accent glow.

🔴 The one-line title constraint was IGNORED in 2 of 4 renders on the comfy
round, so it is stated twice here and every render is reviewed. Titles here are
mostly shorter than "Comfy on Civitai", which is the case that wrapped.

Copy is the LIVE name + tagline from /api/v1/apps, except:
  radio  tagline is null on the API — "AI-generated radio, always on" is carried
         from its current live cover, and is NOT backed by an API field
  comfy  already shipped as B-1; not regenerated here
"""
import os
import subprocess
import sys

SP = os.path.dirname(os.path.abspath(__file__))
CLI = f"{SP}/civitai-main"
OUT = f"{SP}/banners"
os.makedirs(OUT, exist_ok=True)

# slug: (title, tagline, hue, right-hand product imagery)
APPS = {
    "custom-generators": (
        "Custom Generators", "Build the button. Share the button.", "violet",
        "a generator-builder panel: a form of labelled input fields and dropdowns on cards, "
        "and one large prominent primary action button glowing violet"),
    "model-benchmarking": (
        "Model Benchmarking", "Settle it with a grid.", "teal",
        "a comparison grid: a matrix of image thumbnails in labelled rows and columns, "
        "every cell showing THE SAME MOUNTAIN LANDSCAPE rendered in a different art style, "
        "no people anywhere, teal accent lines"),
    "playable-collections": (
        "Playable Collections", "Press play on a collection.", "coral pink",
        "a fanned stack of media cards with cover artwork, a large circular play button "
        "overlaid on the front card, coral pink glow"),
    "app-requests": (
        "App Requests", "Ask. Vote. Watch it get built.", "amber",
        "a vertical list of request cards, each with an upvote arrow and a count on the "
        "left, one card highlighted, warm amber accents"),
    "panorama-360": (
        "360 Panorama Studio", "Generate a world, not a picture.", "azure blue",
        # "strip" here was refused by content moderation — reworded, never retried
        "a wide panoramic landscape band curving and wrapping around into a sphere, "
        "a full 360 degree horizon, azure blue rim glow"),
    "sensei": (
        "Civitai Sensei", "Ask. It reads the catalog.", "green",
        "a chat conversation panel: stacked message bubbles, one question and one longer "
        "answer, a small model card referenced inside the answer, green accents"),
    "gen-matrix": (
        "Gen Matrix", "Every model. Every style. Side by side.", "magenta",
        "a dense matrix of small image tiles in even rows and columns, each tile a "
        "different style of the same subject, magenta accent lines"),
    "radio": (
        "AI Radio", "AI-generated radio, always on.", "warm orange",
        "a music player panel: a large album-art tile, a horizontal audio waveform "
        "running across the frame, transport controls, warm orange glow"),
}

NEG = ("misspelled text, garbled letters, gibberish text, duplicated text, extra words, "
       "two-line title, wrapped title, cropped text, text touching the edge, watermark, "
       "extra logos, people, faces, clutter")


def prompt(title, tagline, hue, scene):
    return (
        f'A premium app store banner on a deep near-black background with a subtle {hue} '
        f'gradient glow. On the LEFT, a text block with generous margin: the title '
        f'"{title}" on ONE SINGLE LINE in bold white sans-serif, and directly beneath it '
        f'the tagline "{tagline}" in a lighter grey weight. The title must fit on one '
        f'line and must not wrap. On the RIGHT, {scene}, with soft depth of field and a '
        f'{hue} accent glow. Crisp legible typography, dark editorial UI aesthetic, '
        f'generous margins, nothing cropped at the edges.'
    )


only = sys.argv[1:] or list(APPS)

for slug in only:
    title, tagline, hue, scene = APPS[slug]
    log = f"{SP}/gen-banner-{slug}.log"
    r = subprocess.run(
        [CLI, "generate", prompt(title, tagline, hue, scene),
         "--negative-prompt", NEG,
         "--ecosystem", "NanoBanana", "--checkpoint", "2725610",
         "--aspect-ratio", "16:9", "--quantity", "2", "--yes",
         "--out-dir", OUT, "--out-name", f"{slug}-{{n}}{{ext}}"],
        capture_output=True, text=True,
    )
    open(log, "w").write(r.stdout + r.stderr)
    charged = next((l for l in (r.stdout + r.stderr).splitlines() if "Charged" in l), "?")
    print(f"{'ok  ' if r.returncode == 0 else 'FAIL'} {slug:<22} {charged}")
