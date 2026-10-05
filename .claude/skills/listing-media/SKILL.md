---
name: listing-media
description: Author and generate Civitai App store listing MEDIA — icons, covers and titled banners — through the measured author→light→normalise pipeline, and attach them (including for offsite apps, which the CLI refuses). Use when the user asks to brand a new app, re-do or improve an app's icon / cover / banner, extend the brand system to more apps, judge listing-media quality, or asks why generated store art looks wrong. Screenshots of a RUNNING app are the sibling `app-capture` skill.
argument-hint: "[brand <slug> | icon <slug> | cover <slug> | attach <slug> | audit]"
allowed-tools: Bash, Read, Edit, Write, Glob, Grep
---

# listing-media — authoring store icons, covers and banners

**This skill owns AUTHORING. `app-capture` owns capture + attach.** The split:

| | this skill | `app-capture` |
|---|---|---|
| generate an icon / cover / banner | ✅ | ✗ |
| screenshot a running app | ✗ | ✅ |
| attach to a listing, bounds-gated | defer to it | ✅ `.claude/skills/app-capture/scripts/attach.sh` |
| attach for an **offsite** app | ✅ (the CLI refuses) | ✗ |

🔴 **Never hand-roll an attach.** `attach.sh` is dry-run by default, gates every
asset against `.claude/skills/app-capture/scripts/store-bounds.json`, and already
knows the shadow-revision and re-keyed-id traps. Two attach paths would drift.

## 🔴 Read first — four things that void the text below

1. **Bounds live in `store-bounds.json`, never here.** Aspect/size/px limits move.
2. **A hue table here is a snapshot.** Read the live values from
   `brand-assets-rev5-2026-08-13/scripts/emit-svg.py` (private infra repo).
3. **"Live" claims decay.** Every asset below was submitted, and a submission is
   not a listing — see *Nothing ships on push*.
4. **The cover grammar CHANGED on 2026-08-17** from untitled analogy photographs
   to titled banners. If you find an untitled cover, it predates that decision.

## The two icon grammars

|  | plate | mark |
|---|---|---|
| **onsite** apps | brand hue | light tint |
| **offsite** apps | **graphite `#24262B`** | brand hue |

🔴 **The onsite hue wheel is FULL and this is why the offsite grammar exists.**
Seven hues at ≥42° separation already consume 294° of 360°; nine needs 378° and
eleven needs 462°, and there are four offsite apps. Squeezing two into the widest
gaps caps minimum separation at 28.5° and hits the wall again at four. Putting a
neutral plate behind a hue mark makes hue **non-scarce** for that family instead.
Do not "simplify" the two grammars into one.

## The pipeline — author, light, normalise

Generation cannot meet the icon spec and authoring cannot do lighting. Each half
is used only for what it is good at:

| | authored flat | generated |
|---|---|---|
| meaning | **exact** | unreliable — 3 of 7 motifs wrong after two prompt rounds |
| colour | **impossible** — flat fills 0/20, exact hex 1/10, alpha 0/20 | **exact** after normalisation |

1. **Author** the mark flat — `.claude/skills/listing-media/scripts/author-marks.py`. Zero Buzz. Exact geometry,
   exact hex. This is where motifs are chosen and rejected.
2. **Light** it with img2img, which preserves composition:
   `--ecosystem NanoBanana --checkpoint 2725610 --image <authored.png> --aspect-ratio 1:1`
   (covers `16:9`). ~208 Buzz at `--quantity 2`.
3. **Normalise** the plate — `.claude/skills/listing-media/scripts/finish-icons.py`. Applies a per-channel gain
   ONLY where saturation is low, so the plate lands without dulling the mark.

🔴 **`finish-icons.py` runs BOTH mask controls and aborts if either fails** — an
on-target neutral must survive (plate branch) and a pure mark colour must pass
through unchanged (mark branch). One control proves half a mask. Measured 2026-08-16:
both dE 0.000, which is what makes the per-candidate numbers readings.

**Gate**: plate dE ≤3.0, mark hue ≤8°, mark saturation kept ≥95%, aspect 0.9–1.1.

🔴 **Always `--quantity 2` and read BOTH.** Composition drift is the known img2img
failure and it is not rare: one comfy candidate invented a backing panel and turned
round sockets into squares, scoring 12.45° hue / 232.7% saturation while its sibling
passed. The gate caught it independently of the eye. One render is a coin flip.

## Motifs — judge at 320px, by what a stranger says it depicts

Authoring is free, so draw every candidate and rule on it BEFORE any Buzz moves.
Judge at **320 px**, the size the store serves an icon at, not at 1024.

🔴 **Escaping one wrong prior does not mean you landed on the right one.** The
catalogue of priors that have actually bitten, all of them plausible on paper:

| motif | what it actually read as |
|---|---|
| dial with ticks OUTSIDE the ring | a **sun** (the "outward triangles + warm dot" prior) |
| the same dial with ticks INSIDE | a **clock** — the fix created a new wrong prior |
| ON AIR sign without text | a card, or a text input |
| a restyle of the placeholder's own motif | the placeholder |

**Generation is good at real-world objects and bad at abstract constructions** —
"a disc with a wedge cut out" came back a cone twice. That is the test for whether
a motif is promptable at all; an authored mark has no such limit.

## Covers — titled banners (current grammar)

Left: title on ONE line, tagline beneath. Right: product imagery. Dark ground with
the app's brand hue as a gradient glow. The literal prompt template and every
per-app scene string: `.claude/skills/listing-media/reference/prompt-library.md`.

Copy comes from the LIVE `/api/v1/apps` name + tagline. 🔴 **Check both before
writing them into a prompt** — one app's tagline is `null`, another's stored name
is a name and a descriptor jammed together, and a third contains a `°` that
generation mangles.

### 🔴 The failure class is text VOLUME, not text

NanoBanana renders a headline reliably and a field of small labels not at all.
Measured across one suite:

| scene shape | outcome |
|---|---|
| no text in the scene | clean every time |
| a few row/column labels | mostly right, some labels wrong |
| paragraph replies | coherent on 1 of 3 — luck |
| a list of titled cards | gibberish on 4 of 4, across two rounds |

**The fix is to remove text from the scene, not to prompt harder.** The list case
only worked once its cards carried nothing but an icon and a number. Blurring the
labels is a half-measure: it softens the descriptions and leaves the titles sharp
and wrong.

### 🔴 A negative prompt does not suppress what the scene IMPLIES

`people, faces` was negative on every render and a style-matrix still came back as
nothing but stylised female portraits. What works is naming the subject
**positively** — "every cell showing THE SAME MOUNTAIN LANDSCAPE", "the SAME single
object — a classic sports car". Same lesson as motifs: state what you want rather
than enumerating what you don't. This matters beyond taste: a suite of store art
that defaults to female portraits is a content-rating problem nobody asked for.

### 🔴 The model renders third-party logos unprompted

A prompt saying only "chat conversation panel" put the **ChatGPT sunburst** on the
assistant avatar in both renders — a competitor's trademark, on a Civitai listing.
Another render invented a card titled "Google requests". **Any AI-assistant or
browser UI scene will reach for a competitor's mark.** Specify the avatar/chrome
positively and negative-prompt the logos.

### 🔴 A moderation refusal must be EDITED, never retried

The word "strip" (in "equirectangular landscape strip") was refused. The CLI says
so explicitly: *do NOT retry this prompt: repeated blocked attempts get the account
muted.* Reword. A refusal is not charged.

## Attaching

**Onsite** — `civitai app listing set-icon|set-cover <file> --slug $SLUG --changelog "…" -y`,
or `attach.sh` for the bounds-gated, dry-run-first path. Icon + cover in ONE
session land on ONE revision, so one moderator review instead of two.

**Offsite** — 🔴 **the CLI refuses (`exit 4`) and its message overstates the case.**
It says media *"is only possible in the App-store listing UI"*. Not true: the CLI
resolves listings through a block submission and an offsite app has none, but the
**listing id is published on the public `/api/v1/apps` route** and every listing
proc accepts it. `.claude/skills/listing-media/scripts/probe-listing.py` reads a listing by id; the flow is
ingest → `setCover`/`setIcon` **against the shadow, never the parent** → submit.
Worked first time on both offsite apps. Related: `civitai/cli#422`.

🔴 **`submitListingRevision` is idempotent.** Setting a new asset on a shadow that
was already submitted REPLACES the staged asset and returns the EXISTING request
id — it does not open a second review. Verify by reading the shadow back.

### 🔴 Nothing ships on push, and a submission is not a listing

App Blocks deploy on moderator approval. `status` reports the SHADOW; the public
route reports the LIVE listing; they disagree for as long as review takes, and a
revision can resolve without ever applying. **Read the public route, not `status`,
before claiming anything is live** — and compare the asset's own uuid, because a
re-ingest of the same picture gets a new id while looking identical.

## Cost, measured

| step | Buzz |
|---|---|
| authoring a motif, any number of candidates | **0** |
| icon lighting pass, `--quantity 2` | 208 |
| a banner or analogy cover, `--quantity 2` | 208 |
| a plain txt2img cover | 16 |

Budget rounds, not renders: one suite of nine banners took 3,360 Buzz including
three rounds on the hardest app and one re-roll for content.

## Prior art — read before re-deriving

🔴 **The identities, palettes and motifs are SPECIFIED, not invented per session.**
Before authoring anything for an existing app, read the spec — every other doc
below descends from it.

🔴 **Every doc named in this section lives in the PRIVATE infra repo, not here.**
They are named by filename so someone with access can find them; there is
deliberately no path, because this repo is public. If you cannot reach them, ask
an infra owner rather than re-deriving the brand system from scratch.

- **`first-party-app-micro-brands-2026-08-04.md` — the spec.** Per-app
  identity, palette and motif. Source of truth; start here.

The arc, in order. Each supersedes the previous on the axis it names, and none of
them is retracted — a later doc changing the grammar does not make the earlier
measurements wrong:

| doc | what it settles |
|---|---|
| `brand-asset-quality-review-2026-08-07.md` | 20 generated marks judged against the spec — why generation alone was abandoned |
| `brand-assets-svg-2026-08-09/README.md` | the icons drawn rather than generated |
| `brand-assets-final-covers-2026-08-11/RESULTS.md` | the luminance-transfer route: NanoBanana's light, the authored SVG's colour |
| `brand-assets-rev5-2026-08-13/RESULTS.md` | the 7-app system, the hue wheel, and this pipeline's origin |
| `brand-assets-offsite-2026-08-16/RESULTS.md` | the graphite grammar — and the sampling trap paid for twice, in opposite directions |
| `brand-banners-2026-08-17/RESULTS.md` | the switch to titled banners, and every defect that shipped |

- `.claude/skills/listing-media/reference/prompt-library.md` — the literal prompt strings
- `app-blocks-first-party-media/CHECKLIST.md` — the 2026-07-26 manual-upload
  staging run. 🔴 **Its premise is now false**: it says there is "no authoring-side
  media path" and that media is web-upload-only. `civitai app listing set-icon` /
  `set-cover` have existed since `civitai/cli#186`, and offsite apps are reachable
  through the procs. Read it as history, not instruction.
