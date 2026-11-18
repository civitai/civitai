import { describe, expect, it } from 'vitest';
import {
  projectAppWorkflow,
  projectAppWorkflowWithPositions,
  snapshotFromWorkflow,
} from '~/server/services/blocks/workflow.service';
import { blockOutputCeilingFromClaims } from '~/server/services/blocks/block-output-restriction';

/**
 * Old-SDK compatibility for outputs held for their rating (#8994's regression).
 *
 * An app built on an SDK that predates `ratingPending` stops polling at the first
 * `succeeded` and keeps the `imageUrls` it carried. #8994 withholds an unrated output
 * on exactly that snapshot, so such an app saved an empty result for a paid
 * generation. The host now reports `processing` while an output is held, and after a
 * bounded wait from the workflow's completion reports the real status with the output
 * still pending, exactly as #8994 sends it. An unrated url is never handed out at any
 * point.
 *
 * Every url is distinct, and the held one is asserted absent from the whole serialised
 * reply, so a leak through any field fails.
 */

// The hold, pinned as a literal (not imported): 5 minutes from completion.
const HOLD_MS = 5 * 60_000;

const ANY_VIEWER = 1 | 2 | 4 | 8 | 16;
// An SFW app token: an unrated output's rating could restrict it, so it is held.
const SFW = {
  ...blockOutputCeilingFromClaims({ maxBrowsingLevel: 1 | 2, viewerBrowsingLevel: ANY_VIEWER }),
  serving: false,
  mint: null,
};

const COMPLETED_AT = '2026-11-17T12:00:00.000Z';
const DONE = Date.parse(COMPLETED_AT);
const HELD_URL = 'https://cdn/held-7f3a.png';

function image(id: string, nsfwLevel: string | null) {
  return {
    id,
    type: 'image',
    url: `https://cdn/${id}.png`,
    available: true,
    width: 512,
    height: 768,
    ...(nsfwLevel === null ? {} : { nsfwLevel }),
  };
}

function wf(
  status: string,
  images: Array<Record<string, unknown>>,
  over: Record<string, unknown> = {}
): Parameters<typeof snapshotFromWorkflow>[0] {
  return {
    id: 'wf_hold',
    createdAt: '2026-11-17T11:58:30.000Z',
    status,
    ...(status === 'succeeded' ? { completedAt: COMPLETED_AT } : {}),
    metadata: {},
    tags: [],
    cost: { total: 8 },
    steps: [{ $type: 'textToImage', name: 's1', status, metadata: {}, output: { images } }],
    ...over,
  } as never;
}

const held = () => ({ ...image('held-7f3a', null) });

function step(name: string, completedAt: string, images: Array<Record<string, unknown>>) {
  return {
    $type: 'textToImage',
    name,
    status: 'succeeded',
    completedAt,
    metadata: {},
    output: { images },
  };
}
const rated = () => ({ ...image('held-7f3a', 'pg') });

describe('a succeeded workflow with an output held for its rating', () => {
  it('reports a NON-terminal status, ratingPending, and no url', () => {
    const workflow = wf('succeeded', [held(), image('ok-21c9', 'pg')]);
    const snap = snapshotFromWorkflow(workflow, SFW, { now: DONE + 3_000 });
    expect(snap.status).toBe('processing');
    expect(snap.ratingPending).toBe(true);
    expect(snap.outputs).toStrictEqual([
      { pending: true },
      { url: 'https://cdn/ok-21c9.png', nsfwLevel: 'pg' },
    ]);
    expect(snap.imageUrls).toStrictEqual(['https://cdn/ok-21c9.png']);
    expect(JSON.stringify(snap)).not.toContain(HELD_URL);

    const listed = projectAppWorkflow(workflow, SFW, { now: DONE + 3_000 });
    expect(listed.status).toBe('processing');
    expect(listed.ratingPending).toBe(true);
    expect(JSON.stringify(listed)).not.toContain(HELD_URL);
  });

  it('still holds one second before the deadline', () => {
    const snap = snapshotFromWorkflow(wf('succeeded', [held()]), SFW, {
      now: DONE + HOLD_MS - 1_000,
    });
    expect(snap.status).toBe('processing');
    expect(snap.outputs).toStrictEqual([{ pending: true }]);
  });

  it('is terminal with the url once the rating lands (invariant guard: true before the fix too)', () => {
    const snap = snapshotFromWorkflow(wf('succeeded', [rated()]), SFW, { now: DONE + 9_000 });
    expect(snap.status).toBe('succeeded');
    expect(snap.imageUrls).toStrictEqual([HELD_URL]);
    expect(snap.outputs).toStrictEqual([{ url: HELD_URL, nsfwLevel: 'pg' }]);
    expect(snap).not.toHaveProperty('ratingPending');
  });

  it('after the deadline: the real status, the output STILL pending (never restricted), no url', () => {
    const workflow = wf('succeeded', [held(), image('ok-21c9', 'pg')]);
    const now = DONE + HOLD_MS + 1_000;
    const snap = snapshotFromWorkflow(workflow, SFW, { now });
    expect(snap.status).toBe('succeeded');
    // Not `{ restricted: true, reason: 'unrated' }`: that reason means no rating will ever
    // come, and a late rating still can.
    expect(snap.outputs).toStrictEqual([
      { pending: true },
      { url: 'https://cdn/ok-21c9.png', nsfwLevel: 'pg' },
    ]);
    expect(snap.imageUrls).toStrictEqual(['https://cdn/ok-21c9.png']);
    expect(snap.ratingPending).toBe(true);
    expect(JSON.stringify(snap)).not.toContain(HELD_URL);

    const { workflow: listed, positions } = projectAppWorkflowWithPositions(workflow, SFW, { now });
    expect(listed.status).toBe('succeeded');
    expect(listed.outputs).toStrictEqual(snap.outputs);
    expect(listed.ratingPending).toBe(true);
    expect(JSON.stringify(listed)).not.toContain(HELD_URL);
    // Publish / post / persist still refuse it as "still being rated".
    expect(positions[0].output).toStrictEqual({ pending: true });
  });

  it('measures the deadline from the LATEST step completion when the workflow has no completedAt', () => {
    const workflow = wf('succeeded', [held()], {
      completedAt: null,
      // The latest (12:10) is neither first nor last, so taking the first step, the last
      // step, the earliest step or createdAt each put the 60s read below past the hold.
      steps: [
        step('s1', '2026-11-17T12:04:00.000Z', [image('first-3b1c', 'pg')]),
        step('s2', '2026-11-17T12:10:00.000Z', [held()]),
        step('s3', '2026-11-17T12:05:30.000Z', [image('last-5e7a', 'pg')]),
      ],
    });
    const stepDone = Date.parse('2026-11-17T12:10:00.000Z');
    // Inside the hold measured from the latest step (12:10, read at 12:11); past it from
    // 12:05:30 (5.5 min), 12:04 (7 min) or createdAt.
    expect(snapshotFromWorkflow(workflow, SFW, { now: stepDone + 60_000 }).status).toBe(
      'processing'
    );
    expect(snapshotFromWorkflow(workflow, SFW, { now: stepDone + HOLD_MS + 1_000 }).status).toBe(
      'succeeded'
    );
  });

  it('is bounded from createdAt when no completion stamp exists at all', () => {
    const workflow = wf('succeeded', [held()], { completedAt: undefined });
    const created = Date.parse('2026-11-17T11:58:30.000Z');
    const late = snapshotFromWorkflow(workflow, SFW, { now: created + HOLD_MS + 1_000 });
    expect(late.status).toBe('succeeded');
    expect(late.outputs).toStrictEqual([{ pending: true }]);
    expect(late.ratingPending).toBe(true);
  });

  it('fails closed on a record with no parseable timestamp: the hold never runs out', () => {
    const workflow = wf('succeeded', [held()], { completedAt: undefined, createdAt: 'garbage' });
    const snap = snapshotFromWorkflow(workflow, SFW, { now: DONE + 365 * 24 * 3_600_000 });
    expect(snap.status).toBe('processing');
    expect(snap.outputs).toStrictEqual([{ pending: true }]);
    expect(JSON.stringify(snap)).not.toContain(HELD_URL);
  });

  it('leaves failed / canceled alone, and a still-running workflow is never cut short', () => {
    for (const status of ['failed', 'canceled'] as const) {
      const snap = snapshotFromWorkflow(wf(status, [held()], { completedAt: COMPLETED_AT }), SFW, {
        now: DONE + 3_000,
      });
      expect(snap.status).toBe(status);
    }
    const running = snapshotFromWorkflow(wf('processing', [held()]), SFW, {
      now: DONE + 60 * 60_000,
    });
    expect(running.status).toBe('processing');
    expect(running.outputs).toStrictEqual([{ pending: true }]);
  });
});

/**
 * Two app poll loops against a timeline of orchestrator states, driven through the real
 * `snapshotFromWorkflow`. The loops are MODELS of the SDKs' documented rules, not the
 * SDKs themselves:
 *  - OLD (app-sdk before `ratingPending`, e.g. Character Sheet Studio's `pollLoop`):
 *    stop at the first terminal status and keep `imageUrls`.
 *  - NEW (`@civitai/blocks-react` `useBuzzWorkflow().watch` and `@civitai/sdk`
 *    `workflows.watch`): keep polling on a non-terminal status; on a terminal one with
 *    `ratingPending` keep polling for up to 2 minutes, else stop.
 */
const TERMINAL = new Set(['succeeded', 'failed', 'expired', 'canceled']);

function timeline(ratedAfterMs: number | null) {
  return (t: number) => {
    if (t < DONE) return wf('processing', []);
    const ratedNow = ratedAfterMs !== null && t >= DONE + ratedAfterMs;
    return wf('succeeded', [ratedNow ? rated() : held()]);
  };
}

function runOldLoop(at: (t: number) => ReturnType<typeof wf>, start: number, everyMs: number) {
  for (let t = start, polls = 1; polls < 10_000; t += everyMs, polls++) {
    const snap = snapshotFromWorkflow(at(t), SFW, { now: t });
    if (TERMINAL.has(snap.status)) return { saved: snap.imageUrls ?? [], snap, t, polls };
  }
  throw new Error('old loop never ended');
}

function runNewLoop(at: (t: number) => ReturnType<typeof wf>, start: number, everyMs: number) {
  const timeoutAt = start + 10 * 60_000;
  let ratingDeadline: number | null = null;
  for (let t = start; t < timeoutAt; t += everyMs) {
    const snap = snapshotFromWorkflow(at(t), SFW, { now: t });
    if (!TERMINAL.has(snap.status)) continue;
    if (snap.ratingPending === true) {
      ratingDeadline ??= t + 2 * 60_000;
      if (t + everyMs < ratingDeadline) continue;
    }
    return { saved: snap.imageUrls ?? [], snap, t };
  }
  return { saved: [] as string[], snap: null, t: timeoutAt };
}

describe('an app polling with the OLD logic', () => {
  it('eventually gets its image when the rating lands after succeeded', () => {
    // Rating lands 7s after the workflow succeeded; the app polls every 2s from before.
    const result = runOldLoop(timeline(7_000), DONE - 4_000, 2_000);
    expect(result.saved).toStrictEqual([HELD_URL]);
    expect(result.snap.status).toBe('succeeded');
  });

  it('stops after the deadline, with the output still pending, when the rating never lands', () => {
    const result = runOldLoop(timeline(null), DONE - 4_000, 2_000);
    expect(result.t).toBeGreaterThanOrEqual(DONE + HOLD_MS);
    expect(result.t).toBeLessThan(DONE + HOLD_MS + 2_000 + 1);
    expect(result.saved).toStrictEqual([]);
    expect(result.snap.outputs).toStrictEqual([{ pending: true }]);
    expect(JSON.stringify(result.snap)).not.toContain(HELD_URL);
  });
});

describe('the NEW SDK watch path is unaffected', () => {
  it('gets the image when the rating lands', () => {
    const result = runNewLoop(timeline(7_000), DONE - 4_000, 1_500);
    expect(result.saved).toStrictEqual([HELD_URL]);
    expect(result.snap?.status).toBe('succeeded');
    expect(result.snap).not.toHaveProperty('ratingPending');
  });

  it('ends on a terminal snapshot (not its own timeout) when the rating never lands', () => {
    const result = runNewLoop(timeline(null), DONE - 4_000, 1_500);
    expect(result.snap?.status).toBe('succeeded');
    expect(result.snap?.outputs).toStrictEqual([{ pending: true }]);
    expect(result.snap?.ratingPending).toBe(true);
    expect(result.t).toBeLessThan(DONE - 4_000 + 10 * 60_000);
  });
});
