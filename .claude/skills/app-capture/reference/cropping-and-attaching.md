# Cropping, store bounds and attach semantics

Detail demoted out of `.claude/skills/app-capture/SKILL.md`. Every rule here is a
refusal in `.claude/skills/app-capture/scripts/frame.py` or `.claude/skills/app-capture/scripts/attach.sh`,
not advice — the skill body keeps the one-line summary, this file keeps the why.

## 🔴 Cropping — the failure that shipped twice

Content bounds come from differencing against the flat page background. Three
regions must be excluded first, or the detector silently returns the whole frame
and the crop becomes a no-op that still prints plausible numbers:

| region | why | if left in |
|---|---|---|
| top chrome (header/nav/breadcrumb) | not app content | box starts at y=0 |
| **footer** (`© Civitai … Terms of Service …`) | spans full width | box pinned to full **width** |
| **right-edge furniture** (scrollbar / support button) | spans full height | box pinned to full **height** |

Two independent detectors, both in `.claude/skills/app-capture/scripts/frame.py`:

- **full-frame refusal** — a box filling ≥97% of the usable band on **either**
  axis. `OR`, not `AND`: measured on the fixtures, dropping the right-edge band
  gives **78.7% wide × 100.0% tall**, which an `AND` rule does not catch.
  (Dropping the footer gives 100.0% × 98.2% and dropping everything gives
  100.0% × 99.4% — both still fire under `AND`, which is how an `AND` rule looks
  correct on two of the three broken shapes.)
- **identical boxes across states** — the cheapest real check available.
  Different screens cannot have identical content extents; when the cropper is
  broken every state reports the same box. Every pair is compared, not just the
  first.

Measured band values for a 1709×1314 capture are `chromeTop 182 / footer 110 /
right 70`, pinned as data in `.claude/skills/app-capture/tests/fixtures/manifest.json` — **not**
as universal constants.

🔴 **Both detectors have already earned their keep on live runs.** The first run
of the custom-generators recipe reported `explainer` and `discover` with the same
box — the Discover *tab* is already active on load, so clicking it is a no-op and
the state was a duplicate; the recipe has to **dismiss the explainer panel**
instead. The second run reported `generator` and `mine` the same — states were
running back-to-back in one tab, so `mine` clicked `#tab-mine` while the app was
still inside the legoify generator. Hence **`capture.sh` reloads the app before
every state**: a recipe's actions are written against the app's *initial* screen.

### The full-bleed escape hatch

Content-detection assumes the app is an island inside page furniture. A
full-bleed app (sensei: sidebar + chat, edge to edge) defeats it — the box fills
the band and `full_frame` refuses at every band setting, correctly. So the crop
can be **declared** via `crop.rect`. Declaring bypasses **detection only**: the
rect is still checked for lying inside the frame, for a 128 px floor per axis,
and for not being the whole frame. The identical-box check is inert for a
declared rect (it says so in its own output), so verify such a crop by eye.

### 🔴 Three crop forms, and picking the wrong one refuses

| form | recipe | for |
|---|---|---|
| **detect** | bands + `fromAppFrame: true` | a centred-column app that is an island in page furniture — most recipes |
| **absolute rect** | `crop.rect`, **no** `fromAppFrame` | a full-bleed app on a page with **no** conditional banner — **no shipped recipe**, see below |
| **frame-relative rect** | `crop.rect` with `"yFrom": "appFrame"` **and** `fromAppFrame: true` | a scrolling, content-dense app on an `apps/run/<slug>` page |

The frame-relative form also has a **horizontal** half — `"xFrom": "appFrame"` and
`"wFrom": "appFrameRight"` — which is what makes a rect survive a re-tiled window.
It is a variant of the third form, not a fourth one (the same `fromAppFrame` seam,
the same probe), and **no shipped recipe uses it yet**: see "The HORIZONTAL frame
anchor" below for the form, its refusals, and the conversion procedure.

(Counts deliberately omitted — the asserted ledger is gate **P18**, which reads
the recipes directory itself. A number written here would rot the moment an
eighth recipe lands, beside a ledger that cannot.)

They are mutually exclusive **by refusal**, not by convention, and the two seam
directions each have their own sentence (`crop_rect_invalid`). `frame.py`'s own
`full_frame` message names all of this, because the version that named only the
absolute form spent a month sending people into a second refusal
(talos-infra #1297).

🔴 **THE `absolute` FORM NOW HAS NO SHIPPED RECIPE, and how that happened is the
lesson.** `sensei.json` was the one, on the strength of its own note: *"`y: 97` is
BELOW the iframe's top on purpose, because it also clips the app's OWN
partially-visible buzz bar"*. **Measured 2026-08-27** on sensei's own page, booted
through its ready gate — probe answer `APPFRAME_RECT:141,64,-1,1709,1255`, matched
to its capture so the scale guard validated the pair:

| rows | what is actually there |
|---|---|
| 68–104 | the **rewards banner** |
| 105–138 | the **host breadcrumb bar** |
| 141 → | the app iframe |
| 141–203 | the app's own header — with its **buzz chip at 161–181** |
| 204 | the app header's divider |

So `y: 97` was **44 px above** the iframe, *inside the banner*: the shipped crop's
top rows were host page chrome, and it clipped nothing of the app's own. The note
was backwards. 🔴 **But its INTENT was right and only its number was wrong** — the
buzz chip is real and must not be photographed; the crop simply has to start at
**205**, below the app header's divider. That is **64 px BELOW** the iframe top, a
non-negative offset — so the anchored form was available all along, and since
sensei sits on the same `apps/run/<slug>` shell as everything else, it is
*required*: an absolute rect there is wrong in one banner layout by construction.

**sensei was never a legitimate absolute-form case. It was an unfixed instance of
the defect #1316 fixed for the other two apps**, preserved by a note that
rationalised the number instead of measuring it.

⚠ **Stated, not hidden: this costs coverage — and the two halves are NOT the same
loss.** P18's `absolute` arm is **structurally dead**: no `FORMS` value is
`"absolute"`, so the branch can never execute and a mutation to it is unkillable
by construction, not merely unpinned. `frame.py`'s absolute-rect **path** is fine
— gate C and F10d still drive it with hand-built rects. The form stays supported — a genuinely
full-bleed app on a page with no conditional banner would still want it — but
nothing shipped will catch it rotting.

The third form exists because the first two could not both be had. `app-requests`
(46.9% × **98.3%**) and `playable-collections` (63.9% × **100.0%**) are scrolling
lists whose content *legitimately* runs to the bottom of the viewport, so
detection refuses and no band setting can change that — but they sit on the
banner page, so an **absolute** rect is wrong by ~36 px in one of the two
layouts by construction. `"yFrom": "appFrame"` measures `y` **down from the app
iframe's top edge**, the one edge the banner moves.

- **Only `y` is anchored — and here is exactly how far that is measured.** What a
  real pair of captures established is the **top-edge shift**: 194 → 230 when the
  banner appears. The companion claim that `x`, `w` and `h` are unchanged is
  asserted against the banner state cut by `bannershift.py`, which builds the
  second layout by inserting a strip and translating every row below it — so
  x/w/h identity **there** is true by construction, not evidence. Gate F13's
  pixel arm therefore grades the resolution *arithmetic*, which it does hard
  (sign flips, wrong-axis application, `max()`-instead-of-`+` and off-by-ones all
  die on it), not the physical claim.
- 🔴 **The limit that follows from that.** The banner also **shortens the iframe**
  by ~36 px, because the viewport height is fixed. An app whose internal layout
  responds to its frame's *height* — vertical centring, a `100%`-height pane, a
  virtualised list — can move in ways this anchor does not model, and no fixture
  here would show it. `app-requests` and `playable-collections` are plain
  top-aligned scrolling lists. Check that before adding another.

  🔴 **sensei IS such an app, and it was adopted on 2026-08-27 without that check
  being run — by the author of this bullet.** Its layout is header / flex-1 main /
  **bottom-anchored** control bar (full-width divider at abs 1133, model + temp +
  max-tokens at 1157–1166), so its bottom furniture tracks the iframe's *lower*
  edge. The banner shortens the iframe from the top with the viewport fixed, so in
  the banner-**absent** layout the iframe is ~36 px taller and a top-anchored,
  fixed-`h` rect ends ~36 px short. 🔴 **Not "clipping" the control bar — DROPPING
  it entirely**: the crop resolves to abs 168…1150 while the bar sits at
  1157–1166, wholly outside. (What gets *clipped* in that layout is the support
  widget at 1149–1189, which also means the keep-the-widget trade below does not
  apply there at all.) 🔴 **Silently**: the iframe-bottom bound does not fire, because
  ending EARLY is not running past the edge.

  So for a height-responsive app the anchored form fixes the **top** edge in both
  layouts and the bottom edge in **one**. That is still strictly better than the
  absolute rect it replaced, which was wrong at *both* edges in the other layout —
  but "one rect is right in both banner layouts" is a claim about top-aligned apps
  and must not be repeated for this one. **Closing condition:** shoot sensei with
  the banner absent and re-measure; if the control bar is clipped, drop it from the
  shot or give the form a bottom anchor. Not attempted — no banner-absent capture
  exists, and `bannershift.py` cannot stand in for one: it builds the banner state
  by *dropping the rows that fall off the bottom*, which slides a bottom-anchored
  element away — the inverse of what really happens.
- 🔴 **`y` cannot be negative**, so a crop that must start *above* the iframe's
  top edge cannot use this form at all. (sensei was believed to be such a case for
  twelve days; it was not — see above. Measure before concluding it.)
- **The iframe's *bottom* edge bounds the rect too.** The probe reports it, so a
  rect anchored to the top cannot run past the app and photograph the page
  furniture below it. A negative bottom gap (an iframe taller than the viewport)
  loses to the frame edge rather than tightening it.
- **Every gate runs on the RESOLVED `y`.** The frame check, the 128 px floor and
  the no-op check all describe the region that will actually be cropped — so the
  same JSON can be accepted in one layout and refused off the bottom in the
  other, which is the honest answer rather than a short image.
- **The key set is checked.** A misspelt `yFrom` would otherwise be ignored,
  leaving an absolute rect that measures plausibly and crops the wrong region in
  one layout. Unknown keys refuse; `_`-prefixed comment keys do not.
- **The resolution is reported** (`resolved` in the `measure` output: the
  declared `y`, the iframe top it was added to). `box.y` is the one number a
  declared rect does not state, so without it you cannot tell a working anchor
  from a rect that landed plausibly.
- **What it costs is unchanged**: the identical-box check is inert for any
  declared rect. `.claude/skills/app-capture/tests/run-tests-app-capture.sh` gate **F13** substitutes for it
  by cropping *both* layouts and comparing the pixels, with the absolute form as
  the negative control — but that is a check on the mechanism, not on your rect.
  **Verify a new rect by eye.**
- **A declared rect is a MEASUREMENT, and gate P18 requires TWO records of it.**
  It is viewport- and content-specific, so a frame-relative recipe must carry
  **both**, and P18 refuses one that carries either alone:
  - `crop._measured` — prose: what was measured, on what capture, when. It must
    state the geometry in the parseable form **`viewport WxH`**, **`app-frame
    top=N`**, **`bottom gap=N`**.
  - `crop._measuredGeometry` — the same three numbers as data:
    `{ "viewport": [w, h], "appFrameTop": N, "appFrameBottomGap": N }`.

  They are cross-checked against each other, and P18 additionally refuses a
  recipe that records the *fixture's own dimensions* as its live viewport. Both
  exist because **every** 1709-wide fixture in the corpus is 1314 rows — 59
  **taller** than the live capture these rects were chosen on — so measuring
  against a fixture alone passes a rect that overruns the real iframe.

  🔴 **Read that at its real width: this is a DRIFT check, not a boundary.** No
  static gate can verify an author-supplied measurement — both records are the
  same author's numbers in one file, and nothing can check provenance. Three
  audit rounds walked it in turn (grow the rect; grow the rect and the record;
  grow the rect, the record and the prose), each time by making the records agree
  with one another. Adding a fourth witness moves the price to four edits and
  closes nothing. What this catches is a recipe whose rect and record have
  drifted **apart** — a stale re-shoot, a transposed digit, a rect edited without
  its record — before you burn a live run on it.

  🔴 **The actual safety property is on the LIVE path**, in `frame.py`'s
  `declared_box`, and it is structural because it bounds the rect by the edge
  *the probe reported*, not by any number a recipe wrote down. ⚠ **The
  iframe-bottom bound exists only for the frame-relative form** — an *absolute*
  rect has no probe answer to bound against and is checked against the PNG alone.
  🔴 **And the static drift check does not cover that case either**: `_measured` /
  `_measuredGeometry` are required and checked *inside* P18's `appFrame` arm only.
  (No shipped recipe is in that position any more; sensei carries both keys since
  2026-08-27.) Do not generalise "the live path catches
  it" past the anchored form, and do not assume the static check picks up the
  slack. ✅ **The one live check that DOES cover both forms is the viewport of
  record below** — added 2026-09-02, after the absolute half of a rect shipped a
  wrong asset with exit 0. Measured
  2026-08-26: a fully-walked recipe — `h: 560`, recorded viewport `1709x1300`,
  prose to match, green through every static check — run against the real
  `1709x1255` capture and its real probe answer gives `REFUSE[crop_rect_outside]`
  naming the iframe's lower edge at 1191. **The walk does not ship a bad crop; it
  ships a recipe that fails on its next live run.**

  ⚠ Two costs, stated rather than discovered: `_measured` must state each of the
  three numbers **exactly once** (only the first match is read, so an *appended*
  re-shoot would be silently ignored in favour of the stale block — put a
  re-measurement in place of the old one, not after it); and a run that genuinely
  reports the fixture's dimensions is refused — note that *adding* a fixture at
  that size does not lift it, since the comparison is against
  `5-mb-combinations.png` specifically. Live with the refusal, or re-shoot that
  fixture *to a different size* — re-shooting it from the same browser reproduces
  the same dimensions and the refusal with them. Do not edit the record to escape
  it.

### 🔴 The VIEWPORT OF RECORD — the one live check that covers x and w

**Added 2026-09-02, after a run produced a badly wrong asset and exited 0.**
sensei's rect (`x:0 y:64 w:1694 h:982`) was measured at a **1709x1255** viewport.
The operator's browser window had since become ~3008 CSS px wide at
`devicePixelRatio 1.140625`, so the capture came back **3431x1286** and the crop
photographed the **left half**, shoving the app into a corner of the canvas.

🔴 **Why nothing fired, and it is the reusable lesson.** `frame.py` already had
`app_frame_scale` — but that compares the **page's own viewport reading with the
PNG the bridge wrote**, both from the *same* run, so they agree in *any* window
(3431 vs 3431, pass). It is an **internal-consistency** check that reads like a
correctness one. Nothing compared the live capture with the viewport the rect was
**measured at**, even though every declared-rect recipe already recorded it — and
`_measuredGeometry` was read only by the *test-time* gate P18, against the rect,
never against reality.

🔴 **And the asymmetry that makes `x`/`w` the dangerous half.** A frame-relative
rect's `y` is anchored to the live iframe edge and its `h` is bounded by the live
lower edge, so the *vertical* axis has live witnesses. `x` and `w` have **none**:
their only bound has ever been `x + w > pngWidth`, and a **wider** window makes
that **looser**, not tighter. A rect that is correct at 1709 sails through every
check at 3431.

**The gate.** When a crop declares a `rect`, `frame.py` refuses unless the capture
matches `crop._measuredGeometry.viewport` on **both axes** within **2 px**:

| refusal | meaning | fix | `capture.sh` exit |
|---|---|---|---|
| `viewport_of_record` | the window is not the one the rect was measured in | resize the window back, or re-measure the rect **and** the record together | **14** |
| `viewport_unrecorded` | a declared rect with no (or a malformed) record | add `crop._measuredGeometry.viewport`, or pass `--measured-viewport WxH` with `--crop-rect` | 5 |
| `viewport_record_conflict` | a recipe record **and** a `--measured-viewport`, or the flag on a run that detects | drop one of them | 5 |

- 🔴 **It covers BOTH crop forms**, absolute and frame-relative, because its
  operand is the capture rather than the probe. It is the only live check that
  does.
- 🔴 **An absent record REFUSES; it never means "skip the check".** Every shipped
  declared-rect recipe already carries one, so the requirement costs nothing today
  and makes the omission loud on the next recipe that forgets. Gate **C8** is the
  asserted ledger (it reads the recipes directory, so no count is written here);
  **C6** is the refusal.
- **Tolerance: 2 px, both axes, both directions** (watched at ±2 and ±3 by C5).
  Both numbers are device pixels from `Math.round(innerWidth * dpr)` on a float,
  so a fractional DPR can round a pixel either side. The smallest *real*
  difference this repo has ever measured is **59 px** (the fixture corpus is
  1709x1314, one browser-toolbar row taller than the 1709x1255 live captures);
  the incident's width delta was **1722 px**. 2 px separates rounding from the
  smallest real difference by ~30x.
- ⚠️ **`14` is not a defect report.** The rect is fine and the *window* is wrong.
  **Never edit `_measuredGeometry` alone to clear it** — that is the walk P18's
  drift check exists to make visible, done on the live path instead.
- ⚠️ **It bounds the CANVAS, not the CONTENT.** A rect applied at the viewport it
  records can still be framed badly if the app's own layout changed — that is what
  `_measured`'s "verify by eye" clause is for, and this gate does not replace it.
- **Viewport PINNING was evaluated and NOT shipped** — see the note at the end of
  this file.

### 🔴 The HORIZONTAL frame anchor — `xFrom` / `wFrom` (2026-09-02)

**The problem the viewport of record only converted into a refusal.** The
operator tiles their i3 workspace and Brave resizes with it: three capture
viewports in one session — **1709x1255**, **3431x1286**, **1135x1314**. So an
absolute `x`/`w` is correct until the next re-tile, and `viewport_of_record`
(correctly) refuses every declared-rect capture until the old window is
reproduced. That is right and must stay; it is also not workable as the only
answer.

🔴 **AND IT NEEDED A PROBE CHANGE, WHICH IS THE FIRST THING TO KNOW.** Until this
the probe answered **five** numbers and the third is a **RIGHT gap**
(`Math.floor((innerWidth - r.right) * dpr)` — read it in `app_frame_rect_js`,
`.claude/skills/app-capture/scripts/frame.py`). So the frame's **right** edge was
always derivable as `vw - rightGap`, and simply never used — but its **left edge
and its width were not derivable from anything**. The probe now appends a
**sixth** number, the frame's left inset, rounded with `Math.ceil` like the top
gap (it is a NEAR edge — an anchor a coordinate is added to — so rounding it
outwards would put the crop's first column in the host page):

```
APPFRAME_RECT:top,bottomGap,rightGap,viewportW,viewportH,leftInset
```

⚠ **Appended, never inserted**, so every five-field consumer keeps its indices;
`parse_app_frame_rect` accepts **5 or 6** and reports the missing left inset as
`None` rather than as a plausible `0` — `left = 0` is a *real* reading (a
full-bleed iframe) and conflating the two is the silent fallback this whole form
exists to remove.

| marker | meaning | note |
|---|---|---|
| `"xFrom": "appFrame"` | `x` is measured RIGHT from the frame's **left** edge | mirror of `yFrom` |
| `"wFrom": "appFrameRight"` | `w` is **re-read as a GAP** from the frame's **right** edge | the pair `(x, w)` becomes `(left inset, right inset)` |

🔴 **The two marker VALUES are deliberately different tokens.** `yFrom`/`xFrom`
both anchor a *coordinate* to the frame's near edge, so they share `"appFrame"`.
`wFrom` changes what the number *means* — from a length to a gap — and a shared
token is exactly how someone copies `"appFrame"` across and gets a plausible
wrong box. `"wFrom": "appFrame"` therefore **refuses**, naming the difference.

🔴 **Only the FULL pair is viewport-independent by construction, and the
difference matters:**

- `xFrom` **alone** tracks a frame that *moves* at constant width — a max-width
  container centred in a wider window. It does **nothing** for a full-bleed
  iframe, where the left edge is `0` at every viewport. Every live probe answer
  preserved in this repo's corpus reads `rightGap = -1` at a 1709 px viewport,
  i.e. **full-bleed**, so on those captures `xFrom` alone is a no-op. It also
  stays bound by `viewport_of_record`, because its `w` is still absolute.
- `xFrom` **+** `wFrom` carries no absolute horizontal coordinate at all: both
  edges are gaps from the frame's own edges. This is the form the gate below is
  re-based for.
- **`wFrom` REQUIRES `xFrom`** — a far-edge width against an absolute left edge is
  the half-specified shape: the width would silently absorb every pixel the frame
  moved, hiding the drift inside the one number that looks like it removed it.

**The refusals.** Every one of them is a way this form could quietly degrade back
to the absolute rect it replaces, so none of them falls back:

| refusal | when |
|---|---|
| `crop_rect_invalid` | `wFrom` without `xFrom`; `wFrom: "appFrame"`; an unsupported `xFrom` value; a misspelt marker key; a rect whose **resolved** width is ≤ 0 (a leftover *width* left in `w`) or under the 128 px floor |
| `crop_rect_invalid` (seam) | any marker in a recipe that does **not** set `fromAppFrame` — nothing would run the probe |
| `app_frame_left_missing` | `xFrom` against a **five-field** probe answer. That means a stale or foreign probe, not a page state |
| `crop_rect_outside` | a **negative** left inset (a horizontally scrolled page); or a resolved box running past the **iframe's own right edge** |
| `frame_width_unrecorded` | a fully anchored rect whose recipe records no `crop._measuredGeometry.appFrameW` |
| `frame_of_record` | the live app frame is not the width the rect was measured against — **`capture.sh` exit 14**, same as `viewport_of_record` |

🔴 **The iframe's RIGHT edge bounds an x-anchored rect**, the twin of the
iframe-bottom bound on the vertical axis, and it is the one that reproduces the
incident's own shape: a rect can fit the PNG comfortably (`2452 <= 2509`) and
still run out of the app into the host page. A **negative** right gap (an iframe
wider than the viewport) loses to the PNG edge rather than widening the bound
past the photograph.

#### 🔴 Is a fully anchored rect exempt from the viewport of record? — NO. It is RE-BASED

The tempting answer is yes: if the rect no longer depends on the viewport, the
record is meaningless for it. That is **half** true, and shipping the whole of it
would leave the horizontal axis with *nothing* checking it — which is the hole
`viewport_of_record` was written to close, re-opened for the one form that looks
safest. What actually threatens a fully anchored rect is the app **reflowing** —
a grid going three columns to four — and the observable for that is the **app
frame's own width**, which the probe now reports. So:

- **width axis** → graded against `crop._measuredGeometry.appFrameW`
  (`frame_of_record`, 2 px tolerance, exit **14**). The window may be any width.
- **height axis** → **unchanged**, still the recorded viewport height
  (`viewport_of_record`). There is no `hFrom`: `h` is absolute in every form, and
  the live iframe bound is **one-sided** — ending EARLY is not running past an
  edge, which is sensei's documented open limit. A taller window still crops
  short, silently, and only this catches it.

⚠ **What neither half buys**, stated so this is not read as more than it is: both
are RECORD-vs-LIVE comparisons against a number the recipe's own author wrote
down — nothing here verifies provenance — and a rect applied at the recorded
frame width can still be a badly framed picture. The identical-box check stays
inert for any declared rect. **Verify by eye.**

#### Converting a recipe to the horizontal anchor

**No shipped recipe uses this form**: re-expressing a rect needs a live
measurement against a running app, and the session that added the form had no
browser. The existing rects stay absolute in `x`/`w` and stay covered by
`viewport_of_record`. This is the procedure, and it needs **one live capture plus
one re-tile**:

1. **Shoot the app once**, at whatever window size you have.
   ```bash
   SK=.claude/skills/app-capture/scripts
   $SK/capture.sh $SK/recipes/sensei.json --out /tmp/conv
   ```
   🔴 **An exit 14 here is fine and is not a blocker.** `capture.sh` writes
   `<state>.png` and `<state>.rect.json` *before* it measures, so a run that
   refuses on the viewport of record still leaves you both artefacts.
2. **Read the probe answer** out of `/tmp/conv/<state>.rect.json` —
   `APPFRAME_RECT:top,bottomGap,rightGap,vw,vh,left`. Derive, once:
   `frameLeft = left`, `frameRight = vw - rightGap`, `frameW = vw - left - rightGap`.
   🔴 **If it has only five numbers you are running a stale copy of `frame.py`** —
   the six-field probe and the marker landed in the same commit.
3. **Pick the crop by eye** on `<state>.png`, as absolute columns `X0…X1`. This is
   the step nothing can do for you; a declared rect makes the identical-box check
   inert and narrows `full_frame` to an AND on both axes.
4. **Convert to insets**: `x = X0 - frameLeft`, `w = frameRight - X1`. Both must
   be ≥ 0; if either is negative your crop is outside the app frame.
5. **Edit the recipe** — add `"xFrom": "appFrame"` and `"wFrom": "appFrameRight"`
   to `crop.rect`, replace `x`/`w` with the two insets, leave `y`/`h`/`yFrom`
   alone, and add `"appFrameW": <frameW>` to `crop._measuredGeometry` beside the
   `viewport` it already records. Restate the measurement in `crop._measured`
   **in place of** the old block, never appended — gate P18 reads only the first
   match of each pattern.
6. **Re-run.** It must exit 0, and the `measure` output's `resolved` block must
   report `appFrameLeft` / `appFrameRight` / `resolvedW` matching your arithmetic
   from step 4. Until here you have only checked addition.
7. 🔴 **Re-tile the window and run it again.** This is the only step that proves
   the anchor: a *different* viewport, the *same* recipe, exit 0, and a framed
   asset that looks the same. If the app frame's own width changed, expect exit
   14 (`frame_of_record`) — that is the gate working, and it means the app is
   full-bleed rather than max-width, so this form cannot help it.
8. **Verify the asset by eye**, both times.
9. 🔴 **Teach gate P18 in the SAME edit.** Its ledger arm is currently a
   **tripwire, not an implementation**: it refuses any shipped recipe carrying
   `xFrom`/`wFrom` and says why. It has to, because it would otherwise be wrong
   twice — its overrun test computes `x + w` (meaningless when `w` is a gap) and
   the probe answer it synthesises has five numbers, no left inset, so `frame.py`
   would refuse the run and the failure would read as a bad rect. The real
   arithmetic was deliberately not written blind: this arm reads the shipped
   recipes directory, so with no recipe in that form there would have been
   nothing to exercise it, and an unexercised branch that reads like coverage is
   worse than an honest stop. Mutant **M207** pins the tripwire.

Gate **G21** is the end-to-end half: the six-field probe flowing through
`capture.sh`, **exit 14** on a wrong app frame (the same code as
`viewport_of_record` — same operator action), and **exit 5** with
`app_frame_left_missing` on a stale five-field probe answer. It exists because
the `frame_of_record` half of `capture.sh`'s exit-14 branch is a **spelled**
token: misspell it and a static read of the file still shows `exit 14` present
and gate D8 still passes. Mutants **M193**/**M208** pin the two tokens.

Gate **F14** is the mechanism check: one rect, one record, two window widths
(1709 and 2509), byte-identical crops, with the absolute form as the negative
control. Its second window is cut from a real capture by
`.claude/skills/app-capture/tests/fixtures/framewiden.py`. ⚠ **That fixture builds the wider
window by TRANSLATING the frame's pixels**, so "the app does not move relative to
its frame" is true *there* by construction and is not evidence about any real
app — exactly the caveat `bannershift.py` carries on the vertical axis. F14
grades the resolution **arithmetic**; step 7 above is what grades the physics.

### 🔴 `crop.fromAppFrame` — why a FIXED `chromeTop` is not merely imprecise

`civitai.com/apps/run/<slug>` stacks four full-width strips above the app iframe:
the 60 px site header, the sticky SubNav, a 12 px margin, and the App Blocks
breadcrumb bar (`data-testid="app-block-chrome"`). One of them is
**conditional** — `RewardsBonusBanner` ("BONUS REWARDS ACTIVE", ~32-36 px)
renders only while a Buzz multiplier is running, and only *after* its query
resolves, i.e. it can appear after first paint. The same app on the same viewport
therefore has two layouts a constant offset apart.

Measured 2026-08-22 by gate F11, sweeping every candidate value over
model-benchmarking's own capture of 2026-08-15 (`5-mb-combinations.png`) and over
the banner state cut from it by
`.claude/skills/app-capture/tests/fixtures/bannershift.py`. That fixture is kept for its
**layout**, not its content — the live store screenshots were re-shot on
2026-08-22 from a much fuller app and it predates them:

| layout | full-width furniture ends | app content starts | valid `chromeTop` |
|---|---|---|---|
| banner absent | ~163 | 194 | **163…196** |
| banner present | ~199 | 230 | **199…232** |

🔴 **Those are properties of the 2026-08-22 fixtures — which is all gate F11
claims — and the live page has moved since.** Re-measured 2026-08-26 on the same
shell at the same 1709 px width: the banner occupies rows **68…104** (height 37)
and the iframe starts at **141** with it *present*, so the absent layout would be
~104. Both live values are NUMERICALLY SMALLER than *both* windows above — i.e. higher
up the page: the stack over the banner
MOVED UP by ~58 px in four days — strictly, THE IFRAME TOP did, which is the
only thing measured. (199->141
with the banner, 163->~104 without. WHERE in the stack the height went is NOT
measured — the new reading puts the breadcrumb BELOW the banner, so the loss
could sit either side of it.) The premise is untouched — the two layouts still differ
by the banner's height, so no constant serves both — but do not read 163/199 as
current, and do not "correct" a recipe to them. This drift **is** the argument
for deriving the edge instead of pinning it.

Two ~34-value windows, **disjoint**. Cross-checked against custom-generators'
four captures: a *different* app column (`x=364 w=972` against mb's
`x=252 w=1200`) on the same viewport, with the **same** two edges — furniture
ending ~163, content starting 194 — and the same 163…196 window. So the
discriminator is the banner, **not** the app and not the viewport: the recipe was
measured right and later refused because the page had changed underneath it. Below the window the breadcrumb bar is
sampled as content — it spans the full width, so the box pins to full width and
`full_frame` refuses. Above it the top of the app's own header is clipped. That
is exactly how model-benchmarking's recipe was found broken at 182: correct with
the banner absent, `full_frame` with it present. **A bigger constant just moves
the failure to the other layout** — gate F11 asserts the empty intersection, so
"pick a better number" is a refuted option, not an untried one.

The way out is that the boundary is *known*: the iframe's own bounding rect. With
`"crop": { …, "fromAppFrame": true }`, `capture.sh` runs a one-line **top-frame**
probe (source: `frame.py frame-rect-js`, so it is pinned, actuation-guarded and
testable) and `frame.py` folds the answer into the bands.

Four properties make it safe rather than clever:

- **The rect WIDENS, never narrows** — `max(recipe, derived)` per axis. The
  scrollbar and the floating support button are top-frame and position-*fixed*,
  drawn **over** the iframe, so no rect can exclude them; `right: 70` is still
  doing that job. It also means every degenerate reading is safe by
  construction: an iframe taller than the viewport reports a negative bottom
  gap, a scrolled page a negative top gap, and both simply lose.
- **The probe reports the viewport too**, and a disagreement with the captured
  PNG beyond 2 px refuses (`app_frame_scale`). That is the only check on a
  `devicePixelRatio` this code cannot otherwise see.
- **Detection still runs** *for the four recipes that detect*, so `full_frame`
  and the identical-box check keep working there. Declaring a `crop.rect`
  instead would have made both inert for those apps — which is why the fix sets
  bands and not a rect wherever detection can work at all.
- **No fallback.** A probe that finds no iframe stops the run
  (`app_frame_absent`). Falling back to the static band would restore the defect.

Measured **top-frame**, not `--frame`-scoped: the `<iframe>` *element* lives in
the host page. It is the one DOM op here that must not carry `--frame`, and the
fake bridge refuses it if it does.

An **absolute** `rect` and `fromAppFrame` are mutually exclusive by refusal: the
rect bypasses detection, so there would be no band to derive. ⚠ **There is no
"deliberate exception" any more** — every shipped recipe is `detect` or
`appFrame`. sensei was the standing example here and is no longer one — it converted to the anchored form on 2026-08-27 after its `y: 97`
was measured 44 px ABOVE the iframe top, not below it; see "Three crop forms"
above. The iframe rect knows where the app
is; it does not know which of the app's own pixels are worth shipping. That is
also the limit of the frame-relative form above: it tells you where the app
begins, and you still have to say which of its rows are worth photographing.

## Store bounds

`.claude/skills/app-capture/scripts/store-bounds.json` is the single source of
truth; nothing else may carry a copy. Renders target **1200×778**, matching the
five screenshots already on these listings.

⚠️ An **icon is re-encoded server-side to PNG** and the re-encode is capped
separately: a detailed 1024×1024 icon can pass locally and still be refused on
attach. The gate says so in its verdict, because it cannot check it.

## Attach semantics

- Attaching to a **live** listing opens a **shadow revision** for moderator
  re-review, so `--changelog` is mandatory.
- Icon + cover + several screenshots in **one session land on one revision** —
  the same `alpr_…` id came back from each call.
- 🔴 `add-screenshot` / `updateScreenshotCaption` / `removeScreenshot` return an
  id **re-keyed onto the clone — not an echo of the id you passed.** Treating it
  as an echo corrupts a subsequent reorder or caption call. `attach.sh` re-reads
  the listing afterwards and reports the ids the server actually holds.
- `reorder` needs **all** current screenshot ids in the new order.
- Captions are supported and currently unused on every listing. Use them.
- `attach.sh` refuses to do anything without `--confirm`, gates the store bounds
  **before** calling the CLI, and refuses a missing `--changelog`.

## 🔴 The spend path (`--trusted`) — the mechanics

Measured on panorama-360: a synthetic in-frame click works on an ordinary control
and does **nothing at all** on the Generate button. The money path rejects
untrusted events. So `trustedKey` emits: focus in-frame → **verify**
`document.activeElement` → record the focused X window → `browser activate` →
**re-focus** (activation can move focus) → trusted keypress → **restore the
operator's window immediately**. Never a coordinate click: the maths spans an
iframe offset plus window chrome, and a mis-aimed trusted click in a live browser
can hit anything.

- Unreachable without the explicit `--trusted` flag — `plan.py` refuses it, and
  every op that touches the app's document comes out of a plan. (`capture.sh` does
  emit lifecycle/observe ops and the top-frame rect probe of its own; none can
  actuate, and the probe is refused by `frame.py`'s `guard_rect_js`. The older
  "no bridge op of its own at all" here is RETRACTED — see
  `.claude/skills/app-capture/reference/foreground-and-spend.md`.)
- ⚠️ **Do not verify a spend with a Buzz-balance delta.** Some apps bill per GPU
  second *on completion*, so the balance does not move at submission. A
  `trustedKey` action must carry `verifyLabel` — the control's own state label
  (e.g. `Rendering…`). A recipe that tries the balance route is refused by name.
- panorama-360: **Generate is the only direct-child button of `#pano-controls`.**
  A loose `button` query opens the checkpoint picker instead.

How this coexists with capture's own (non-spending) use of `browser activate` is
in `.claude/skills/app-capture/reference/foreground-and-spend.md`.

## 🔴 Viewport PINNING (`browser emulate`) — evaluated 2026-09-02, NOT shipped

The obvious follow-on to the viewport-of-record gate is to stop the mismatch ever
happening: pin the tab's viewport with the bridge's `emulate` op so a capture is
reproducible whatever window the tab lands in. **It was investigated and is not
implemented.** Nothing below was measured against a live browser — this is a
source read plus this repo's own recorded measurements, and it is stated at that
width. What it is enough for is a decision *not* to ship blind.

**Four blockers, in descending order of how hard they are to remove.**

1. **It cannot cover `--tab`, by construction.** `emulate` is in the bridge's
   `OWNED_TAB_ONLY_OPS` (`<devrc>/scripts/browser-bridge/server.py`, enforced where
   `op in OWNED_TAB_ONLY_OPS and (owned is None or resolved != owned)`): only a tab
   the calling session opened via `open` may be emulated, and anything else is
   refused `not_owned_tab`. That refusal is deliberate — an agent resizing the tab
   a human is looking at is a screen-stealing action. But `capture.sh --tab ID`
   drives exactly such a tab, is a documented mode, and is pinned by gate **G10**.
   So a pin would apply on some runs and not others, which is worse than no pin:
   the recipes' rects would be "guaranteed" on one path and unchecked on the other.

2. **The recipe records a PRODUCT; pinning needs the FACTORS.**
   `_measuredGeometry.viewport` is device pixels — `Math.round(innerWidth * dpr)` —
   so `1709x1255` does not say whether that was 1709 CSS px at DPR 1 or 1498 at
   1.140625. `emulate` sets `width`/`height`/`deviceScaleFactor` separately. Every
   shipped record would have to be re-derived into a CSS size and a DPR before a
   pin could reproduce it, and **that needs a live browser and a re-measurement per
   app** — the very thing this work was scoped out of.

3. **Emulation forces every capture onto the CDP path.** `screenshot` in
   `<devrc>/scripts/browser-bridge/extension/service_worker.js` takes its cheap
   `captureVisibleTab` fast path only when `tab.active && !fullpage && !emulated`;
   an emulated tab therefore always attaches the debugger and uses
   `Page.captureScreenshot`. That is a *correctness* gate, not an optimisation
   (`captureVisibleTab` would photograph the real, un-emulated rendering) — but it
   means pinning changes the capture primitive for **every app, on every run**,
   plus a debugger banner on the operator's window. The recorded behaviour of the
   two paths already differs (`.claude/skills/app-capture/reference/foreground-and-spend.md`: the fast
   path *hangs* on an occluded window and is bounded at 1500 ms; CDP captures a
   hidden one fine). Whether the two produce byte-comparable images at the same
   geometry is **not measured anywhere in this repo**.

4. **The emulated size SURVIVES a crash.** `protocol.js` records — as a correction
   to two earlier false claims in the same comment, measured 2026-08-03 — that the
   viewport **size** resizes the browser-side render widget and does *not* revert
   when the CDP session detaches, nor on re-navigation; only an explicit
   `emulate --reset` (an arm-then-clear two-step) undoes it. `capture.sh` exits
   from ~8 failure sites and has no cleanup path for this. A `SIGKILL`ed or failed
   run would leave the operator's browser visibly distorted, diagnosed as "Brave is
   broken" rather than "a capture died".

**And the argument against pinning that survives even if all four are fixed** —
this repo's own `RULES.md`: *a suite whose config PINS a dimension is structurally
blind to bugs on that dimension.* A pin makes every capture agree with the
recipes by construction, so a rect that has gone stale against the **app's** own
layout would never be caught by a viewport reading again — and the recipes' rects
are already dated snapshots (`model-benchmarking` was converted from detection
because an app-side PR changed the app's shape, with nothing linking the two).
The refusal keeps a human in the loop at the moment the geometry moves; the pin
removes them.

**Recommendation: keep the refusal, do not pin.** The gate costs one refused run
and a resize; the pin costs a re-measurement of four recipes, a capture-path
change for every app, and a new way to leave the operator's browser wrong.

**If it is revisited, the closing condition is a measurement, not an argument:**
shoot one app twice at the same declared rect — once with the window at the
recorded viewport, once under `emulate --width W --height H --dsf D` chosen to
reproduce it — and show the two framed PNGs are byte-identical. Until those two
files exist and match, pinning is unproven. Answering "what does `--tab` do" is
the second half, and it needs a decision from whoever owns the ownership rule in
the bridge, not a change here.
