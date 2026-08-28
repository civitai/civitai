import { describe, expect, it, vi } from 'vitest';
import {
  emitTourEnd,
  emitTourStart,
  emitTourStep,
  TOUR_END_EVENT,
  TOUR_START_EVENT,
  TOUR_STEP_EVENT,
} from '~/utils/faro/tour';

describe('emitTourStart', () => {
  it('stringifies every attribute, including the step count', () => {
    const pushEvent = vi.fn();
    emitTourStart({ key: 'content-generation', trigger: 'auto', stepCount: 12 }, { pushEvent });

    expect(pushEvent).toHaveBeenCalledTimes(1);
    expect(pushEvent).toHaveBeenCalledWith(TOUR_START_EVENT, {
      key: 'content-generation',
      trigger: 'auto',
      stepCount: '12',
      sampleRate: '1',
    });
  });
});

describe('emitTourStep', () => {
  it('carries resolved=false, the field the whole change exists for', () => {
    const pushEvent = vi.fn();
    emitTourStep(
      { key: 'auction', index: 2, target: 'auction:info', resolved: false },
      { pushEvent }
    );

    expect(pushEvent).toHaveBeenCalledWith(TOUR_STEP_EVENT, {
      key: 'auction',
      index: '2',
      target: 'auction:info',
      resolved: 'false',
      sampleRate: '1',
    });
  });

  it('omits waitMs entirely when the step awaited nothing', () => {
    const pushEvent = vi.fn();
    emitTourStep({ key: 'auction', index: 0, target: 'auction:nav', resolved: true }, { pushEvent });

    expect(pushEvent.mock.calls[0][1]).not.toHaveProperty('waitMs');
  });

  it('includes waitMs when the step awaited an element', () => {
    const pushEvent = vi.fn();
    emitTourStep(
      { key: 'auction', index: 0, target: 'auction:nav', resolved: true, waitMs: 1450 },
      { pushEvent }
    );

    expect(pushEvent.mock.calls[0][1]).toMatchObject({ waitMs: '1450' });
  });
});

describe('emitTourEnd', () => {
  it('records the reason and the step it ended on', () => {
    const pushEvent = vi.fn();
    emitTourEnd({ key: 'model-page', index: 5, reason: 'skipped' }, { pushEvent });

    expect(pushEvent).toHaveBeenCalledWith(TOUR_END_EVENT, {
      key: 'model-page',
      index: '5',
      reason: 'skipped',
      sampleRate: '1',
    });
  });
});

describe('every emitter', () => {
  it('is a no-op when Faro is absent rather than throwing', () => {
    expect(() =>
      emitTourStart({ key: 'welcome', trigger: 'url', stepCount: 3 }, { pushEvent: undefined })
    ).not.toThrow();
  });

  /**
   * A tour must survive its own telemetry. Without the try/catch a transport
   * that throws would propagate into the Joyride callback and end the tour —
   * the exact failure this change exists to remove.
   */
  it('swallows a throwing transport', () => {
    const pushEvent = vi.fn(() => {
      throw new Error('transport down');
    });

    expect(() => emitTourEnd({ key: 'auction', index: 1, reason: 'failed' }, { pushEvent })).not.toThrow();
  });
});
