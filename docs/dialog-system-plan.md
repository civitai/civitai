# One way to open a dialog

**Status:** shipped in #10184 (2026-11-23). Owner: Briant. plan-review: R thumbs up on v2.

Today a modal can be opened four ways, and two of them sit on a registry that every opener imports.
This plan keeps the dialog store, which does the hard part well, and replaces everything around it
with one helper. `openConfirmModal` moves onto the same stack.

## What the store already gets right (kept as is)

- `dialogStore.trigger({ component, props })` opens a dialog from anywhere, without a hook or a React
  context (`src/components/Dialog/dialogStore.ts`).
- `DialogProvider` renders the stack, and each dialog gets `zIndex: 300 + index`, so a newer dialog
  lands above older ones (confirms and content dialogs sit at 401 or higher, above the phone sheet). The dialog reads `opened`, `onClose` and `zIndex` from `useDialogContext()`.
- The same store dedupes by `id`, closes by id, and handles Back over the mobile generator
  (`useHistoryLayer`).

## Existing systems

| Part | What does it today | Search | Extend or new |
|---|---|---|---|
| Open a dialog | `dialogStore.trigger` (`dialogStore.ts:41`) | read the file | **Extend**: `openDialog` is a thin wrapper over it |
| Declare a lazy dialog, style 1 | `dynamic()` + `dialogStore.trigger` in the calling file: 46 files | files calling `dialogStore.trigger` that also call `dynamic(`/`lazy(` | Replaced by `openDialog` |
| Declare a lazy dialog, style 2 | `createDialogTrigger` (`dialogStore.ts:81`): 16 files | `grep -rln "createDialogTrigger("` | Replaced, then deleted |
| Shared openers | `src/components/Dialog/triggers/*.ts`: 24 files, imported by 84 files. About 22 more opener modules elsewhere, e.g. `AppBlocks/openBlockConsentModal.ts` ("ONE OPENER, EVERY CALLER, ON PURPOSE"), `openDailyLimitRaise.ts` (dedupes by id), `openStoryline*Modal.ts` | `ls`; `grep -rl "Dialog/triggers/"`; files that export `open[A-Z]…` and call `dialogStore.trigger` | **Extend**: kept where they earn it (see the opener rule below), with `openDialog` inside |
| Open a statically imported dialog | `dialogStore.trigger` with an imported component: 128 files | trigger callers without `dynamic(`/`lazy(` | Stays static in this PR (decision 2); `no-unlisted-dialog-open` holds them as a shrinking baseline |
| Routed dialogs | `routed-dialog/*.dialog.ts` self-register with `routedDialogDictionary.addItem`; `registry.ts` imports all 8 and hand-types their intersection; `RoutedDialogLink` and `triggerRoutedDialog` (40 files) look dialogs up by name | read `routed-dialog/` | **Split**: URL rules stay importable, components move to the provider |
| Confirm | `Dialog/Common/ConfirmDialog` (29 users) and Mantine `openConfirmModal` (136 calls in 96 files) | `grep -rh "openConfirmModal("` | Extend `ConfirmDialog`; `openConfirmModal` moves onto it |
| Other Mantine modals | `openModal` / `closeModal` / `closeAllModals` / `modals.*` from `@mantine/modals` in 21 files; `openContextModal` in 1 (`Stripe/SubscribeButton.tsx`) | imports from `@mantine/modals` | Decision below |
| Stacking helpers | `useStackingContext` (no users); `useIsLevelFocused` (one user, `DialogProvider.tsx:32` for `closeOnEscape`, and wrong once a lower dialog closes); `useIsTopDialog`; a similar check in `EdgeMedia/EdgeVideo.tsx:304-307`, which also counts a page-level player as current when no dialog is open (`useIsTopDialog(undefined)` is false), so it is not a copy | `grep -rln`; `dialogs.length - 1` | Delete the first two. `DialogProvider` uses `useIsTopDialog`; `EdgeVideo` keeps its own check |
| Places that state how to open a dialog | `.claude/rules/components.md`, `.claude/agents/civitai-reuse-review.md`, `docs/dev/import-cycles.md`, `docs/dev/convention-guards.md` | grep for `dialogStore.trigger`, `routed-dialog/registry`, `Dialog/triggers` across rules, agents, docs and config | Updated in this PR. `.eslintrc.js:212` stays: `RoutedDialogLink` keeps its exports |

History:
- `84b05d8c34` (2025-11-20, "fix routed dialog circular imports") introduced the `addItem` self-registration this plan replaces. That fix stopped the registry from importing its users; now `registry.ts` imports no modal at all, so it cannot bring that cycle back.
- #8332 hit the z-index edge between dialogs and Mantine popovers (`dialog.zIndex + 1`).
- `docs/routed-dialog-analysis.md` analyses the routed-dialog router. It has no Status line, so it is historical, and this plan does not touch the router.

## Design

### `openDialog`

```ts
// src/components/Dialog/openDialog.ts
openDialog(() => import('~/components/Report/ReportModal'), { entityType, entityId });
openDialog(() => import('~/components/Collections/AddToCollectionModal'), 'AddToCollectionModal', props);
openDialog(load, props, { id, onClose, target }); // the options dialogStore.trigger takes today
```

- **Types:** `props` is inferred from the loaded module's default export, or from the named export, so a wrong prop is a type error.
- **Under the hood:** it wraps the loader in `React.lazy` and calls `dialogStore.trigger`. `DialogProvider` wraps each dialog in `<Suspense fallback={null}>`.
- **Lazy and hook-free:** a modal still loads on first open, and opening still needs no hook. Stacking and `useDialogContext()` don't change.
- **No declaration file per modal, and no registry:** an opener names only the modals it opens.
- **The opener rule:** no new file per modal. An existing named opener, in `Dialog/triggers/` or elsewhere, stays when it adds behaviour (a fixed `id` for dedupe, default props, a check before opening) or has two or more callers. Its body becomes one `openDialog` call. A single-caller pass-through opener gets inlined at its caller and deleted.
- **Shared dialogs:** the `Dialog/Common` dialogs (`ConfirmDialog`, `AlertDialog`) are small and used everywhere. `openConfirm(props)` and `openAlert(props)` open them directly.

### Confirms: `openConfirmModal` → `openConfirm`

`openConfirm` opens `ConfirmDialog` on the dialog store. What callers pass today (rough counts over the 136 calls; the codemod recounts them exactly):
- `title`, `children` (becomes `message`) and `labels`: nearly every call.
- `onConfirm` (about 100), `confirmProps` (about 88), `centered` (about 65; `ConfirmDialog` always centres).
- Default labels: Mantine's provider defaults to "Confirm"/"Cancel", while `ConfirmDialog` defaults to "Yes"/"No". `openConfirm` defaults to Confirm/Cancel, so a former `openConfirmModal` call that leaves `labels` out looks the same; former direct `ConfirmDialog` callers pass Yes/No explicitly.
- `closeOnConfirm: false` (13): `ConfirmDialog` gains this option.
- `modalId` (5), used with Mantine `closeModal(id)`: becomes the dialog `id`, closed with `dialogStore.closeById`.
- `zIndex` (3): dropped. A confirm opened from a dialog is the newest entry, and `ConfirmDialog` never goes below `overMobileSheetZIndex`, so it is on top either way.

### Routed dialogs: URL rules importable, components in the provider

- **`routed-dialog/*.dialog.ts`:** each keeps only its URL rule, `routedDialog<typeof Modal>({ resolve, requireAuth?, target? })` (`routed-dialog/utils.ts`). It names its modal only through `import type`, so importing a rule never loads the modal.
- **`routed-dialog/registry.ts`:** a plain object of those rules, plus `getRoutedDialog(name)`. It imports no modal. `RoutedDialogLink` and `triggerRoutedDialog` use only this.
- **The name → component map:** lives in `RoutedDialogProvider` alone, which is mounted once in `_app`. Self-registration (`addItem`) and the hand-typed intersection are gone.
- **Out of scope:** the router (`BrowserRouterProvider`, `beforePopState`) does not change.

### Deleted

`createDialogTrigger`, single-caller pass-through openers (inlined), `routedDialogDictionary` and the `addItem` self-registration, `useStackingContext`, `useIsLevelFocused`, `CustomModalsProvider`, the `@mantine/modals` dependency and every call to it.

## Effect on import cycles (measured)

Modelled on `main` at `20d716da54` with the guards' import graph (`scripts/import-cycles.ts`'s
resolver, dynamic imports counted), comparing each change applied to the graph:

| | Modules in cycles | Client cycles | Page reach, summed |
|---|---|---|---|
| `main` now | 336 | 24, 22, 10, 9, 7, … | 728k |
| Routed split only | 314 | the 22-module cycle is gone | 704k (−3.3%) |
| `openDialog` only | 331 | trigger files leave the cycles; no cycle breaks | 727k |
| Both | 309 | 23, 10, 8, 6, … | 703k |

What this shows:
- Only the routed split breaks a cycle.
- `openDialog` leaves the cycles as they are, because a trigger file only passes the edge through: the opener still reaches the modal. Its value is a single pattern with no hub, so a new registry can't bring a cycle back.
- The client cycles that remain are mostly ordinary component imports. One opener is still in one: `Dialog/triggers/blurb-manager.ts` sits in the 24-module cycle through the editor ↔ blurb manager. Examples: the cosmetics hat popover ↔ the hat modal, the resource-select modal ↔ generation utils. They stay on the import-cycle follow-on milestone.
- Moving confirms has no cycle effect: none of `ConfirmDialog`'s imports (Mantine, `DialogProvider`, `dialogStore`, `app-layout.constants`) is in a cycle.
- Built: `scripts/import-cycles.ts` measures 309 modules in cycles, as modelled; client cycles are 24, 10, 9, 7 (the kept `blurb-manager` opener keeps the 24 whole) and summed page reach is 705k. The guard caps are lowered to match.

## Escape closes only the dialog opened last

Added during the build at Briant's request. Mantine 7.17 handles Escape with a window listener in
every open `Modal`, so one press closes every modal whose `closeOnEscape` is on. `DialogProvider`
turns it on only for the top dialog (`useIsTopDialog`; the old `useIsLevelFocused` was wrong once a
lower dialog closed), and every dialog's `Modal`/`Drawer` now takes it from the context: the spread,
or `closeOnEscape={dialog.closeOnEscape && …}`, or `false`. The guard's third check holds that, and
`DialogProvider.browser.test.tsx` pins the behaviour.

## A closed dialog plays its exit transition

Added during the build at Briant's request: closing removed the entry from the store at once, so the
`Modal`/`Drawer` unmounted before its exit transition ran. `closeById` now moves the entry from
`dialogs` to `closing`. Everything that reads `dialogs` (open checks, `useIsTopDialog`, Escape) sees it
as closed at once, while `DialogProvider` keeps rendering it with `opened: false` and its last
z-index. It unmounts when the component reports `onExitTransitionEnd` (Mantine's `ModalBase` takes it,
and the `{...dialog}` spread passes it on), or after a 1s fallback. Each open gets its own `instance`
key, so a dialog reopened under the same id while closing is a new one. `closeAll` skips the
transition.

Popovers and menus stay out of the store: they are anchored to a trigger and owned by its component.
Sharing the z-index with them (a layer stack the dialogs hand down) is a separate plan.

## How it ships

One PR, one end-state commit. No flag, phase or shim: nothing outside this repo calls these APIs, and
the change is UI-only with no migration.

1. Add `openDialog`, `openConfirm` and `openAlert`, `Suspense` in `DialogProvider`, and `closeOnConfirm` on `ConfirmDialog`.
2. Convert all four declaration styles and the 136 `openConfirmModal` calls (done by hand, file by file, under shared rules).
3. Routed dialogs: each `*.dialog.ts` keeps only its URL rule (`routedDialog<typeof Modal>({ resolve })`, the modal named through `import type`); `registry.ts` lists them in a plain object; `RoutedDialogProvider` holds the name → component map.
4. Delete the files listed above, swap the stacking checks to `useIsTopDialog`, and update every place in "Places that state how to open a dialog". Then lower the import-cycle guard caps.
5. Add a guard test, `no-unlisted-dialog-open` or folded into an existing one:
   - no new direct `dialogStore.trigger` or `toggle` outside `Dialog/` (a per-file ratchet over the statically imported dialogs);
   - no `@mantine/modals` import anywhere;
   - the files that only read the store with `useDialogStore` stay allowed.

   This turns the rule in `components.md` into a check.

Size: about 300 files, almost all mechanical one- or two-line changes. Per the repo's single-commit
refactor practice, it lands as one diff rather than as stages.

**Verification:**
- `typecheck`, which catches every wrong prop.
- The Dialog browser tests (`DialogProvider.browser.test.tsx`, `RoutedDialogProvider.browser.test.tsx`), plus every test that mocks `dialogStore` or `@mantine/modals`. Find them with `grep -rln "Dialog/dialogStore\|@mantine/modals" src --include=*.test.*`.
- A manual pass on: a confirm opened over a dialog, a routed dialog reopened from its URL on reload, Back closing a routed dialog, and a dialog over the mobile generator.

## Decisions (Briant, 2026-11-20)

1. **Every `@mantine/modals` call moves onto the dialog store in this PR:** `openModal`, `closeModal`, `closeAllModals` and `openContextModal`. `CustomModalsProvider` and its fixed `zIndex: 400` go, which leaves one modal stack.
2. **The 128 files that open a statically imported dialog stay static in this PR.** Making them lazy through `openDialog` is a follow-up PR. Until then they keep calling `dialogStore.trigger`, and the new guard holds them as a ratchet baseline that may only shrink.

## Follow-ups

- The statically imported dialogs (the `no-unlisted-dialog-open` baseline): move them onto `openDialog` and shrink the baseline to empty.
- `src/utils/comic-image-picker.ts` takes its modal as an argument (`openGeneratorImagePicker`); it moves to `openDialog` with that follow-up.
- A store dialog opened from inside a confirm or content dialog would sit behind it (300 + index against their 401 floor). No caller does this today.
- A layer stack for popovers, menus and selects inside dialogs, so they take the z-index above their dialog without one set at the call site. To be planned.
