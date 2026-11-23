# Training Studio on Civitai Elements

**Status:** in progress, behind the `training-studio-elements-ui` flag. Redesigned: the Select step (#9552), the Data step (#9878), the shell (#9902), the Review step (#10185), the run page (#10189) and My trainings (#10196). The Data-step dialogs (#10201) are redesigned and the run page's loss graph and log are in review. Next: the image-edit Data step, then cleanup.
Tracked in HQ as `training_studio_civitai_ww5n`; slice 0 is `elements_training_studio_d595`.

## Goal

Make Training Studio (`apps/training-studio`) look and behave like the main civitai.com app by building
its UI on Civitai Elements (`@civitai/components`), the `<civitai-*>` Lit elements themed from the main
app's Mantine theme.

Decisions (Luis, 2026-11-18):

- Convert as much of the UI as possible to Elements. There is no retheme-first stage.
- Where the kit has no element, build our own on the kit's authoring base (`CivitaiElement` and the
  `--civitai-*` tokens). These live in a Studio-owned module, not inside `@civitai/components`: the kit
  keeps app-specific elements out of its size-budgeted bundles.
- Reference look: the main app's Mantine UI, the generator and model pages in particular.

## Existing systems

- **The kit.** `@civitai/components` 0.13.0 is already a root dependency. Its source is
  `civitai/civitai-app-starters` (`packages/civitai-components`, `-theme`). It has 48 elements. The docs of
  record are developer.civitai.com/apps/elements only; the sibling "component showcase" pages are older.
- **Prior use in this repo.** `packages/civitai-post-planner` is built on the kit and hosted by a SvelteKit
  app (`apps/creator-studio/src/routes/(app)/calendar/+page.svelte`), which loads it client-side. The main
  app uses `@civitai/components-chat` for the App Assistant.
- **The Studio today.** It is built on `@civitai/ui` (shadcn-svelte, Mantine-derived palette in
  `packages/civitai-ui/src/lib/theme.css`) plus about 11k lines of hand-written Tailwind in Svelte. The
  `@civitai/ui` kit stays: `apps/moderator` and `apps/creator-studio` use it too.
- **Two shells.** The Studio runs as a SvelteKit app and as the `<civitai-training-studio>` element the
  main app embeds at `/training-studio`. That element renders into the host's light DOM
  (`shadow: 'none'`, `vite.element.config.ts`). Kit elements bring their own shadow roots, so they work
  inside it.

## What the spike established

Measured on the Select step (Media, Type and Engine rows, Continue button):

- **Registering.** Import `@civitai/components/<tag>/define`, not the bare `<tag>` module, which only
  exports the class. The `/define` modules are SSR-safe (`defineElement` returns early without
  `customElements`). `src/lib/civitai-elements.ts` holds the imports, and each component that uses an
  element imports it.
- **Theme.** Dark is the kit's base theme, so the dark-only Studio needs no `data-theme`.
- **Svelte 5 interop works.**
  - `data={…}` reaches the element as a property, which `select`, `segmented-control`, `tabs`,
    `radio-group` and `breadcrumb` require.
  - `value` binds as an attribute.
  - `onchange` receives the kit's `change` event, and the element's `value` holds the pick.
  - Checked by clicking an option inside the shadow root: the step, its summary and the dependent
    Type options all updated.
- **Tailwind's reset vs the kit.** Tailwind's preflight (`* { margin: 0; padding: 0; border: 0 solid }`)
  matches the elements themselves, and a page rule beats a shadow root's `:host` rule, so it wiped the
  kit's own padding and borders (a `civitai-card` with no padding, cramped badges).
  `kit-element-reset-exemption.ts` rewrites that `*` to `*:not(<kit and studio tags>)` in both builds,
  with the tags read from the kit's manifest and the `studio-*` element files.
- **a11y warnings.** Svelte's a11y checks treat every `<civitai-*>` tag as a static `<div>` and warn on
  click handlers. The elements render real controls in their shadow roots, so `svelte.config.js` filters
  those two warning codes for `<civitai-` and `<studio-` tags only.
- **Bundle.** The embed's JS grows from 454.45 to 466.65 kB gzipped (+12.2 kB) for Lit, the kit's base
  and two elements. CSS is unchanged at 31.37 kB. Later elements should add less, since Lit and the
  base are shared, but that is not measured yet.
- **Labels.** A kit field's accessible name comes only from its own visible `label`; `aria-label` on
  the host is not forwarded into the shadow root. So every converted field gets a visible label (the
  Data step's trigger word moved its help tooltip into the field's `description`).
- **Number fields.** `civitai-number-input` writes its value back into the input on every keystroke,
  which clears `1e` on the way to `1e-4` and turns `0.000` into `0`. Decimal parameters on the Review
  step use a `civitai-text-input` committed on change instead.
- **Links.** `civitai-button` takes an `href` but no `target`, so a link that must open the main app in a
  new tab (publish, model page, download weights) stays an `<a>` styled like a kit button.
- **Boolean options with dashed names.** Svelte sets a dashed attribute such as `close-on-escape` as an
  attribute, and `"false"` reads as on to Lit. Pass a changing boolean as the property instead
  (`closeOnEscape={…}`).
- **Selects.** `civitai-select` marks its choice with the `selected` attribute only, which a browser
  ignores once the user has picked from that select; resetting one from code needs a remount.
- **Modals keep their content mounted.** `civitai-modal` only hides its `<dialog>` on close, so a dialog
  whose content holds media or runs a mount-time action renders that content only while `open`.
- **Enter in kit fields** submits the form through `requestSubmit()` even when the form's submit button
  is disabled, so a submit handler checks the same condition the button does.
- **Controls on a card.** In the dark theme the slider track (`--civitai-color-track`) and the segmented
  control's group background (`--civitai-color-segmented-bg`) are the card surface colour, so on a
  card they disappear; set the token on the element (the loss graph does).
- **Datalists.** A `list=` id can't reach an `<input>` inside a shadow root, so a field with datalist
  suggestions (the Data step's tag filter) stays a native input.
- **Not yet checked:** rendering inside the main-app embed. The spike was checked in the standalone
  shell only.

## Primitive mapping

`@civitai/ui` imports in the Studio, by count, and their replacement:

| `@civitai/ui` | Uses | Element |
|---|---|---|
| button | 18 | `civitai-button` (`filled`/`light`/`outline`/`subtle`, `loading`, `left`/`right` slots) |
| dialog | 9 | `civitai-modal` |
| input | 8 | `civitai-text-input`, `civitai-number-input` |
| spinner | 6 | `civitai-loader` |
| toggle-group | 5 | `civitai-segmented-control` |
| textarea | 5 | `civitai-textarea` |
| checkbox | 5 | `civitai-checkbox` |
| tooltip | 3 | `civitai-tooltip` |
| toggle | 2 | `civitai-switch` |
| select | 2 | `civitai-select` |
| popover | 2 | **Studio-owned element** (no kit equivalent) |
| table | 1 | `civitai-table` |
| slider | 1 | `civitai-slider` |
| dropdown-menu | 1 | `civitai-menu`, `civitai-menu-item` |
| chart | 1 | **Studio-owned element** (the loss graph) |
| alert-dialog | 1 | `civitai-confirm-dialog` |
| alert | 1 | `civitai-alert` |

The hand-written markup maps onto layout and display elements too: model cards onto `civitai-card`,
status chips onto `civitai-badge`, epoch results onto `civitai-media-card`, and the run list onto
`civitai-pagination` and `civitai-table`. Each step's slice decides these as it goes.

## How it ships

One PR per slice, each releasable on its own. Every slice must work in both shells, and each PR checks
the embed as well as the standalone app.

0. This plan and the Select-step spike: the Media, Type and Engine rows and the Continue button.
1. The rest of the Select step and the shared shell: page header, stepper, summary panel, alerts.
2. Data step (uploads, label editor, tag management), with the first Studio-owned popover
   (`studio-popover`, a native `popover` panel) for "Set repeats".
3. Review step (parameter form, prices, confirm dialogs).
4. Run detail and My trainings (loss graph as the first Studio-owned element, epoch media cards).
5. Drop the remaining `@civitai/ui` imports from the Studio.

### The flag

The whole redesign ships dark behind one Flipt flag, `training-studio-elements-ui`
(`ELEMENTS_UI_FLAG_KEY`), and is opened to testers before anyone else (Luis, 2026-11-19). It has the same
fail-closed semantics as the Studio's other gates: moderators only until the flag exists in Flipt, then
its segments decide. The standalone shell evaluates it in the root layout load, so every page has it;
the main-app embed answers it through the `trainingStudioElementsUi` feature (`studioModelFlagFeatures`,
which is why the key is in `hostFlagKeys()`). Each shell puts it in context once (`+layout.svelte`,
`StudioApp.svelte`), and everything below reads it through `$lib/elements-ui`.

Each redesigned screen is a separate copy, and the flag picks one, so the old screen stays exactly as
it was: `SelectStep.svelte` (old) beside `SelectStepElements.svelte` (new), chosen in `TrainingFlow`.
Shared components render either version (`StickySummary`, `ServiceStatusBanner`, and `StudioHeader`,
which picks `AppHeader` or `AppHeaderElements`).
While both copies exist, a fix to a redesigned screen goes into both. The cleanup slice deletes the old
copies, the context and the flag.
