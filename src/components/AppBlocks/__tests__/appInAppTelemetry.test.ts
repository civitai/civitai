import { beforeEach, describe, expect, it, vi } from 'vitest';

const { enqueued, flushes } = vi.hoisted(() => ({
  enqueued: [] as unknown[],
  flushes: [] as boolean[],
}));
vi.mock('~/components/TrackView/trackEventBuffer', () => ({
  enqueueTrackEvent: (event: unknown) => enqueued.push(event),
  flushTrackEvents: (viaBeacon = false) => flushes.push(viaBeacon),
}));

import {
  createAppSessionTracker,
  reportAppSubmitError,
  reportAppSubmitResult,
  sendAppSession,
} from '~/components/AppBlocks/appInAppTelemetry';
import { trackBatchEventSchema } from '~/server/schema/track.schema';
import {
  APP_SESSION_MAX_COUNT,
  APP_SESSION_MAX_DURATION_MS,
} from '~/shared/constants/app-telemetry.constants';

beforeEach(() => {
  enqueued.length = 0;
  flushes.length = 0;
});

/**
 * The SEAM: what the host emits must be what `/api/track/batch` accepts. One rejected event
 * fails its whole batch, so every emitted event is parsed with the server's own batch schema.
 */
function expectAllAccepted() {
  for (const event of enqueued) {
    const parsed = trackBatchEventSchema.safeParse(event);
    expect(parsed.success, JSON.stringify(event)).toBe(true);
  }
}

describe('App_Error', () => {
  it('a thrown ecosystem refusal is queued with its bounded reason and no message text', () => {
    const err = Object.assign(
      new Error('Validation failed: ecosystem: Ecosystem is currently unavailable'),
      { data: { code: 'BAD_REQUEST' } }
    );
    reportAppSubmitError('apb_app1', 'submit', err);
    expect(enqueued).toEqual([
      {
        kind: 'action',
        data: {
          type: 'App_Error',
          details: { appBlockId: 'apb_app1', reason: 'ecosystem_unavailable', stage: 'submit' },
        },
      },
    ]);
    expect(JSON.stringify(enqueued)).not.toContain('Ecosystem is currently');
    expectAllAccepted();
  });

  it('a RETURNED failed snapshot is an error; a successful one is not', () => {
    reportAppSubmitResult('apb_app1', 'submit', {
      snapshot: { workflowId: 'wf_1', status: 'unassigned' },
    });
    expect(enqueued).toEqual([]);
    reportAppSubmitResult('apb_app1', 'confirmed_step_submit', {
      snapshot: {
        workflowId: 'failed',
        status: 'failed',
        error: 'insufficient buzz budget: estimate 25 exceeds budget 5',
      },
    });
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({
      data: { details: { reason: 'insufficient_buzz', stage: 'confirmed_step_submit' } },
    });
    expectAllAccepted();
  });

  it('an app id that is not platform-shaped is never sent (it would fail the batch)', () => {
    reportAppSubmitError('not an id; <script>', 'submit', new Error('x'));
    reportAppSubmitError('', 'submit', new Error('x'));
    expect(enqueued).toEqual([]);
  });
});

describe('App_Session', () => {
  function clock(start = 1_000) {
    let t = start;
    return { now: () => t, advance: (ms: number) => (t += ms) };
  }

  it('counts VISIBLE time only, plus submits and inbound messages', () => {
    const c = clock();
    const s = createAppSessionTracker({
      appBlockId: 'apb_app1',
      host: 'page',
      visible: true,
      now: c.now,
    });
    c.advance(4_000);
    s.setVisible(false);
    c.advance(60_000); // hidden: not counted
    s.setVisible(true);
    c.advance(1_500);
    s.countSubmit();
    s.countSubmit();
    for (let i = 0; i < 7; i++) s.countMessage();
    expect(s.end()).toEqual({
      appBlockId: 'apb_app1',
      host: 'page',
      durationMs: 5_500,
      submits: 2,
      messagesToHost: 7,
    });
  });

  it('ends once: a second end (unmount after pagehide) returns null', () => {
    const c = clock();
    const s = createAppSessionTracker({
      appBlockId: 'apb_a',
      host: 'iframe',
      visible: true,
      now: c.now,
    });
    c.advance(10);
    expect(s.end()).not.toBeNull();
    expect(s.end()).toBeNull();
  });

  it('records nothing for a mount that was never visible and heard nothing', () => {
    const c = clock();
    const s = createAppSessionTracker({
      appBlockId: 'apb_a',
      host: 'page',
      visible: false,
      now: c.now,
    });
    c.advance(5_000);
    expect(s.end()).toBeNull();
  });

  it('clamps to the schema bounds instead of producing an event the batch would reject', () => {
    const c = clock();
    const s = createAppSessionTracker({
      appBlockId: 'apb_a',
      host: 'page',
      visible: true,
      now: c.now,
    });
    c.advance(APP_SESSION_MAX_DURATION_MS * 3);
    for (let i = 0; i < APP_SESSION_MAX_COUNT + 5; i++) s.countMessage();
    const details = s.end()!;
    expect(details.durationMs).toBe(APP_SESSION_MAX_DURATION_MS);
    expect(details.messagesToHost).toBe(APP_SESSION_MAX_COUNT);
    sendAppSession(details);
    expectAllAccepted();
  });

  it('is sent immediately by BEACON, so it survives the navigation that ended it', () => {
    sendAppSession({
      appBlockId: 'apb_a',
      host: 'iframe',
      durationMs: 1234,
      submits: 1,
      messagesToHost: 3,
    });
    expect(enqueued).toEqual([
      {
        kind: 'action',
        data: {
          type: 'App_Session',
          details: {
            appBlockId: 'apb_a',
            host: 'iframe',
            durationMs: 1234,
            submits: 1,
            messagesToHost: 3,
          },
        },
      },
    ]);
    expect(flushes).toEqual([true]);
    expectAllAccepted();
  });

  it('a schema-out-of-range event is REJECTED by the batch schema (negative control for the seam check)', () => {
    const bad = {
      kind: 'action',
      data: {
        type: 'App_Session',
        details: {
          appBlockId: 'apb_a',
          host: 'page',
          durationMs: APP_SESSION_MAX_DURATION_MS + 1,
          submits: 0,
          messagesToHost: 0,
        },
      },
    };
    expect(trackBatchEventSchema.safeParse(bad).success).toBe(false);
    const freeText = {
      kind: 'action',
      data: {
        type: 'App_Error',
        details: {
          appBlockId: 'apb_a',
          reason: 'Ecosystem is currently unavailable',
          stage: 'submit',
        },
      },
    };
    expect(trackBatchEventSchema.safeParse(freeText).success).toBe(false);
  });
});
