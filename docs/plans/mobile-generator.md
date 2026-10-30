# Mobile generator

> **Status: phases 1–4 committed on `feat/mobile-generator` and in review as one PR, checked on an
> emulated Pixel 5 and in a desktop browser; the end-to-end test and real devices still to do.**
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

- **The queue is the screen.** Header, one 56px row: the desktop daily-challenges button
  (`ChallengeIndicator`), "Generator" with the queue count, the Batches/Grid toggle, sort and
  filters as icons, and Close. It folds away while the results scroll down and comes back on the
  way up or near the top; while images are selected it is their actions instead, and stays.
  Presets act on the form, so they sit in the form's title row (a product decision). No Generate /
  Queue / Feed tabs.
- **Feed becomes a density toggle** in the header (Batches or Grid). Same outputs, filters,
  selection, bulk actions and lightbox as today's Feed.
- **The form is a bottom sheet** with two states:
  - _Closed:_ its title row over the queue (workflow name, up chevron), without the
    form's own actions (a product decision).
  - _Open:_ full screen, the form under the same title row (workflow name, Presets, Reset,
    collapse chevron), scrolling inside the sheet, with the footer docked at its bottom.
  - No drag handle (a product decision): the whole title row drags, and the chevron shows which way. The
    title has the row's width up to its buttons, so the longest workflow names fit at 360px.
  - It never fully hides, so the way back to the form is always on screen.
  - It drags only from its title row, never from the form body.
  - After Generate it closes to its title row and the new batch appears at the top of the queue.
- **The form keeps today's fields, order and grouping.** Advanced holds exactly what it holds today
  (CFG, sampler, scheduler, steps, seed, CLIP skip, denoise, VAE and the rest).
- **Footer:** quantity (a QTY button that opens a sheet of the tier's options) · Generate · Buzz button showing the cost. The cost moves off the
  Generate button onto the Buzz button (as today's selector already shows it), so 4–5 digit prices
  grow that button instead of overflowing Generate.
- **Cost sheet** (opened from the Buzz button): total with the tips it includes, creator and
  Civitai tip steppers, Pay with and the balance after the run, and the line-item breakdown folded
  behind "How this is calculated". The footer's Breakdown link goes away. Desktop uses the same
  picker as a popover (a product decision), so the cost and Buzz type are one control everywhere.

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

**Decide the layout in one place.** The default export of
`src/components/ImageGeneration/GenerationTabs.tsx` chooses once, from `useMobileGenerator()`:
`MobileGenerator` (`MobileGenerator.tsx`), or `TabbedGenerationPanel`, the legacy tabbed panel.
`MobileGenerator` is given today's form as a prop and renders today's results. Other screens do not
render it.

**Phone sizes belong to the mobile generator's root.** Touch sizes (44px targets, 16px inputs, the
slider's band and thumb) live in one stylesheet, `src/components/generation_v2/PhoneControls.module.scss`,
whose class is applied only while the mobile generator is showing. It sizes the Mantine primitives the
generator is built from, sets the slider's sizes through CSS variables, and lifts our own small
controls marked `data-tap-target`. So the legacy generator keeps today's look on every screen, and
no mobile prop is threaded through. The class sits on `GenerationSurface`
(`GenerationSidebar.tsx`), the root of both generators.

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
  `SheetSelect` also takes `readOnly` (no sheet, no ✕: a picker card with one version) and
  `leftSection`.
- Not covered here: the output format and priority pickers are menus (phase 4); the VAE and
  upscaler pickers are the resource search (see phase 4); the preset picker's select sits inside its
  own modal.

**Done when** `grep -rnE "useIsMobile|useMediaQuery" src/components/generation_v2 src/components/form-graph`
finds nothing outside test files, and the only layout decision is `useGeneratorLayout()`.

### 3. The mobile container

- Queue as the screen and its one-row header (challenges, count, Batches/Grid toggle, sort, filters,
  Close); the grid is today's Feed.
- The form sheet: closed and open states, title-row drag, title row with the
  workflow name, Reset (phase 4) and collapse.
- Generate closes the sheet and scrolls the queue to the new batch. Remix and "Generate with this
  resource" open it pre-filled.
- The footer docks to the visual viewport so the iOS keyboard does not cover it.
- **Make the pull-up obvious.** Pulling the form up from the bottom is a new interaction, so the
  closed bar has to invite it:
  - the whole closed bar is a tap target;
  - on first visit the sheet starts closed, and a swipe coach holds the screen: a scrim over
    everything above the bar, a looping finger swiping up, and "Swipe up to open the form". Only
    opening the form ends it, by a swipe up anywhere on it or a tap on the bar (for anyone who
    can't swipe); it never shows again.
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

Built (`src/components/ImageGeneration/MobileGenerator.tsx`):

- The panel's `view` drives the sheet: `generate` is the open sheet, `queue` and `feed` are the
  Batches and Grid densities under it. So every entry that opens the form (`generationGraphPanel.open` with
  input, `setView('generate')`) opens the sheet, with no change at the call sites.
- On a phone `GenerationSidebar` sends the open generator to `/generate`, and leaving that page in
  any way closes it.
- Back: `src/utils/history-layers.ts` gives each open layer a same-URL history entry marked with its
  id in `history.state`. `useHistoryLayer` attaches it to the form sheet, to every `MobileMenuDrawer`
  (picker, sort and filter sheets) while the mobile generator is showing, and to every
  `dialogStore` dialog likewise. Next sees those pops through `RoutedDialogProvider`'s `beforePopState`,
  which returns false for them.
- The open sheet fills the screen below the status bar (the first-run swipe coach teaches the pull-up, so
  it no longer leaves a strip of header showing); the chevron, a drag down and Back close it. The
  generator pays its own top safe-area inset, being fixed.
- `useMobileGeneratorStore.submittedAt` is what closes the sheet on Generate.
- The header has desktop's `ChallengeIndicator`; presets (`PresetHeaderButton`, a sheet here) sit
  in the open form's title row beside Reset, both icons so they fit at 360px. The tour does not
  start, and moderator tools
  and Maximize are not shown. Pull-to-refresh is off in the form, so a downward drag there scrolls
  instead of reloading the page.
- The sheet starts closed on a first visit (nothing saved), under the swipe coach, and opens on
  every entry that brings input, such as Remix. A plain reopen, such as
  Create, keeps the sheet as it was left.
- Not yet checked: generating while signed in, the lightbox and image editors over the sheet, the
  Prompt Enhance panel inside the sheet (it renders in the form, so it should sit there unchanged),
  the iOS keyboard, and the INP and memory measurement.
- Known gap: a dialog over the generator that opens a routed (query-string) dialog and then closes
  leaves its history entry under the routed one, so one later Back does nothing visible. Entries left
  by leaving the page with a layer open are stepped past, and "Go back" counts them from
  `history.state`. The end-to-end test below is still to write.

**Done when** a phone can open the generator, change every field, generate, watch the batch run and
remix it without leaving the screen, with the keyboard open and closed, on iOS Safari and Android
Chrome; and a first-time tester opens the form without being told how.

### 4. Footer, cost sheet and resource cards

- Footer: a QTY button opening the tier's quantities, Generate, Buzz button with the cost; Reset in the title
  row. Today's footer is in `src/components/form-graph/generation/FormFooter.tsx`.
- Cost sheet built from `GenerationCostPopover` content, reordered around tips; the same picker
  replaces desktop's Pay-with menu and Breakdown link.
- Compact model and resource cards (`ResourceItemContent`): already one header row plus one
  strength row after phase 1; no change.
- Footer alerts as single-line strips above the footer row.
- The output format and priority menus open as sheets in the mobile generator. The VAE and
  upscaler pickers stay the resource search (decided).
- A resource's version picker (`ButtonGroupInput` in `ResourceSelectInput.tsx`) stays buttons up to
  three versions and becomes a select above that (a sheet in the mobile generator), keeping the
  experimental marker on each option.
- Queue and grid tiles: four actions in the tile footer, the rest in the tile's ⋮ menu.

Built:

- Footer (`MobileFooterParts.tsx`): QTY opens a sheet of the tier's quantities in its steps, with
  the ones a membership unlocks shown locked; Reset, an icon, renders into the sheet's title row (the
  `titleActions` slot in `mobile-generator-slots.tsx`) and leaves the footer.
- Cost picker (`CostPicker.tsx`), the Buzz button on every layout: a sheet on a phone, a popover on
  desktop. Total, creator and Civitai tip steppers (5% steps), Pay with and the balance after, and
  `GenerationCostPopoverDetail` folded behind "How this is calculated". It replaces desktop's
  Pay-with menu and the Breakdown link beside the queue snackbar, and keeps the menu's glow until
  first opened. Training keeps `BuzzTypeSelector`.
- Queue slots: a line of their own along the bottom of the mobile header (`QueueSlots fill`), one
  bar per slot sharing the width, so up to 12 slots fit; the header's count badge stays. The phone
  footer drops the queue line and keeps only the free tier's full-queue banner
  (`QueueLimitBanner`). The mobile generator provides `GenerationProvider` around its header and
  form, and the form's provider defers to it, so both read one queue state.
- Queue cards: "Additional Details" is a Details button in the card header (`QueueItemDetails`),
  a popover on desktop and a sheet on a phone. On a phone the card is its header and outputs, and
  the prompt and resources move into Details; desktop keeps both inline (a product decision).
- Remix and the other `setData` entries open the form in the mobile generator; on desktop
  `/generate` the form is always on screen, so they still leave the view alone there.
- Every `MobileMenuDrawer` over the mobile generator closes on Back (the sort and filter sheets
  included), so `PopoverOrSheet` no longer registers its own layer. Sheet option rows are one
  component, `SheetOption` (`src/components/Drawer/`), shared with the site's sort menu.
- Tapping a checkbox's or radio's description toggles it, site-wide (`choice-label.module.scss` in
  the theme). Switch already did.
- Under 768px (`useIsMobile({ type: 'media' })`, not behind the flag) the resource picker, in every
  `ResourceSelectModal` consumer:
  - slides its toolbar away while the results scroll down (on every layout the toolbar is a sticky
    header inside the results, so its return never moves them); it stays while it has focus;
  - groups the toolbar as tabs, then search, sort, filters and the gear, the search and those three
    on a row of their own below the tabs; sort and filters are icon-only (the sort's label names the
    current sort), and the search text is 16px so iOS doesn't zoom;
  - lists results as one column of fixed-height rows (`ResourceSelectCard` `compact`): thumbnail,
    name over two lines, like, ⋮ (`ModelCardMenu`: hide, block, report), type, base model, paid and
    private marks, version and Select.
- The picker's Featured tab opens each card on the version that was featured (this ecosystem's when a
  model is featured in several; `getFeaturedModels` returns `modelVersionId`), and keeps the
  ecosystem's base-model filter for every type but checkpoints (`buildFilter` and
  `ResourceHitList`); featured checkpoints span every ecosystem.
- On a coarse pointer a picker card's image no longer links to the model page; the name does. The
  picker's cards no longer show the auction bid button. `useHideOnScroll` (`src/hooks/`) is the one hide-on-scroll rule: the
  generator header, the picker toolbar, the site's `SubNav` and the comics reader header all use
  it (shown near the top; hidden after 100px down since the last turn, back after 100px up).
- While a text field in the form has focus (the keyboard is up), the footer hides so the field
  has the room; it returns when the field loses focus. The prompt editor is 16px in the mobile
  generator, as the Mantine inputs are, so iOS does not zoom the page on focus.
- Strips fold only what informs. What stops Generate stays in full (`data-strip-full`): the terms,
  the generation status and self-hosted blocks, and the footer's blocking alerts (missing field,
  mature source, trial blocked, cost estimate failed, submit error, not enough Buzz). The footer
  drops its top padding while strips show, so the top strip meets its rounded edge.
- Footer strips that are not alerts (the queue banner, the daily-boost claim) get the footer's side
  padding back.
- `FooterStrips` wraps the footer's alerts and the layout's notices (status, terms, daily boost):
  edge-to-edge strips folded to one line until tapped, in a stack that scrolls past 35% of the
  height. The status message moves above the Generate row. The membership upsell, being a choice,
  keeps its full height.
- Output format and priority open their choices as a sheet (`SheetOption` rows, shared with
  `SheetSelect`); a member-only priority still offers the membership to a non-member.
- Version picker: past three versions, a `SheetSelect` (a select on desktop too).
- The queue filters' Ecosystem and Workflow selects are `SheetSelect`s: a full-height sheet with a
  search box that waits for a tap, so the keyboard stays down until wanted. A clearable
  `SheetSelect` lists its placeholder ("All Models") first, which clears it, and its field has an ✕.
  Inside another sheet (`MobileMenuDrawer`) a `SheetSelect` drills in: its options replace the
  sheet's content, with a back arrow, rather than stacking a second sheet.
- Tiles in the mobile generator keep favourite, thumbs up and down and Improve; Download moves into
  the tile's ⋮ menu, and Remix and Details are in the lightbox, as in the mockup. The ⋮ and Improve
  menus open as bottom sheets (`useMenuSheet`), so a long menu never runs off the screen, as does the
  picker card's ⋮. `useMenuSheet` portals the sheet: the theme keeps popovers inline, and a
  transformed ancestor (a virtualized row) would hold its `position: fixed`.
- Queue cards on a phone drop the moderator dashboard link and the duration badge, and keep the
  workflow ID copy (moderators asked for it). The cost badge's breakdown (a sheet on a phone) ends with what paid for the run, so the
  separate transactions icon shows only for a run with no cost; the cost and workflow badges wrap
  together.
- The mobile generator reopens as it was left (form open or closed, Batches or Grid), restored once
  per page load from local storage; a first visit starts closed, under the swipe coach.
- The VAE and upscaler pickers stay the resource search, which opens full screen on a phone and
  closes on Back.
- Known gap: "balance after" in the cost sheet leaves out a download-boost fee accepted at submit;
  the balance check at submit still includes it.
- Not covered by a test: `FormFooter` choosing the mobile parts, and Download in the tile's ⋮ menu
  (both render trees too heavy to stand up in a browser test). Check them on the device.

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
