# Prompt library — the literal strings that worked

Every prompt here was run against NanoBanana (`--ecosystem NanoBanana
--checkpoint 2725610`). Copy them; do not paraphrase from memory. Where a string
is marked REFUSED or FAILED it is kept deliberately, because the failure is the
information.

---

## 1. Icon lighting (img2img over an authored flat mark)

The authored mark IS the composition. Generation only adds light. Composition
drift is the known failure, so the prompt NAMES the drift rather than hoping.

**Positive** — concatenate both halves:

```text
Studio photograph of this exact flat graphic mark realised as a physical object:
soft directional key light from the upper left, gentle falloff across the surface,
subtle dimensionality and crisp clean edges, faint contact shadow. The dark
charcoal background stays flat, even and neutral.
```

```text
Keep the composition, geometry, proportions and colours EXACTLY as given. Do not
add, remove, move or resize any shape. Do not add panels, borders, frames, glows,
text or extra background elements. Every rounded box stays a rounded box; every
circle stays a circle.
```

**Negative**:

```text
text, letters, words, watermark, signature, logo, ui, interface, screenshot,
extra shapes, added panels, border, frame, vignette, gradient background, people,
clutter, duplicated mark
```

Flags: `--aspect-ratio 1:1 --quantity 2`. Adapt the final clause of the KEEP half
to the shapes actually in the mark — a mark made of arcs needs "every arc stays an
arc".

---

## 2. Titled banner (the current cover grammar)

Parameterised by `title`, `tagline`, `hue`, `scene`. Driven by
`.claude/skills/listing-media/scripts/gen-banners.py`, which holds this as a format string.

```text
A premium app store banner on a deep near-black background with a subtle {hue}
gradient glow. On the LEFT, a text block with generous margin: the title "{title}"
on ONE SINGLE LINE in bold white sans-serif, and directly beneath it the tagline
"{tagline}" in a lighter grey weight. The title must fit on one line and must not
wrap. On the RIGHT, {scene}, with soft depth of field and a {hue} accent glow.
Crisp legible typography, dark editorial UI aesthetic, generous margins, nothing
cropped at the edges.
```

**Negative**:

```text
misspelled text, garbled letters, gibberish text, duplicated text, extra words,
two-line title, wrapped title, cropped text, text touching the edge, watermark,
extra logos, people, faces, clutter
```

🔴 **"nothing cropped at the edges" is the one instruction this template does not
reliably obey.** Right-edge clipping recurred on most renders. It is cosmetic at
store size; if you need it solved, that is the constraint to attack.

### Scenes that WORKED

| app kind | scene string |
|---|---|
| grid/compare | `a comparison grid: a matrix of image thumbnails in labelled rows and columns, every cell showing THE SAME MOUNTAIN LANDSCAPE rendered in a different art style, no people anywhere, teal accent lines` |
| style matrix | `a dense matrix of small square image tiles in even rows and columns, where EVERY TILE SHOWS THE SAME SINGLE OBJECT — a classic sports car in three-quarter view — each tile rendering that same car in a different art style: photoreal, oil painting, watercolour, pixel art, line sketch, low-poly, neon synthwave, claymation. No people anywhere, no characters, no portraits` |
| media collection | `a fanned stack of media cards with cover artwork, a large circular play button overlaid on the front card, coral pink glow` |
| panorama | `a wide panoramic landscape band curving and wrapping around into a sphere, a full 360 degree horizon, azure blue rim glow` |
| form builder | `a generator-builder panel: a form of labelled input fields and dropdowns on cards, and one large prominent primary action button glowing violet` |
| media player | `a music player panel: a large album-art tile, a horizontal audio waveform running across the frame, transport controls, warm orange glow` |
| node editor | `an elegant node-graph workflow: rounded node cards connected by smooth glowing cyan curves, receding with depth` |
| vote list | `a neat vertical stack of five rounded dark cards, fully inside the frame with clear space around them. Each card contains ONLY a large clean upvote arrow icon and one bold number beside it — the rest of each card is EMPTY dark surface with NO text, NO titles, NO labels and NO writing of any kind. The middle card is highlighted with a glowing amber border and a larger amber number` |
| chat | `a chat conversation panel: a short user question bubble, and below it an assistant reply bubble containing two or three well-formed sentences recommending an AI model by name, with a small model card underneath showing a thumbnail, a star rating and a download count. The assistant avatar is a PLAIN SIMPLE GREEN CIRCLE with no symbol or logo inside it` |

### Scenes that FAILED, and why

- **A list of titled request cards.** Gibberish on 4 of 4 renders across two
  rounds: "Flooting App Manker", "Want Houschatiors", "Capren meta requests".
  Blurring the text (round 2) left the titles sharp and still wrong. Only fixed by
  removing card text entirely — that is the "vote list" row above.
- **A chat panel without an avatar instruction.** Both renders put the ChatGPT
  sunburst on the assistant. Add to negative: `OpenAI logo, ChatGPT logo,
  third-party brand logo, company logo` AND specify the avatar positively.
- **A style matrix without a named subject.** Returned nothing but stylised female
  portraits, with `people, faces` already in the negative.

### REFUSED by content moderation

```text
a wide equirectangular landscape strip curving and wrapping into a sphere
```

The word **`strip`**. 🔴 The CLI's refusal says *do NOT retry this prompt: repeated
blocked attempts get the account muted.* Reword — "landscape **band**" passed. A
refusal is not charged.

---

## 3. Analogy cover (SUPERSEDED — kept for provenance)

The grammar before 2026-08-17: a real scene where the brand hue is the scene's OWN
light source, with no title. Superseded because an untitled photograph is anonymous
in a marketplace grid. Two rules still worth carrying if you ever shoot one:

- **The cover must be a DIFFERENT object from the icon**, so the pair covers two
  claims instead of saying one thing twice.
- The hue must be **native to the scene** — an ON AIR lamp really is that orange,
  server LEDs really are that cyan. An imposed hue reads as a filter.

**Suffix** appended to every analogy prompt:

```text
Cinematic editorial photography, shallow depth of field, soft volumetric light,
rich atmosphere, muted film grain. No text, no letters, no words, no logos, no
watermark, no people's faces.
```

🔴 Note the tension: that suffix bans text, and a lamp reading "ON AIR" rendered
the words anyway because the lettering IS the object. Diegetic text is not
suppressible by asking.

---

## 4. Judging a candidate

- **Icons at 320 px**, not 1024. Every motif that died, died at 320.
- **Ask what a stranger would say it depicts**, never whether it matches the brief.
- **Read both `--quantity 2` renders.** The gate in `.claude/skills/listing-media/scripts/finish-icons.py`
  catches composition drift the eye misses, and the eye catches trademark and
  content problems the gate cannot see. Neither alone is enough.
