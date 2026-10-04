/**
 * `AgentOnboardingCard`'s motion VALUES, extracted so they can be pinned in the `unit` tier —
 * the same move, for the same reason, as `./appsBuildState`.
 *
 * Both claims below were documentation only, and a mutation sweep proved it: flattening the
 * stagger to `delay: 0`, and swapping the entrance to an `opacity` fade, EACH left the whole
 * browser suite green. CI runs no `component` job, so a value only a browser test asserts is
 * a value no check reads. Keep this file free of React and of stylesheet imports, or the
 * guards in `__tests__/agentOnboardingMotion.test.ts` go back to being prose.
 */

/** ~40ms between each row's entrance, in `motion`'s seconds. */
export const STAGGER_SECONDS = 0.04;

/** How long one row takes to settle. */
export const REVEAL_DURATION_SECONDS = 0.3;

/**
 * The entrance's start state.
 *
 * 🔴 `y` ONLY — NEVER `opacity`, AND NEVER A KEY THAT HIDES THE CARD. See the header: framer
 * renders `initial` as a static style, so anything here that makes content invisible is
 * shipped in the server-rendered HTML and stays that way until (or unless) the client takes
 * over. A 6px translate has the same no-layout-shift property — transforms do not reflow —
 * and degrades to "content sits 6px low", which is invisible to a reader and harmless to a
 * crawler. `__tests__/agentOnboardingMotion.test.ts` fails if an opacity key appears.
 */
export const REVEAL_INITIAL = { y: 6 } as const;

/** The entrance's settled state. */
export const REVEAL_ANIMATE = { y: 0 } as const;

/** The transition for the row at `index` — the stagger itself, not just its step size. */
export const revealTransition = (index: number) =>
  ({
    duration: REVEAL_DURATION_SECONDS,
    delay: index * STAGGER_SECONDS,
    ease: 'easeOut',
  } as const);

/** The glyph's scale pop on copy. `scale` is a transform, so it never affects layout. */
export const GLYPH_POP_ANIMATE = { scale: [1, 1.25, 1] } as const;
export const GLYPH_POP_TRANSITION = { duration: 0.28, ease: 'easeOut' } as const;

/**
 * The caret blink.
 *
 * ⚠️ THE ONLY INFINITE ANIMATION LEFT ON `motion` HERE, AND THE ONLY ONE THAT CAN BE. Its
 * key is literally `opacity`, which IS in framer's `acceleratedValues`, and `repeatType:
 * 'reverse'` clears the gate that would force a main-thread animator — so it hands off to
 * `element.animate(…)` and runs compositor-side. See `AgentOnboardingCard`'s header for why
 * that distinction decides which animations may be infinite.
 */
export const CARET_BLINK_ANIMATE = { opacity: [1, 0] } as const;
export const CARET_BLINK_TRANSITION = {
  duration: 0.55,
  repeat: Infinity,
  repeatType: 'reverse',
  ease: 'linear',
} as const;
