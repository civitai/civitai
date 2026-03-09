# RoutedDialog System Analysis & Improvement Recommendations

## Context

The RoutedDialog system gives mobile-app-like modal navigation on the web — opening a dialog pushes to browser history so the back button closes it instead of navigating away. This is critical UX for a content-heavy site where modals are used liberally to avoid the overhead of full page transitions in React.

The current implementation works by maintaining a **parallel routing system** (`BrowserRouter`) alongside Next.js's router, using direct `history.pushState()` calls and custom events to synchronize dialog state with the URL. While functional, the system has accumulated several hacks to work around Next.js's routing assumptions.

---

## Current Architecture Summary

```
User clicks RoutedDialogLink
  → triggerRoutedDialog() resolves URL via dialog.resolve()
  → browserRouter.push() calls history.pushState() directly (bypasses Next.js)
  → dispatches custom 'locationchange' event
  → RoutedDialogProvider detects query.dialog change
  → dialogStore.trigger() adds dialog to Zustand store
  → DialogProvider renders dialog component

User clicks back button
  → popstate event → converted to 'locationchange'
  → beforePopState decides: Next.js handles it, or BrowserRouter does
  → RoutedDialogProvider detects dialog removed from query
  → dialogStore.closeById() removes dialog
```

**Key files:**
- [BrowserRouterProvider.tsx](src/components/BrowserRouter/BrowserRouterProvider.tsx) — Parallel router using `history.pushState` directly
- [RoutedDialogProvider.tsx](src/components/Dialog/RoutedDialogProvider.tsx) — Reconciles URL state with dialog store
- [RoutedDialogLink.tsx](src/components/Dialog/RoutedDialogLink.tsx) — Consumer API (`triggerRoutedDialog`, `<RoutedDialogLink>`)
- [ClientHistoryStore.tsx](src/store/ClientHistoryStore.tsx) — Tracks history depth (monkeypatches `history.pushState`)
- [DialogProvider.tsx](src/components/Dialog/DialogProvider.tsx) — Renders dialogs from Zustand store
- [dialogStore.ts](src/components/Dialog/dialogStore.ts) — Zustand store for open dialogs
- [routed-dialog/registry.ts](src/components/Dialog/routed-dialog/registry.ts) — 9 dialog definitions with `resolve()` functions

---

## Issues Identified

### 1. Fragile `url.includes('dialog')` heuristic
[RoutedDialogProvider.tsx:28-31](src/components/Dialog/RoutedDialogProvider.tsx#L28-L31) — The `beforePopState` callback uses `state.url.includes('dialog')` to decide whether Next.js or BrowserRouter handles back navigation. This is a raw substring search on the entire URL — it would false-positive on any URL path containing "dialog" (e.g., `/help/dialog-guide`).

### 2. String throw to abort route changes
[RoutedDialogProvider.tsx:47](src/components/Dialog/RoutedDialogProvider.tsx#L47) — `throw 'nextjs route change aborted'` relies on Next.js internally catching thrown values in `routeChangeStart` handlers. While this is a semi-documented pattern (also used in `catch-navigation.store.ts`), it doesn't emit `routeChangeError`, so other listeners (like loading indicators) don't get notified.

### 3. Module-level mutable state
[BrowserRouterProvider.tsx:150](src/components/BrowserRouter/BrowserRouterProvider.tsx#L150) — `let usingNextRouter = false` is a bare module-level mutable coordinating two separate `useEffect` hooks across two different components. No subscription mechanism, no debugging visibility.

### 4. `toOpen` comparison uses wrong key
[RoutedDialogProvider.tsx:75](src/components/Dialog/RoutedDialogProvider.tsx#L75) — `toOpen` compares `x.name` (e.g., `"imageDetail"`) against `openDialogs` which contains keys in `name_count` format (e.g., `"imageDetail_1"`). The `includes()` never matches, so every render attempts to re-open all dialogs. Works by accident because `dialogStore.trigger` deduplicates by `id`, but it means wasted work on every query change.

### 5. Monkeypatching `history.pushState` unconditionally
[ClientHistoryStore.tsx:66](src/store/ClientHistoryStore.tsx#L66) — Global prototype override of `history.pushState` to track navigation keys, even when the Navigation API is available and already handles this natively. The Navigation API path is already used in `getHasClientHistory()` (line 93), so the monkeypatch is unnecessary for ~80% of users.

### 6. No close animations
[DialogProvider.tsx:30-33](src/components/Dialog/DialogProvider.tsx#L30-L33) — Opening uses a deferred `setTimeout` to set `opened: true`, but closing calls `dialogStore.closeById()` which immediately removes the component. No exit transition is possible.

### 7. Dialog state split between URL and history.state
Each dialog's `resolve()` puts some props in `query` (visible in URL, shareable) and others in `state` (stored in `history.state.state`, invisible, lost on share/refresh/Ctrl+Click). For example, `imageDetail` puts `imageId` in the URL but `images` array and filters in state — recipients of shared links get a degraded experience.

---

## Recommended Improvements

### Tier 1: Quick fixes (independent, low risk, < 30 min each)

**A. Fix `toOpen` comparison**
Change line 75 from `!openDialogs.includes(x.name)` to `!openDialogs.includes(x.key)`. Eliminates wasted `dialogStore.trigger` calls on every query change.

**B. Replace `url.includes('dialog')` with proper query param check**
Add a helper that parses the query string and checks for the `dialog` parameter specifically:
```ts
const hasDialogParam = (url: string) => {
  const qs = url.split('?')[1];
  return qs ? new URLSearchParams(qs).has('dialog') : false;
};
```
Apply at lines 28, 31, and 45 of `RoutedDialogProvider.tsx`.

**C. Align route abort pattern**
Add `Router.events.emit('routeChangeError')` before the throw on line 47, matching the pattern used in `catch-navigation.store.ts`. Add a comment explaining the throw.

**D. Move `usingNextRouter` into Zustand**
Move the flag into `useBrowserRouterState` store. The exported `setUsingNextRouter` keeps the same API; reads use `useBrowserRouterState.getState().usingNextRouter` (synchronous, same timing characteristics).

**E. Guard history monkeypatch behind Navigation API check**
In `ClientHistoryStore`, wrap the `pushState` override in `if (!hasNavigation)`. Skip sessionStorage sync and default key setup when the Navigation API is available. Reduces global mutation surface for the majority of users.

### Tier 2: Medium improvements (2-4 hours each)

**F. Add close animations**
When `onClose` is called, set `opened: false` first, wait for transition duration, then remove from store. Requires coordinating with URL-driven closes from `RoutedDialogProvider` — the reconciliation loop (lines 93-95) should trigger the animated close path rather than calling `closeById` directly. Key consideration: `handleCloseRoutedDialog` calls `browserRouter.back()` which triggers `popstate` → query change → reconciliation → `closeById`. The animation delay needs to happen before `closeById`, not after.

**G. Audit dialog state vs query split**
Review all 9 dialog definitions. For each, ensure props essential for a shared/bookmarked URL experience are in `query`, not `state`. Dialogs should gracefully handle missing `state` when opened via a fresh URL (e.g., `ImageDetailModal` should fetch data if the `images` array isn't in state).

### Tier 3: Structural refactor (4+ hours)

**H. Extract `useRoutedDialogState` hook**
Consolidate dialog URL state logic scattered across `BrowserRouterProvider`, `RoutedDialogProvider`, and `RoutedDialogLink` into a single hook. This hook owns: which dialogs are in the URL, adding/removing dialog params, deciding back() vs push() for close. Consumers (`RoutedDialogLink`, `RoutedDialogProvider`) become thin wrappers.

### Tier 4: Future consideration

**I. Navigation API as primary driver**
When browser support broadens (Firefox is working on it), the Navigation API's `navigate` event could replace the entire `beforePopState` / `routeChangeStart` / custom `locationchange` chain. `navigation.intercept()` provides a clean, standards-based way to handle dialog navigations without fighting Next.js. For now, Improvement E (guarding the monkeypatch) is the right incremental step.

---

## Implementation Order

| # | Improvement | Effort | Risk | Files |
|---|-----------|--------|------|-------|
| 1 | A: Fix `toOpen` comparison | 5 min | None | `RoutedDialogProvider.tsx` |
| 2 | B: Replace `includes('dialog')` | 15 min | Low | `RoutedDialogProvider.tsx` |
| 3 | C: Align route abort pattern | 10 min | None | `RoutedDialogProvider.tsx` |
| 4 | D: Move `usingNextRouter` to store | 20 min | Low | `BrowserRouterProvider.tsx` |
| 5 | E: Guard history monkeypatch | 30 min | Low | `ClientHistoryStore.tsx` |
| 6 | G: Audit state vs query split | 1-2 hr | Low | All 9 `*.dialog.ts` files |
| 7 | F: Close animations | 2-4 hr | Medium | `DialogProvider.tsx`, `RoutedDialogProvider.tsx`, `dialogStore.ts` |
| 8 | H: Extract unified hook | 4-6 hr | Medium | New hook + refactor 3 files |

Items 1-5 are independent and can each be a separate commit. Items 6-8 benefit from the earlier fixes being in place.

---

## Close Animation Design (Improvement F — Detailed)

### Problem

All 112 dialog components consume `useDialogContext()` and spread it onto Mantine's `<Modal {...dialog}>`. Mantine Modal natively supports exit transitions — when `opened` goes `true → false`, it runs a fade-out animation before unmounting. However, the current system never gives the Modal a chance to animate out:

1. `DialogProviderInner.onClose()` calls **both** `dialog.options.onClose()` (URL change for routed dialogs) **and** `dialogStore.closeById(dialog.id)` immediately
2. `closeById` removes the dialog from the Zustand array → React unmounts → no exit transition
3. [PageModal.tsx](src/components/Dialog/Templates/PageModal.tsx) explicitly sets `transitionProps={{ duration: 0 }}` as a workaround

### Current close flow (routed dialogs)

```
User clicks X → DialogProviderInner.onClose()
  → dialog.options.onClose() → handleCloseRoutedDialog(name)
    → browserRouter.back() → popstate → query change (async)
  → dialogStore.closeById(dialog.id) ← INSTANT UNMOUNT (kills animation)

  ... later, asynchronously ...
  → RoutedDialogProvider reconciliation sees dialog missing from URL
  → dialogStore.closeById(key) ← redundant, dialog already gone
```

### Proposed: Two-phase close

Add a `closingIds` set to the dialog store. Instead of removing immediately, mark as closing first, let the animation play, then remove.

**dialogStore changes** ([dialogStore.ts](src/components/Dialog/dialogStore.ts)):
```ts
type DialogStore = {
  dialogs: Dialog[];
  closingIds: Set<string | number | symbol>;  // NEW
  trigger: ...;
  requestClose: (id: string | number | symbol) => void;  // NEW
  finalizeClose: (id: string | number | symbol) => void;  // NEW
  closeById: ...;  // keep for non-animated path (closeAll, etc.)
  closeLatest: ...;
  closeAll: ...;
};

requestClose: (id) => set((state) => {
  if (!state.closingIds.has(id)) state.closingIds.add(id);
}),
finalizeClose: (id) => set((state) => {
  state.closingIds.delete(id);
  state.dialogs = state.dialogs.filter((x) => x.id !== id);
}),
```

**DialogProviderInner changes** ([DialogProvider.tsx](src/components/Dialog/DialogProvider.tsx)):
```tsx
const DialogProviderInner = ({ dialog, index }: { dialog: Dialog; index: number }) => {
  const [mounted, setMounted] = useState(false);
  const isClosing = useDialogStore((state) => state.closingIds.has(dialog.id));
  const opened = mounted && !isClosing;
  const transitionDuration = dialog.options?.transitionDuration ?? 200;

  function onClose() {
    dialog.options?.onClose?.();
    dialogStore.requestClose(dialog.id);  // was: dialogStore.closeById(dialog.id)
  }

  // Open after mount (existing behavior)
  useEffect(() => {
    setTimeout(() => setMounted(true), 0);
  }, []);

  // Finalize close after transition completes
  useEffect(() => {
    if (!isClosing) return;
    const timer = setTimeout(() => {
      dialogStore.finalizeClose(dialog.id);
    }, transitionDuration);
    return () => clearTimeout(timer);
  }, [isClosing, dialog.id, transitionDuration]);

  return (
    <DialogContext.Provider
      value={{ opened, onClose, zIndex: 300 + index, target: dialog.target }}
    >
      <Dialog {...dialog.props} />
    </DialogContext.Provider>
  );
};
```

**RoutedDialogProvider changes** ([RoutedDialogProvider.tsx](src/components/Dialog/RoutedDialogProvider.tsx)):
```ts
// Line 93-95: Use requestClose instead of closeById
for (const key of toClose) {
  dialogStore.requestClose(key);  // was: dialogStore.closeById(key)
}
```

**PageModal changes** ([Templates/PageModal.tsx](src/components/Dialog/Templates/PageModal.tsx)):
- Remove `transitionProps={{ duration: 0 }}` — Mantine Modal will now animate out properly

### How the close flow changes

```
User clicks X → DialogProviderInner.onClose()
  → dialog.options.onClose() → handleCloseRoutedDialog(name)
    → browserRouter.back() → popstate → query change (async)
  → dialogStore.requestClose(dialog.id) → closingIds.add(id)
  → DialogProviderInner re-renders with opened=false
  → Mantine Modal starts exit transition (200ms fade-out)

  ... 200ms later ...
  → setTimeout fires → dialogStore.finalizeClose(dialog.id)
  → Dialog removed from store → component unmounts

  ... async URL reconciliation ...
  → RoutedDialogProvider sees dialog missing from URL
  → dialogStore.requestClose(key) → already in closingIds, no-op
```

### Edge cases

| Case | Handling |
|------|----------|
| **Double-close** | `requestClose` no-ops if id already in `closingIds` |
| **`closeAll` (page navigation)** | Keep as instant — clear both `dialogs` and `closingIds` |
| **Re-open during close animation** | `trigger()` removes id from `closingIds` before pushing, canceling the pending close |
| **Non-routed dialogs** | Same mechanism — `onClose` calls `requestClose`, animation plays, `finalizeClose` removes |
| **Custom transition durations** | Pass via `dialog.options.transitionDuration` when triggering |

### Consumer impact

**Zero changes needed in any of the 112 dialog components.** They already spread `{...dialog}` which includes `opened` — the only difference is that `opened` now transitions to `false` before unmount instead of instant removal. Mantine Modal's built-in transition handles the visual animation.

---

## Verification

- After each Tier 1 change: manually test opening/closing routed dialogs (imageDetail, support), back button, Ctrl+Click, sharing URLs, and navigating between pages with dialogs open
- After close animation changes: verify exit transitions on PageModal (fullscreen: imageDetail), standard modals (support, confirm), and non-routed dialogs (alert, collection-select). Check that back button, X button, and overlay click all animate. Verify `closeAll` still works instantly for page navigation.
- Run `pnpm run typecheck` and `pnpm run lint` after each change
