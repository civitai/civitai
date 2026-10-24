import { describe, expect, it } from 'vitest';
import {
  applyPreparationEvent,
  mergeSignaledStep,
} from '~/components/ImageGeneration/utils/useGenerationSignalUpdate';

/**
 * The merge copies field by field, so a field it omits never refreshes between page loads however
 * fresh the refetch was. `queuePosition` drives the position and ETA on the queue card.
 */

const cachedStep = (over: Record<string, unknown> = {}) =>
  ({
    status: 'processing',
    completedAt: null,
    errors: undefined,
    queuePosition: {
      support: 'available',
      precedingJobs: 9,
      estimatedStartAt: '2026-01-01T00:00:00Z',
    },
    output: [],
    ...over,
  } as Parameters<typeof mergeSignaledStep>[0]);

const update = (over: Record<string, unknown> = {}) =>
  ({
    name: 'step-1',
    status: 'processing',
    completedAt: null,
    output: [],
    images: [],
    errors: undefined,
    ...over,
  } as Parameters<typeof mergeSignaledStep>[1]);

describe('mergeSignaledStep', () => {
  it('advances queuePosition from the refetched step', () => {
    const step = cachedStep();
    mergeSignaledStep(
      step,
      update({
        queuePosition: {
          support: 'available',
          precedingJobs: 2,
          estimatedStartAt: '2026-01-01T00:05:00Z',
        },
      })
    );

    expect(step.queuePosition?.precedingJobs).toBe(2);
    expect(step.queuePosition?.estimatedStartAt).toBe('2026-01-01T00:05:00Z');
  });

  it('clears queuePosition once the step leaves the queue', () => {
    const step = cachedStep();
    mergeSignaledStep(step, update({ status: 'succeeded', queuePosition: undefined }));

    expect(step.queuePosition).toBeUndefined();
  });

  const preparation = (queuePosition: number) => ({
    resource: 'urn:air:sdxl:checkpoint:civitai:1@2',
    queuePosition,
    lane: 'normal',
    etaSeconds: 300,
    boostedEtaSeconds: 60,
    resources: [],
  });

  it('advances preparation from the refetched step', () => {
    const step = cachedStep({ preparation: preparation(4) });
    mergeSignaledStep(step, update({ preparation: preparation(1) }));

    expect(step.preparation?.queuePosition).toBe(1);
  });

  // A stale preparation keeps the download status and the Boost button on a card whose downloads
  // have already finished.
  it('clears preparation once the downloads finish', () => {
    const step = cachedStep({ preparation: preparation(0) });
    mergeSignaledStep(step, update({ preparation: undefined }));

    expect(step.preparation).toBeUndefined();
  });

  it('still merges the fields it always did', () => {
    const step = cachedStep({ output: [{ id: 'a', url: 'old' }] });
    mergeSignaledStep(
      step,
      update({
        status: 'succeeded',
        completedAt: '2026-01-01T00:09:00Z',
        errors: ['boom'],
        output: [{ id: 'a', url: 'new' }],
      })
    );

    expect(step.status).toBe('succeeded');
    expect(step.completedAt).toBe('2026-01-01T00:09:00Z');
    expect(step.errors).toEqual(['boom']);
  });

  // The fixture order deliberately disagrees with the update's: an order-aligned one cannot tell
  // merge-by-id from merge-by-index, and by-index is the bug this loop exists to avoid.
  it('merges output by id, appends unseen ones, and keeps cached items the update omits', () => {
    const step = cachedStep({
      output: [
        { id: 'b', url: 'old-b' },
        { id: 'a', url: 'old-a' },
      ],
    });
    mergeSignaledStep(
      step,
      update({
        output: [
          { id: 'a', url: 'new-a' },
          { id: 'c', url: 'fresh-c' },
        ],
      })
    );

    const out = step.output as { id?: string | null; url?: string }[];
    expect(out.map((x) => x.id)).toEqual(['b', 'a', 'c']);
    expect(out[0].url).toBe('old-b');
    expect(out[1].url).toBe('new-a');
    expect(out[2].url).toBe('fresh-c');
  });
});

describe('applyPreparationEvent', () => {
  const preparation = (queuePosition: number) => [
    { resource: 'urn:air:sdxl:checkpoint:civitai:1@2', sizeBytes: 1, lane: 'low', queuePosition },
  ];

  const cache = (over: Record<string, unknown> = {}) =>
    ({
      pages: [
        {
          items: [
            {
              id: 'wf-1',
              steps: [
                {
                  name: 'step-1',
                  status: 'unassigned',
                  preparation: { queuePosition: 9 },
                  ...over,
                },
              ],
            },
          ],
        },
      ],
    } as any);

  const event = (over: Record<string, unknown> = {}) =>
    ({ workflowId: 'wf-1', name: 'step-1', status: 'unassigned', ...over } as Parameters<
      typeof applyPreparationEvent
    >[1]);

  // The point of the whole function: progress lands without a workflow refetch.
  it('writes progress onto the cached step and asks for no refetch', () => {
    const data = cache();

    expect(applyPreparationEvent(data, event({ preparation: preparation(2) }))).toBe('applied');
    expect(data.pages[0].items[0].steps[0].preparation.queuePosition).toBe(2);
  });

  it('asks for a refetch when the step status also changed', () => {
    const data = cache();

    expect(
      applyPreparationEvent(data, event({ status: 'processing', preparation: preparation(0) }))
    ).toBe('needs-refetch');
  });

  it('asks for a refetch when the workflow is not in this cache page', () => {
    expect(applyPreparationEvent(cache(), event({ workflowId: 'wf-other' }))).toBe('needs-refetch');
  });

  it('clears the cached preparation when the event carries a malformed list', () => {
    const data = cache();

    applyPreparationEvent(data, event({ preparation: [{ resource: 'x' }] }));
    expect(data.pages[0].items[0].steps[0].preparation).toBeUndefined();
  });
});
