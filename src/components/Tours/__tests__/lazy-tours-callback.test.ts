import { ACTIONS, EVENTS, STATUS } from 'react-joyride';
import { describe, expect, it } from 'vitest';
import { endReasonFor, nextEvents, tourTargetKey } from '~/components/Tours/joyride-callback';

describe('tourTargetKey', () => {
  it('reduces a selector to the data-tour key the event carries', () => {
    expect(tourTargetKey('[data-tour="gen:remix"]')).toBe('gen:remix');
  });

  it('falls back to the raw target for anything else', () => {
    expect(tourTargetKey('body')).toBe('body');
    expect(tourTargetKey(undefined)).toBe('unknown');
  });
});

describe('endReasonFor', () => {
  it('separates a finish from a skip', () => {
    expect(endReasonFor(STATUS.FINISHED, ACTIONS.NEXT)).toBe('finished');
    expect(endReasonFor(STATUS.SKIPPED, ACTIONS.SKIP)).toBe('skipped');
  });

  /**
   * The X and Esc used to land on the same persisted state as a finish, so a
   * dismissal and a completion were indistinguishable in the data.
   */
  it('separates a dismissal from both', () => {
    expect(endReasonFor(STATUS.RUNNING, ACTIONS.CLOSE)).toBe('closed');
  });
});

describe('the events that advance a step', () => {
  /**
   * TARGET_NOT_FOUND sat in `nextEvents` beside STEP_AFTER, so a step whose target
   * was absent was indistinguishable from the user clicking Next: the step vanished,
   * the progress counter jumped, and nothing was recorded. `model:download` sat dead
   * that way from #1964 until 2026-08-27.
   */
  it('no longer treats a missing target as a click on Next', () => {
    expect(nextEvents).toContain(EVENTS.STEP_AFTER);
    expect(nextEvents).not.toContain(EVENTS.TARGET_NOT_FOUND);
  });
});
