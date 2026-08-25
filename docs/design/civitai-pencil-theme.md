# Civitai Pencil theme kit

A design-token set and component library for Pencil (`.pen`) files, derived from the app's real
theme sources so mockups and shipped UI stay in step.

Currently lives in `designs/collections.pen` (components at canvas `y 0–830`, screens at `y 1000+`).

## Where the values come from

| Layer | Source of truth | Notes |
| --- | --- | --- |
| Colour palette | `tailwind.config.js` and `src/providers/ThemeProvider.tsx` | The two files declare identical 10-step ramps. Copied verbatim. |
| Spacing / radius / font size | Mantine v7 defaults | `createTheme` overrides none of them. |
| Breakpoints | `src/utils/breakpoints.json` | 480 / 768 / 1024 / 1184 / 1440. |
| `--header-height`, `--footer-height` | `src/styles/globals.css` | 60 / 45. |
| `buzz` | `--buzz-color` in `globals.css` | `rgb(252, 156, 45)` → `#FC9C2D`. |

Two things worth knowing before you reach for a token:

**`primary` is blue because Mantine's default is blue.** `createTheme` never sets `primaryColor`,
so `blue.6` (`#228BE6`) is what the app resolves to. It is a default, not a brand decision — if the
app ever sets `primaryColor`, this token moves with it.

**`accent.5` and `buzz` are the same hex** (`#FC9C2D`). They are kept as separate tokens because the
codebase treats them separately: `accent` is a Mantine colour tuple, `buzz` is a Tailwind colour fed
by a CSS variable. Mantine cannot consume the CSS variable (see the comment in `ThemeProvider.tsx`),
which is exactly why both exist.

## Token layers

**Palette** — `color-<hue>-0..9` for `dark`, `gray`, `blue`, `red`, `green`, `yellow`, `orange`,
`lime`, `gold`, `accent`, `success`, plus `color-white` / `color-black`. Fixed hexes, no theming.

**Semantic** — themed on a `mode: dark | light` axis:

| Token | dark | light |
| --- | --- | --- |
| `bg-body` | `#1A1B1E` | `#fefefe` |
| `bg-card` | `#25262B` | `#f8f9fa` |
| `bg-hover` | `#2C2E33` | `#f1f3f5` |
| `bg-elevated` | `#2C2E33` | `#ffffff` |
| `bg-input` | `#25262B` | `#ffffff` |
| `bg-overlay` | `#101113CC` | `#22222299` |
| `border` | `#373A40` | `#dee2e6` |
| `border-strong` | `#5C5F66` | `#ced4da` |
| `text-primary` | `#C1C2C5` | `#222222` |
| `text-bright` | `#FFFFFF` | `#000000` |
| `text-dimmed` | `#8c8fa3` | `#868e96` |

Unthemed semantics: `primary` `#228BE6`, `primary-hover` `#1C7ED6`, `accent`/`buzz` `#FC9C2D`,
`success` `#1EBD8E`, `danger` `#fa5252`, `warning` `#FAB005`. The `*-subtle` variants are themed.

**Scale** — `space-xs|sm|md|lg|xl` 10/12/16/20/32 · `radius-xs|sm|md|lg|xl` 2/4/8/16/32 ·
`fs-xs|sm|md|lg|xl` 12/14/16/18/20 plus `fs-h1|h2|h3` 38/30/24 · `fw-normal|medium|semibold|bold`.

**Font** — `font-body` is `"Inter"`, a **stand-in**. The app ships a system stack
(`-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial`), none of which Pencil can
render. Inter is the closest available proxy for layout metrics. It is not a Civitai brand font, and
nothing should be built on the assumption that the app uses it.

## Previewing light mode

Set `theme: {mode: "light"}` on any frame and its whole subtree resolves against the light column.
`designs/collections.pen` uses this for the light-mode sidebar screen — it is a copy of the dark one
with nothing changed but that property.

## Components

Named to match Mantine so a design reads as an implementation hint:

`Button/Filled·Light·Subtle·Default·Outline·Danger` and `Button/Compact *` ·
`ActionIcon/Subtle·Light·Subtle Large` · `Badge/Light·Dot·Filled·Neutral·Success·Warning·Accent` ·
`TextInput`, `TextInput/Unstyled`, `Select`, `Select/Small` · `Avatar/XS·SM·MD`, `AvatarGroup` ·
`NavLink`, `NavLink/Active`, `NavLink/Hover`, `NavLink/Stacked`, `NavLink/Stacked Active` ·
`Collaborators` · `View Toggle` · `Card`, `Card/Section` · `Modal` ·
`Tabs/Tab`, `Tabs/Tab Active` · `Menu/Dropdown`, `Menu/Item` · `Alert` · `Chip/Default·Active` ·
`Divider` · `ThemeIcon/Subtle·Light` · `SegmentedControl` · `Skeleton` · `Stat Pill` ·
`Sidebar/Section Header` · `Invite Card` · `Collaborator Row`.

## Reusing the kit in another `.pen` file

Pencil has two constraints that rule out importing it:

1. Components cannot be referenced across `.pen` files.
2. The MCP tools only ever operate on the **currently active editor**. Passing a `filePath` for a
   file that is not open silently writes to the active document instead — which is how an earlier
   pass at this kit ended up duplicated inside `collections.pen`.

So seeding a new file is a replay, not an import:

1. Open the target `.pen` in Pencil and make it the active editor.
2. Run the `SetVariables` call below via `pencil.execute`.
3. Re-run the component-construction calls from `designs/collections.pen`'s history, or copy the
   component frames from the canvas.

Ids are regenerated per file, so capture the `name → id` map each call returns and use those ids for
`ref` and `descendants`.

```js
const P = {
  dark:['#C1C2C5','#A6A7AB','#8c8fa3','#5C5F66','#373A40','#2C2E33','#25262B','#1A1B1E','#141517','#101113'],
  gray:['#f8f9fa','#f1f3f5','#e9ecef','#dee2e6','#ced4da','#adb5bd','#868e96','#495057','#343a40','#212529'],
  blue:['#E7F5FF','#D0EBFF','#A5D8FF','#74C0FC','#4DABF7','#339AF0','#228BE6','#1C7ED6','#1971C2','#1864AB'],
  red:['#fff5f5','#ffe3e3','#ffc9c9','#ffa8a8','#ff8787','#ff6b6b','#fa5252','#f03e3e','#e03131','#c92a2a'],
  green:['#EBFBEE','#D3F9D8','#B2F2BB','#8CE99A','#69DB7C','#51CF66','#40C057','#37B24D','#2F9E44','#2B8A3E'],
  yellow:['#FFF9DB','#FFF3BF','#FFEC99','#FFE066','#FFD43B','#FCC419','#FAB005','#F59F00','#F08C00','#E67700'],
  orange:['#fff4e6','#ffe8cc','#ffd8a8','#ffc078','#ffa94d','#ff922b','#fd7e14','#f76707','#e8590c','#d9480f'],
  lime:['#f4fce3','#e9fac8','#d8f5a2','#c0eb75','#a9e34b','#94d82d','#82c91e','#74b816','#66a80f','#5c940d'],
  gold:['#F6EDDF','#F2E4CF','#EDDBBF','#E9D2AF','#E5C99F','#E0C08F','#DCB77F','#D8AE6F','#D3A55F','#CD9848'],
  accent:['#F4F0EA','#E8DBCA','#E2C8A9','#E3B785','#EBA95C','#FC9C2D','#E48C27','#C37E2D','#A27036','#88643B'],
  success:['#9EC3B8','#84BCAC','#69BAA2','#4CBD9C','#32BE95','#1EBD8E','#299C7A','#2F826A','#326D5C','#325D51'],
}
const v = {}
for (const [n, steps] of Object.entries(P)) steps.forEach((c, i) => { v[`color-${n}-${i}`] = {type:"color", value:c} })
v["color-white"] = {type:"color", value:"#fefefe"}
v["color-black"] = {type:"color", value:"#222222"}

const th = (d, l) => ({type:"color", value:[{value:d, theme:{mode:"dark"}}, {value:l, theme:{mode:"light"}}]})
Object.assign(v, {
  "bg-body":th("#1A1B1E","#fefefe"),
  "bg-card":th("#25262B","#f8f9fa"),
  "bg-hover":th("#2C2E33","#f1f3f5"),
  "bg-elevated":th("#2C2E33","#ffffff"),
  "bg-input":th("#25262B","#ffffff"),
  "bg-overlay":th("#101113CC","#22222299"),
  "border":th("#373A40","#dee2e6"),
  "border-strong":th("#5C5F66","#ced4da"),
  "text-primary":th("#C1C2C5","#222222"),
  "text-bright":th("#FFFFFF","#000000"),
  "text-dimmed":th("#8c8fa3","#868e96"),
  "text-on-primary":th("#FFFFFF","#FFFFFF"),
  "primary":{type:"color", value:"#228BE6"},
  "primary-hover":{type:"color", value:"#1C7ED6"},
  "primary-subtle":th("#1971C233","#D0EBFF"),
  "accent":{type:"color", value:"#FC9C2D"},
  "buzz":{type:"color", value:"#FC9C2D"},
  "success":{type:"color", value:"#1EBD8E"},
  "danger":{type:"color", value:"#fa5252"},
  "warning":{type:"color", value:"#FAB005"},
  "danger-subtle":th("#e0313133","#ffe3e3"),
  "success-subtle":th("#1EBD8E33","#D3F9D8"),
  "warning-subtle":th("#FAB00533","#FFF3BF"),
})

const nums = {
  "space-xs":10, "space-sm":12, "space-md":16, "space-lg":20, "space-xl":32,
  "radius-xs":2, "radius-sm":4, "radius-md":8, "radius-lg":16, "radius-xl":32,
  "fs-xs":12, "fs-sm":14, "fs-md":16, "fs-lg":18, "fs-xl":20,
  "fs-h3":24, "fs-h2":30, "fs-h1":38, "lh-tight":1.25, "lh-body":1.55,
  "bp-xs":480, "bp-sm":768, "bp-md":1024, "bp-lg":1184, "bp-xl":1440,
  "header-height":60, "footer-height":45, "sidebar-width":300,
}
for (const [k, n] of Object.entries(nums)) v[k] = {type:"number", value:n}
v["font-body"] = {type:"string", value:"Inter"}
v["fw-normal"] = {type:"string", value:"400"}
v["fw-medium"] = {type:"string", value:"500"}
v["fw-semibold"] = {type:"string", value:"600"}
v["fw-bold"] = {type:"string", value:"700"}

SetVariables(v)
```

## Working notes

**The screenshot renderer draws no text.** `pencil.get_screenshot` returns fills, strokes and icons
but omits every text node, in every font — including with no `fontFamily` set. Layout still sizes
correctly from text metrics, so the document is fine; only the raster is wrong. Verify type and
spacing by exporting instead:

```
pencil.export_html → serve the directory over http:// → screenshot in a browser
```

Playwright blocks `file://`, so the file has to be served (`python3 -m http.server`).

**`ctx.bounds` in `Get` visitors is unreliable.** Child bounds come back with a phantom offset, and
the `problems` field derives from them, so nodes that render correctly are reported as
`fully clipped`. Treat clipping warnings from a visitor as unproven until you have looked at an
export. `ctx` is also sometimes `undefined`, which throws mid-visitor.

**Globals do not persist between `execute` calls** despite the tool docs saying otherwise. Only
direct `name = Insert(...)` assignments survive, and not always. Assume nothing carries over: print
an id map at the end of each call and paste the literal ids into the next one.

**These lucide icon names do not resolve** in Pencil's set — use the replacement:
`more-vertical` → `ellipsis-vertical`, `filter` → `funnel`, `clock` → `hourglass`.
`Arial` and `Helvetica` are rejected as font families.

**Overlapping canvas regions leak into exports.** `export_html` renders everything in the bounding
box of the requested nodes, not just those nodes. Keep components and screens in disjoint bands
(here: components above `y 830`, screens below `y 1000`) or exports pick up stray fragments.

**`TakeScreenshot` can come back completely empty**, not merely text-less. On `designs/reusable-blurbs.pen`
a finished screen rendered as a flat background rectangle — no fills, no strokes, no icons — while
`Get` reported correct bounds for every node. Treat a blank screenshot as a renderer failure, not as
evidence the document is broken, and verify through the HTML export instead.

**The HTML export writes `box-sizing: content-box` on padded frames**, so every frame renders its
padding *outside* the width the document gives it. A 640-wide header with `padding: [18, 20]` comes out
680×102 in the browser where pencil says 640×65, and the error compounds down a nesting chain — child
rows visibly overhang their parent's right edge. Composition, colour and copy are faithful; **spacing
and alignment are not**. Measure those with `Get`'s `ctx.bounds`, which is authoritative, and read the
export only for "does this look right".

Two mechanics for the export loop, since neither is guessable: the Playwright MCP refuses to write
outside the repo root, so screenshots have to land in `.playwright-mcp/`; and exports tag every node
with `data-pencil-name`, which makes `[data-pencil-name="<frame name>"]` a per-screen screenshot target
and saves cropping a 6,000px strip.
