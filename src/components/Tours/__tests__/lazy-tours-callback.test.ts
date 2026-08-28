import { ACTIONS, EVENTS, LIFECYCLE, STATUS } from 'react-joyride';
import type { CallBackProps } from 'react-joyride';
import { describe, expect, it, vi } from 'vitest';
import {
  createTourCallback,
  endReasonFor,
  nextEvents,
  tourTargetKey,
  type TourCallbackDeps,
} from '~/components/Tours/joyride-callback';

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
  it('no longer treats a missing target as a click on Next', () => {
    expect(nextEvents).toContain(EVENTS.STEP_AFTER);
    expect(nextEvents).not.toContain(EVENTS.TARGET_NOT_FOUND);
  });
});

function makeDeps(overrides: Partial<TourCallbackDeps> = {}) {
  const pauseTour = vi.fn();
  const closeTour = vi.fn();
  const runTour = vi.fn();
  const emit = { start: vi.fn(), step: vi.fn(), end: vi.fn() };
  const deps = {
    activeTour: 'content-generation',
    steps: [],
    trigger: 'auto',
    pauseTour,
    closeTour,
    runTour,
    emit,
    ...overrides,
  } as unknown as TourCallbackDeps;
  return { deps, pauseTour, closeTour, runTour, emit };
}

function callbackData(overrides: Partial<CallBackProps>): CallBackProps {
  return {
    action: ACTIONS.NEXT,
    controlled: false,
    index: 0,
    lifecycle: LIFECYCLE.COMPLETE,
    origin: null,
    size: 1,
    status: STATUS.RUNNING,
    step: { target: '[data-tour="gen:remix"]' } as CallBackProps['step'],
    type: EVENTS.STEP_AFTER,
    ...overrides,
  } as CallBackProps;
}

describe('createTourCallback', () => {
  /**
   * Revert check: reintroducing `closeTour({ reason: 'failed' })` in the catch
   * block makes the `closeTour` assertion below fail.
   */
  it('advances and records resolved:false when a step hook rejects, without ending the tour', async () => {
    const onNext = vi.fn().mockRejectedValue(new Error('boom'));
    const { deps, closeTour, runTour, emit } = makeDeps();
    const callback = createTourCallback(deps);

    await callback(
      callbackData({
        type: EVENTS.STEP_AFTER,
        action: ACTIONS.NEXT,
        index: 2,
        step: { target: '[data-tour="gen:remix"]', data: { onNext } } as CallBackProps['step'],
      })
    );

    expect(closeTour).not.toHaveBeenCalled();
    expect(runTour).toHaveBeenCalledWith({ step: 3 });
    expect(emit.step).toHaveBeenCalledWith(
      expect.objectContaining({ index: 2, target: 'gen:remix', resolved: false })
    );
  });

  /**
   * Revert check: moving this branch after the `nextEvents.includes(type)` check
   * makes `runTour` get called instead — CLOSE arrives with `type: STEP_AFTER`.
   */
  it('closes on ACTIONS.CLOSE even though Joyride reports it as STEP_AFTER, and does not advance', async () => {
    const { deps, closeTour, runTour } = makeDeps();
    const callback = createTourCallback(deps);

    await callback(callbackData({ type: EVENTS.STEP_AFTER, action: ACTIONS.CLOSE, index: 1 }));

    expect(closeTour).toHaveBeenCalledWith({ reason: 'closed' });
    expect(runTour).not.toHaveBeenCalled();
  });

  it('advances past a missing target without running the step hook', async () => {
    const onNext = vi.fn();
    const { deps, runTour, emit } = makeDeps({
      steps: new Array(6).fill({}) as unknown as TourCallbackDeps['steps'],
    });
    const callback = createTourCallback(deps);

    await callback(
      callbackData({
        type: EVENTS.TARGET_NOT_FOUND,
        action: ACTIONS.NEXT,
        index: 4,
        step: { target: '[data-tour="model:download"]', data: { onNext } } as CallBackProps['step'],
      })
    );

    expect(onNext).not.toHaveBeenCalled();
    expect(runTour).toHaveBeenCalledWith({ step: 5 });
    expect(emit.step).toHaveBeenCalledWith(
      expect.objectContaining({ index: 4, target: 'model:download', resolved: false })
    );
  });

  /**
   * Revert check: removing the `isLastStep` clamp makes this fail at the
   * `runTour` assertion below — Joyride is controlled here, so advancing past
   * the last index leaves it rendering `steps[5]` (undefined) and never fires
   * TOUR_END, which is how a tour on `gen:post` could go unpersisted forever.
   */
  it('closes the tour instead of advancing when the last step\'s target is missing', async () => {
    const { deps, closeTour, runTour, emit } = makeDeps({
      steps: new Array(5).fill({}) as unknown as TourCallbackDeps['steps'],
    });
    const callback = createTourCallback(deps);

    await callback(
      callbackData({
        type: EVENTS.TARGET_NOT_FOUND,
        action: ACTIONS.NEXT,
        index: 4,
        step: { target: '[data-tour="gen:post"]' } as CallBackProps['step'],
      })
    );

    expect(closeTour).toHaveBeenCalledWith({ reason: 'finished' });
    expect(runTour).not.toHaveBeenCalled();
    expect(emit.step).toHaveBeenCalledWith(
      expect.objectContaining({ index: 4, target: 'gen:post', resolved: false })
    );
    expect(emit.end).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'content-generation', index: 4, reason: 'finished' })
    );
  });

  it('emits waitMs when a step hook ran, and omits the key entirely when there was none', async () => {
    const onNext = vi.fn().mockResolvedValue(undefined);
    const { deps, emit } = makeDeps();
    const callback = createTourCallback(deps);

    await callback(
      callbackData({
        type: EVENTS.STEP_AFTER,
        action: ACTIONS.NEXT,
        index: 0,
        step: { target: '[data-tour="gen:submit"]', data: { onNext } } as CallBackProps['step'],
      })
    );
    expect(emit.step.mock.calls[0][0]).toHaveProperty('waitMs');

    emit.step.mockClear();
    await callback(
      callbackData({
        type: EVENTS.STEP_AFTER,
        action: ACTIONS.NEXT,
        index: 1,
        step: { target: '[data-tour="gen:select"]' } as CallBackProps['step'],
      })
    );
    expect(emit.step.mock.calls[0][0]).not.toHaveProperty('waitMs');
  });

  it('emits tour_start with the stepCount taken from the injected steps array', async () => {
    const { deps, emit } = makeDeps({ steps: [{}, {}, {}] as unknown as TourCallbackDeps['steps'] });
    const callback = createTourCallback(deps);

    await callback(
      callbackData({
        type: EVENTS.TOUR_START,
        action: ACTIONS.START,
        index: 0,
        step: {} as CallBackProps['step'],
      })
    );

    expect(emit.start).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'content-generation', trigger: 'auto', stepCount: 3 })
    );
  });
});
