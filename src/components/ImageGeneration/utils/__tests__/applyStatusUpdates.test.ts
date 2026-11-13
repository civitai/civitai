import { describe, expect, it } from 'vitest';
import { COMPLETE_STATUSES } from '~/shared/constants/orchestrator.constants';
import { applyStatusUpdates } from '~/components/ImageGeneration/utils/useGenerationSignalUpdate';
import { NSFW_CAPPED, WorkflowData } from '~/shared/orchestrator/workflow-data';

// Taken from the production constant: `@civitai/orchestration-client`'s `WorkflowStatus` members read as
// `undefined` under Vitest, so a literal 'succeeded' would not be the value the code compares.
const FINISHED = COMPLETE_STATUSES[0];
const RUNNING = '__not_a_complete_status__';

const cache = (status: unknown, output: Array<Record<string, unknown>>) =>
  ({
    pages: [
      {
        items: [
          {
            id: 'wf-1',
            status,
            downloadPriority: 'normal',
            steps: [{ name: '$0', status, output }],
          },
        ],
      },
    ],
  } as any);

const update = (status: unknown, output: Array<Record<string, unknown>>) =>
  ({
    id: 'wf-1',
    status,
    downloadPriority: 'high',
    steps: [{ name: '$0', status, output, images: output }],
  } as any);

const unrated = { id: 'b1', type: 'image', available: true };
const rated = { id: 'b1', type: 'image', available: true, nsfwLevel: 'x' };

describe('applyStatusUpdates', () => {
  it('has fixtures the production constant can tell apart', () => {
    expect(COMPLETE_STATUSES).toContain(FINISHED);
    expect(COMPLETE_STATUSES).not.toContain(RUNNING);
  });

  it('writes a rated output onto a workflow that already finished', () => {
    const data = cache(FINISHED, [unrated]);
    applyStatusUpdates(data, [update(FINISHED, [rated])]);

    expect(data.pages[0].items[0].steps[0].output).toEqual([rated]);
  });

  it('does not move a finished workflow back to the status the refetch reports', () => {
    const data = cache(FINISHED, [unrated]);
    applyStatusUpdates(data, [update(RUNNING, [rated])]);

    const item = data.pages[0].items[0];
    expect(item.status).toBe(FINISHED);
    expect(item.steps[0].status).toBe(FINISHED);
    expect(item.downloadPriority).toBe('normal');
  });

  // `updateWorkflowsStatus` passes one list to every cached query holding the workflow.
  it('leaves the update list whole for the next cached query', () => {
    const updates = [update(FINISHED, [rated])];
    const first = cache(FINISHED, [unrated]);
    const second = cache(FINISHED, [unrated]);
    applyStatusUpdates(first, updates);
    applyStatusUpdates(second, updates);

    expect(second.pages[0].items[0].steps[0].output).toEqual([rated]);
  });

  // Without the refetched cap the queue offers a yellow unlock that charges and still serves the
  // blocked placeholder.
  it('takes the NSFW cap a refetch reports, so a capped output offers no unlock', () => {
    const matureRated = { ...rated, nsfwLevel: 'r' };
    const data = cache(FINISHED, [matureRated]);
    data.pages[0].items[0].allowMatureContent = false;
    applyStatusUpdates(data, [{ ...update(FINISHED, [matureRated]), nsfwCap: 'pg13' }]);

    const workflow = new WorkflowData(data.pages[0].items[0], {
      domain: { green: false, blue: false, red: true },
      nsfwEnabled: true,
    } as any);
    expect(workflow.steps[0].output[0].blockedReason).toBe(NSFW_CAPPED);
  });

  it('takes the cap onto a running workflow and keeps it when a refetch reports none', () => {
    const data = cache(RUNNING, [unrated]);
    applyStatusUpdates(data, [{ ...update(RUNNING, [unrated]), nsfwCap: 'pg13' }]);
    expect(data.pages[0].items[0].nsfwCap).toBe('pg13');

    applyStatusUpdates(data, [update(RUNNING, [unrated])]);
    expect(data.pages[0].items[0].nsfwCap).toBe('pg13');
  });

  it('still applies the whole update to a running workflow', () => {
    const data = cache(RUNNING, [unrated]);
    applyStatusUpdates(data, [update(FINISHED, [rated])]);

    const item = data.pages[0].items[0];
    expect(item.status).toBe(FINISHED);
    expect(item.downloadPriority).toBe('high');
    expect(item.steps[0].output).toEqual([rated]);
  });
});
