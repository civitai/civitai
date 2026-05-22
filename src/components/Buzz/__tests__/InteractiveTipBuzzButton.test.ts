import { describe, expect, it } from 'vitest';
import { shouldAbortPressOnLeave } from '~/components/Buzz/InteractiveTipBuzzButton';

/**
 * Regression coverage for the phantom `TipInteractive_Click`/`TipInteractive_Cancel`
 * analytics events (civitai#2307).
 *
 * The full component is a timing-dependent gesture state machine (refs, Mantine
 * `useInterval`, zustand) and the repo has no `@testing-library/react`, so a
 * render test is not added here. Instead the gesture-decision core was extracted
 * into the pure `shouldAbortPressOnLeave()` and is asserted directly — this is
 * the exact branch that decides whether an `onMouseLeave` mid-press emits a
 * phantom event or completes a real tap.
 *
 * `shouldAbortPressOnLeave` returning `true`  => press aborted, NO phantom
 *   `TipInteractive_Click` emitted (and therefore no follow-on phantom Cancel).
 * `shouldAbortPressOnLeave` returning `false` => press completes, the deliberate
 *   tap registers and a real `TipInteractive_Click` is emitted.
 */
describe('shouldAbortPressOnLeave (phantom tip-event suppression)', () => {
  const origin = { x: 100, y: 100 };

  it('does NOT abort (no event) when there is no press in progress', () => {
    // A committed hold / no uncommitted press — onMouseLeave must never abort,
    // so a real hold-and-drift still emits its TipInteractive_Click.
    expect(
      shouldAbortPressOnLeave({
        pressUncommitted: false,
        origin,
        current: { x: 9999, y: 9999 },
      })
    ).toBe(false);
  });

  it('aborts a feed-scroll drag — pointer moved well past the tolerance', () => {
    // Stray pointer event while scrolling a feed: large movement => abort,
    // so NO phantom TipInteractive_Click / TipInteractive_Cancel are emitted.
    expect(
      shouldAbortPressOnLeave({
        pressUncommitted: true,
        origin,
        current: { x: 100, y: 260 }, // 160px vertical drag
      })
    ).toBe(true);
  });

  it('does NOT abort a deliberate quick tap that drifts a few px off the button', () => {
    // Real quick tap whose pointer drifts slightly off the small feed button:
    // movement is within tolerance => the tap is preserved and completes,
    // emitting a genuine TipInteractive_Click. This is the UX regression fixed.
    expect(
      shouldAbortPressOnLeave({
        pressUncommitted: true,
        origin,
        current: { x: 104, y: 103 }, // 5px drift
      })
    ).toBe(false);
  });

  it('does NOT abort when the pointer has not moved at all', () => {
    expect(
      shouldAbortPressOnLeave({
        pressUncommitted: true,
        origin,
        current: { ...origin },
      })
    ).toBe(false);
  });

  it('abort decision is at the tolerance boundary, not before it', () => {
    // Just inside the 10px tolerance radius => kept (deliberate tap preserved).
    expect(
      shouldAbortPressOnLeave({
        pressUncommitted: true,
        origin,
        current: { x: 106, y: 107 }, // ~9.2px
      })
    ).toBe(false);
    // Just outside the 10px tolerance radius => aborted (real drag).
    expect(
      shouldAbortPressOnLeave({
        pressUncommitted: true,
        origin,
        current: { x: 108, y: 108 }, // ~11.3px
      })
    ).toBe(true);
  });

  it('aborts conservatively when the press origin is unknown', () => {
    // Origin could not be captured => drift cannot be measured, so the leave is
    // treated as a real drag and aborted rather than risk a phantom event.
    expect(
      shouldAbortPressOnLeave({
        pressUncommitted: true,
        origin: null,
        current: { x: 101, y: 101 },
      })
    ).toBe(true);
  });

  it('respects a custom tolerance', () => {
    const current = { x: 100, y: 130 }; // 30px drag
    expect(
      shouldAbortPressOnLeave({ pressUncommitted: true, origin, current, tolerance: 10 })
    ).toBe(true);
    expect(
      shouldAbortPressOnLeave({ pressUncommitted: true, origin, current, tolerance: 50 })
    ).toBe(false);
  });
});
