# Mobile generator

> **Status: phase 1 committed and phase 2 built on `feat/mobile-generator`, checked on an emulated Pixel 5;
> real-device check pending. Phases 3–4 not started.**
>
> **Closes when** the `mobileGenerator` flag is on for everyone, the generator on a phone opens on
> the queue with the form as a bottom sheet, the `feat/mobile-generator` PR is merged to `main`, and every phase's
> "done when" line below has been checked on a real iOS and Android phone by the PR author, who
> ticks them in the PR description. Until that PR merges, this file is the tracker.

## Problem

The generator on a phone is the desktop sidebar stretched to full screen. Every control keeps its
desktop size and behaviour:

- **Sliders** are Mantine sliders with a small thumb on a thin track. Only the thumb is a drag
  target, a slightly diagonal drag scrolls the panel instead, and LoRA strength (−1 to 2 in steps
  of 0.05) has too many steps for a finger.
- **The number box beside each slider** opens the keyboard, which shifts the sticky footer.
- **Preset chips, info icons and segmented controls** are under the 44px touch minimum, and the
  info tips open on hover.
- **Form and results are separate tabs** (Generate, Queue, Feed), so checking a result means
  leaving the form.
- **The footer stacks every alert** above the Generate row, so on a small screen the row can be
  pushed down or off screen.

## Target design

Settled in review of the mockups (private artifacts; the "Sheet Generator" is the chosen
direction). Applies on phones, by the phone rule below, held upright or sideways; everything else
keeps today's layout.

- **The queue is the screen.** Header: a menu button, "Generator" with the queue count, and Close.
  The menu holds daily challenges, presets and the tour. No Generate / Queue / Feed tabs.
- **Feed becomes a density toggle** on the queue (Batches or Grid). Same outputs, filters,
  selection, bulk actions and lightbox as today's Feed.
- **The form is a bottom sheet** with two states:
  - _Closed:_ a one-line summary bar over the queue (workflow, prompt, model, ratio, quantity).
  - _Open:_ the full form under a title row (workflow name, a labelled Reset button, collapse
    chevron), scrolling inside the sheet, with the footer docked at its bottom.
  - It never fully hides, so the way back to the form is always on screen.
  - It drags only from its handle and title row, never from the form body.
  - After Generate it closes to the summary bar and the new batch appears at the top of the queue.
- **The form keeps today's fields, order and grouping.** Advanced holds exactly what it holds today
  (CFG, sampler, scheduler, steps, seed, CLIP skip, denoise, VAE and the rest).
- **Footer:** quantity stepper · Generate · Buzz button showing the cost. The cost moves off the
  Generate button onto the Buzz button (as today's selector already shows it), so 4–5 digit prices
  grow that button instead of overflowing Generate.
- **Cost sheet** (opened from the Buzz button): total with the tips it includes, creator and
  Civitai tip steppers, Pay with and the balance after the run, and the line-item breakdown folded
  behind "How this is calculated". The footer's Breakdown link goes away.

### Rules from review

These came out of review and apply to every phase:

- Quantity and queue limits come from the user's tier (`defaultsByTier` in
  `src/server/schema/generation.schema.ts`; image quantity up to 4 / 8 / 10 / 12, steps of 2 under
  the 2-for-1 bonus). No control may assume a fixed range.
- Only output format and priority show a fixed Buzz price on an option. Everything else is priced
  by the cost estimate.
- Embeddings and LoRAs are one resource list; the type is a label on each card.
- Wildcards (snippet sources, `#` categories, preview) stay moderator-only and are not part of this
  work.
- The prompt box keeps today's shape: editor and trigger words in one bordered box, negative prompt
  as its own field after it. Long trigger words truncate; past two lines they fold behind "+N
  more".
- When a control moves to make room, it stays as visible and as clearly labelled as before.
- Moderator-only controls and Maximize are not shown on phones.
- Attention weighting stays keyboard-only (Ctrl or ⌘ + ↑ / ↓ on selected words). It matters only for
  some ecosystems, so phones get no control for it; phone users can type the `(word:1.2)` syntax.

## Approach

**No form logic changes.** Field rules, ranges, tiers and defaults live in the form graphs
(`src/shared/form-graph/generation/`); the input components in `src/components/generation_v2/inputs/`
only render them. This work touches presentation only.

**One PR, one flag, and the flag picks the layout.** The whole project is one PR. A single feature
flag, `mobileGenerator`, defined in `src/server/services/feature-flags.service.ts` with a Flipt key
(`mobile-generator`) and `availability: []` so it is off until ramped (like `genTabDeferView`),
decides one thing: on a phone, show the mobile generator or the legacy generator. It does not gate
individual inputs. Removing it later means deleting the legacy branch and nothing else.

**Shared components, one version each.** Inputs are built once and used by both generators and by
desktop. They do not have desktop and phone copies. Where the mobile generator needs something
different, the component either reads it from the mobile generator's stylesheet (sizes) or makes one
small decision on `useMobileGenerator()` or, where the legacy generator on a narrow screen differs too,
`useGeneratorLayout()` (layout that styles cannot express). The slider is the
example: one `SliderInput` on one engine (`TouchSlider`) everywhere, with the mobile generator moving
the presets under the track, swapping the number box for a tap-to-type value and adding steppers.

Consequence, accepted: changes to shared components reach every user, desktop included, the day the
PR merges, and the flag cannot switch them off. The slider's new engine is the main one; it also fixes
the scroll-grabbing slider for phone users still on the legacy generator.

**One phone rule, defined once.** A window gets the phone layout when its primary input is touch and
it is narrower than 768px, or shorter than 500px (a phone held sideways is wider than 768px but
short). As one media query:

```css
(pointer: coarse) and (max-width: 767px), (pointer: coarse) and (max-height: 499px)
```

What it includes and leaves out:

- **In:** phones upright and sideways; a tablet app in a narrow split-view slice.
- **Out:** narrow desktop windows (no touch), touch-screen laptops with a narrowed window (their
  primary input is the trackpad, which is why the rule uses `pointer` and not `any-pointer`), and
  full-size tablets. These keep today's layout.

It is defined once (`PHONE_MEDIA_QUERY` in `src/utils/phone-layout.ts`) and read by one hook,
`useMobileGenerator()` in `src/hooks/useMobileGenerator.ts`, which is true when the flag is on and
the rule matches, and false outside the flag provider. Every phone decision uses it, directly or
through `useGeneratorLayout()`, which also reports the legacy generator under 768px as `narrow` (the
download alert in `ResourceAlerts.tsx` and Generate's confirm-first in `FormFooter.tsx` read it).
Two other rules exist and must not be used for this:

- `useGenerationPanelFullScreen` makes the panel full screen when the sidebar plus 320px of page
  does not fit the window. It answers "is there room for the page beside the sidebar", which depends
  on the sidebar's resizable width (350–800px), so a widened sidebar goes full screen on a 1,100px
  laptop window. It keeps that job on larger screens and does not decide the phone layout.
- `useIsMobile()` with no options measures the panel's own width (a container query), and the
  desktop sidebar can be narrower than a phone.

**Decide the layout in one place.** The mobile container is chosen once, in
`src/components/ImageGeneration/GenerationTabs.tsx`, from `useMobileGenerator()`. It wraps today's
form (`FormGraphGenerator`) and results (`GenerationResults`). Other screens do not render it.

**Phone sizes belong to the mobile generator's root.** Touch sizes (44px targets, 16px inputs, the
slider's band and thumb) live in one stylesheet, `src/components/generation_v2/PhoneControls.module.scss`,
whose class is applied only while the mobile generator is showing. It sizes the Mantine primitives the
generator is built from, sets the slider's sizes through CSS variables, and lifts our own small
controls marked `data-tap-target`. So the legacy generator keeps today's look on every screen, and
no mobile prop is threaded through. Until phase 3 builds the container, the class sits on
`GenerationSurface`.

**Styling: CSS modules where the two generators differ, Tailwind where they don't.** This repo
puts CSS modules in a cascade layer and leaves Tailwind utilities unlayered, so a Tailwind class always
beats a module rule and the mobile generator's stylesheet cannot override it. So:

- A component that looks different in the mobile generator (the slider, steppers, presets, the sheet,
  the footer, resource cards) keeps those styles in its own CSS module. Sizes that change are CSS
  variables with a desktop default, set by the mobile generator's root (as `TouchSlider` does with
  `--touch-slider-band`).
- Static layout that is the same in both stays Tailwind, per the repo convention.
- Existing Tailwind components that only need a larger tap area are marked `data-tap-target` rather
  than converted.

**One sheet primitive.** Three generator pickers switched to a drawer or full-screen modal on phones
by hand (`OverflowSegmentedControl` with `MobileMenuDrawer`, and the base model and workflow pickers
through `dialogStore`). `PopoverOrSheet` replaces those: a popover on desktop and a bottom sheet in
the mobile generator. In the legacy generator under 768px each picker keeps its drawer or full-screen
modal (`useGeneratorLayout()` reports `narrow`), so phones don't change before rollout apart from the
boundary, which is now under 768px for every picker.

## Phases

All four phases land on `feat/mobile-generator` in this order, in the one PR. Each phase leaves the
generator working, so the branch can be tested on a phone after any of them.

### 1. Touch-sized controls

- One slider engine (`TouchSlider`) behind `SliderInput` for every user, replacing Mantine's Slider in
  the generator and `NumberSlider` on the LoRA row. Mantine's Slider cancels every touch that starts
  on it, so a scroll that lands on a slider changes it; the new one starts a drag only on sideways
  movement. It keeps the recommended band, the value bubble and commit-on-release, and works with a
  mouse and the keyboard.
- In the mobile generator: the whole 44px band is the target, a bigger thumb, tap the value to type
  beside the track, presets at 44px under it. A recommended range is also written under the track
  ("Recommended: 4.0–7.0", or one value when the range has no width, as with CFG 1).
- LoRA strength in the mobile generator: − / + steppers (hold to repeat) around the slider on one
  row.
- Segmented controls, chips, buttons and option rows: 44px targets in the mobile generator. Buttons
  there use a square-cornered radius so short labels (Swap) stay rectangles; buttons in a
  `Button.Group` (Generate + Buzz) keep Mantine's joined corners.
- In development, the Next.js dev badge and the React Query devtools button are hidden while the
  mobile generator shows; they cover its footer.
- `ControllerLabel` info icons open on tap.

**Done when** every slider in the image and video forms can be set to any allowed value with a
finger without scrolling the panel, and no control in the form is under 44px on a phone. Inline text links (the model and resource names) are
exempt, as touch-size guidelines exempt links in running text. The footer's quantity arrows are
replaced in phase 4.

### 2. One sheet primitive

- `PopoverOrSheet` (`src/components/generation_v2/PopoverOrSheet.tsx`), with the base model,
  workflow and overflow pickers moved onto it.
- `useGeneratorLayout` (`mobile` / `narrow` / `desktop`) is the one layout rule; the download alert
  and Generate's confirm-first use it too, so landscape phones in the mobile generator get the phone
  behaviour. "Narrow" is under 768px for every picker (base model and workflow used 768 and under).
- `SheetSelect`: in the mobile generator every select in the form (sampler, scheduler, the graph's
  other selects, the ControlNet and preprocessor selects) shows as a field that opens a sheet;
  everywhere else it is Mantine's Select. `SelectInput` now ties its wrapper label to the field.
- Not covered here: the VAE and upscaler pickers are resource pickers, and the output format and
  priority pickers are menus (all phase 4); the preset picker's select sits inside its own modal.

**Done when** `grep -rnE "useIsMobile|useMediaQuery" src/components/generation_v2 src/components/form-graph`
finds nothing outside test files, and the only layout decision is `useGeneratorLayout()`.

### 3. The mobile container

- Queue as the screen, the header and its menu, the Batches/Grid toggle (the grid is today's Feed).
- The form sheet: closed and open states, handle-only drag, summary bar, title row with Reset and
  collapse.
- Generate closes the sheet and scrolls the queue to the new batch. Remix and "Generate with this
  resource" open it pre-filled.
- The footer docks to the visual viewport so the iOS keyboard does not cover it.
- **Make the pull-up obvious.** Pulling the form up from the bottom is a new interaction, so the
  closed bar has to invite it:
  - the bar says what it does ("Create Image · tap to open") and the whole bar is a tap target, not
    only the handle;
  - on first visit (empty queue) the sheet opens already expanded;
  - the first time the sheet is closed, the handle nudges up once and a one-line hint ("Pull up or
    tap to open the form") shows above the bar; dismissed for good after the first open.
- **No tour on phones.** The generator tour does not start in the mobile container, and its Help
  entry is not shown there. Desktop keeps it.
- **On a phone the panel is always full screen and always the phone layout**, whatever the sidebar
  width.
- **Back closes the top layer first.** The open sheet gets a browser-history entry, so the back
  swipe or Back button closes it before leaving the generator:
  - opening the sheet pushes a history state; closing it with the chevron or a drag calls
    `history.back()`, so the two paths stay in step;
  - the same applies to every layer above the sheet (pickers, setting sheets, the cost sheet, the
    lightbox), so Back always closes whatever is on top;
  - on phones, opening the generator from anywhere navigates to `/generate`, giving it its own
    history entry; entries that start with the form open (Remix, a model page's Generate, first
    visit) land on `/generate` and then push the open-sheet state, so Back closes the form first and
    a second Back leaves the generator;
  - the state lives in `history.state`, not the query string, so it does not reload the page or
    show in shared links, and it must not collide with the routed dialogs
    (`RoutedDialogProvider`).
- **Every way into the generator opens the sheet.** About 20 places open the panel with data
  (`generationGraphPanel.open`): the navbar Create button, Remix on images, a model page's Generate,
  tool cards, challenges and others. On phones each opens the queue with the sheet already open and
  pre-filled. The `/generate` page renders the same container, with Close going back.
- **Everything the form opens stacks above the sheet**: pickers, setting sheets, the image editors
  (crop, mask, sketch), the cost sheet and the lightbox. Closing one returns to the open form.
- **The Prompt Enhance panel** replaces the form inside the sheet, with its footer docked the same
  way.
- **Form and queue stay mounted together.** Today switching tabs remounts the whole form, which
  dominated mobile INP (the `genTabDeferView` experiment). The sheet removes that remount but keeps
  both trees mounted, so measure INP and memory on a low-end Android phone before and after.

**Done when** a phone can open the generator, change every field, generate, watch the batch run and
remix it without leaving the screen, with the keyboard open and closed, on iOS Safari and Android
Chrome; and a first-time tester opens the form without being told how.

### 4. Footer, cost sheet and resource cards

- Footer: quantity stepper bounded by tier, Generate, Buzz button with the cost; Reset in the title
  row. Today's footer is in `src/components/form-graph/generation/FormFooter.tsx`.
- Cost sheet built from `GenerationCostPopover` content, reordered around tips.
- Compact model and resource cards (`ResourceItemContent`): one header row plus one strength row.
- Footer alerts as single-line strips above the footer row.
- The VAE and upscaler pickers, and the output format and priority menus, open as sheets in the
  mobile generator.
- A resource's version picker (`ButtonGroupInput` in `ResourceSelectInput.tsx`) stays buttons up to
  three versions and becomes a select above that (a sheet in the mobile generator), keeping the
  experimental marker on each option.
- Queue and grid tiles: four actions in the tile footer, the rest in the tile's ⋮ menu.

**Done when** the footer fits at 360px wide with 12 images and a 5-digit cost, and no footer alert
moves the Generate row.

## Testing

- **Unit and browser tests** where a caller would notice a bug: the slider and stepper clamp to the
  tier's range and step (including steps of 2), the stepper's hold-to-repeat stops at the limit, and
  the phone rule matches a touch 390 × 844 portrait phone and an 844 × 390 landscape phone, but not a
  1024 × 768 tablet or a 600px-wide desktop window with a mouse, and the sheet primitive opens a sheet on a phone and a popover otherwise.
- **One end-to-end test** in the existing `Mobile Chrome` and `Mobile Safari` Playwright projects:
  open the generator, open the sheet, change quantity, generate, see the batch at the top of the
  queue, remix it, then press Back and see the sheet close before the generator does.
- **Real devices** for what emulators get wrong: the iOS keyboard and the footer, drag versus scroll
  on the sheet, the iOS back swipe, landscape, safe areas. The phase "done when" lines are the checklist.

## When it ships

- A feature doc, `docs/features/mobile-generator.md`, describing the phone layout and the phone rule,
  linked from `docs/features/README.md`.
- This plan is closed (status line updated) in the same PR.

## Out of scope

- Layout changes specific to the video, audio and 3D forms. They render the same input components,
  so phases 1, 2 and 4 already reach them; the container in phase 3 wraps them unchanged.
- Image editors (crop, mask, sketch): they already have phone layouts.
- Any change to generation logic, pricing or limits.
