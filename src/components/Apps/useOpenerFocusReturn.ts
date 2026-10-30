import { useEffect, useRef } from 'react';

/**
 * Return focus to the element that OPENED a dialog, for dialogs that are members of a
 * Mantine `Modal.Stack`.
 *
 * 🔴 WHY THIS EXISTS: INSIDE A STACK, MANTINE'S OWN `returnFocus` IS BROKEN, AND IT IS
 * BROKEN FOR EVERY MEMBER — MEASURED, NOT INFERRED.
 *
 * `Modal.Stack` gates each member's `trapFocus` on `ctx.currentId === stackId`
 * (`Modal.mjs:53-57`). That value therefore FLIPS while a modal stays open: the stack
 * registers its members from a `useEffect`, so even a lone modal renders once with
 * `currentId === undefined` (trap off) and then again with itself current (trap on),
 * and opening a second member flips the first back off. `useModal` feeds it straight
 * into `useFocusReturn({ opened, shouldReturnFocus: trapFocus && returnFocus })`, whose
 * `useDidUpdate` deps are `[opened, shouldReturnFocus]` — so every flip re-runs that
 * effect while `opened` is still `true`, re-taking the
 * `lastActiveElement.current = document.activeElement` branch and overwriting the
 * opener with whatever holds focus by then (something inside the dialog).
 *
 * Measured with three arms differing only in the wrapper — close the dialog, then read
 * `document.activeElement`:
 *
 *   without `Modal.Stack`                  → the trigger button   ✅
 *   with `Modal.Stack`                     → `<body>`             ❌
 *   with `Modal.Stack` + returnFocus false → `<body>`             ❌ (Mantine simply idle)
 *
 * The third arm is why this hook exists at all: switching Mantine's version off
 * restores nothing by itself.
 *
 * 🔴 THE OTHER DIRECTION IS WEAKER THAN IT LOOKS, AND SAYING SO IS THE POINT. An
 * earlier version of this note claimed that leaving Mantine's `returnFocus` ON would
 * clobber ours, via its 10ms post-close timeout — "neither half works alone". That
 * was reasoning, and a mutation sweep refuted it: with this hook in place, DELETING
 * `returnFocus={false}` left the focus tests GREEN. Only the source gate noticed.
 * So callers still pair the two, but for a weaker and honest reason — one owner of
 * focus return instead of two, with Mantine's corrupted capture left inert rather
 * than racing us in some flow nobody has measured. The gate in
 * `__tests__/appListingScreenshotViewerWiring.test.ts` enforces the convention; it is
 * NOT evidence that both halves are behaviourally load-bearing.
 *
 * THE CAPTURE HAPPENS DURING RENDER — as belt-and-braces, NOT because an effect could
 * not work.
 *
 * 🔴 AN EARLIER VERSION OF THIS PARAGRAPH WAS WRONG, AND WRONG IN THE EXACT WAY THE
 * COMMIT THAT CREATED THIS FILE CLAIMED TO BE PURGING. It asserted, as a 🔴 fact, that
 * "an effect is TOO LATE: React runs child effects before parent effects, so the trap
 * has already moved focus." That is reasoning dressed as measurement, and the mechanism
 * is not what it says: `use-focus-trap.mjs` wraps `focusNode` in `setTimeout` in BOTH
 * its ref callback and its effect, so the focus move is a MACROTASK and necessarily
 * runs after every effect in that commit. Moving the whole capture into a plain
 * `useEffect` was then measured green across the full suite, including a
 * navigate-then-close probe. Effect ordering was never the reason.
 *
 * WHAT IS ACTUALLY TRUE, and why the render-phase read stays:
 *   - At the render that first sees `opened === true`, this commit's DOM mutations have
 *     not happened yet, so `document.activeElement` is unambiguously the element the
 *     user activated. That holds without depending on anything else.
 *   - An effect-phase read gets the same answer TODAY only because Mantine defers its
 *     focus move to a macrotask. That is a property of Mantine's current implementation,
 *     not a guarantee — a future version moving focus synchronously in a layout effect
 *     would break it silently, with no test able to name the cause.
 *   - So: keep the earlier read, which cannot be wrong, rather than the later one, which
 *     is right for a reason outside this repo's control. That is a real justification;
 *     "an effect is too late" was not.
 *
 * Reading `document.activeElement` is a side-effect-free DOM read, and the ref write is
 * the documented "adjusting a ref for a prop transition" shape; a double render cannot
 * corrupt it because the guard means the second pass captures the same element or
 * nothing.
 *
 * 🔴 THE `!prevOpenedRef.current` HALF OF THAT GUARD IS THE WHOLE POINT OF THE HOOK.
 * Without it the capture re-runs on EVERY render while open — which is precisely the
 * Mantine defect this hook replaces, re-created by hand. It is reachable in ordinary
 * use: the viewer re-renders on every arrow-key navigation. Pinned by the
 * `{ArrowRight}` in `AppListingDetailBody.viewer.browser.test.tsx`'s "focus returns to
 * the ORIGINATING tile on close" — open, NAVIGATE, then close. Do not remove that
 * keystroke to "simplify" the test; without it the guard has no killing case.
 */
export function useOpenerFocusReturn(opened: boolean): void {
  const openerRef = useRef<HTMLElement | null>(null);
  const prevOpenedRef = useRef(false);

  if (opened && !prevOpenedRef.current) {
    // `typeof document` because this runs during RENDER and both hosting routes
    // (`/apps/review`, `/apps/store-preview/[slug]`) are server-rendered. No call site
    // passes `opened === true` on a first render today, so the guard is unreachable —
    // but a dialog seeded open from props or a query param would make it a server-side
    // `ReferenceError`, and that is a one-word thing to make impossible.
    openerRef.current =
      typeof document === 'undefined'
        ? null
        : (document.activeElement as HTMLElement | null) ?? null;
  }
  prevOpenedRef.current = opened;

  useEffect(() => {
    if (opened) return;
    const opener = openerRef.current;
    openerRef.current = null;
    // `isConnected` because the opener can legitimately be gone — a queue row that the
    // action just removed, a list that refetched. Focusing a detached node silently
    // moves focus to `<body>`, which is the exact failure this hook exists to prevent,
    // so not restoring at all is the better answer there.
    if (opener?.isConnected) opener.focus({ preventScroll: true });
  }, [opened]);
}
