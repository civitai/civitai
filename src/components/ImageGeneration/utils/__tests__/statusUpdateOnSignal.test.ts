import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Trpc from '~/utils/trpc';
import { POLLABLE_STATUSES } from '~/shared/constants/orchestrator.constants';

const mocks = vi.hoisted(() => ({
  statusUpdate: vi.fn(),
  setQueriesData: vi.fn(),
}));

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof Trpc>()),
  trpcVanilla: { orchestrator: { statusUpdate: { query: mocks.statusUpdate } } },
  queryClient: { setQueriesData: mocks.setQueriesData },
}));

import {
  __resetSignalRefreshes,
  pollWorkflowsStatus,
  recordSignalRefresh,
  updateWorkflowsStatus,
} from '~/components/ImageGeneration/utils/useGenerationSignalUpdate';

// Taken from the production constant: the orchestration client's enum members read as undefined
// under Vitest, so a literal would not be the value the code compares.
const RUNNING = POLLABLE_STATUSES[0];
const IDS = ['wf-a', 'wf-b', 'wf-c'];
const SIGNALED_AT = 1_000_000;

function requestedIds() {
  return mocks.statusUpdate.mock.calls.map(
    ([input]) => (input as { workflowId: string }).workflowId
  );
}

beforeEach(() => {
  mocks.statusUpdate.mockReset();
  mocks.statusUpdate.mockImplementation(async ({ workflowId }: { workflowId: string }) => ({
    id: workflowId,
    status: RUNNING,
    steps: [],
  }));
  __resetSignalRefreshes();
  // Two of the three workflows were just refreshed by a signal.
  recordSignalRefresh(['wf-a', 'wf-b'], SIGNALED_AT);
});

afterEach(() => {
  __resetSignalRefreshes();
});

describe('status-update-on-signal OFF: the poll reads every pollable workflow, as before', () => {
  it('reads all three workflows one millisecond after a signal refreshed two of them', async () => {
    await pollWorkflowsStatus(IDS, false, SIGNALED_AT + 1);
    expect(requestedIds()).toEqual(['wf-a', 'wf-b', 'wf-c']);
  });
});

describe('status-update-on-signal ON: the poll skips a workflow a signal just refreshed', () => {
  it('reads only the unsignaled workflow inside the interval', async () => {
    await pollWorkflowsStatus(IDS, true, SIGNALED_AT + 59_999);
    expect(requestedIds()).toEqual(['wf-c']);
  });

  it('reads all three once a full interval has passed since the signal', async () => {
    await pollWorkflowsStatus(IDS, true, SIGNALED_AT + 60_000);
    expect(requestedIds()).toEqual(['wf-a', 'wf-b', 'wf-c']);
  });

  it('reads every workflow when no signal was recorded', async () => {
    __resetSignalRefreshes();
    await pollWorkflowsStatus(IDS, true, SIGNALED_AT + 1);
    expect(requestedIds()).toEqual(['wf-a', 'wf-b', 'wf-c']);
  });
});

describe('a refresh counts only when the read returned the workflow', () => {
  it('reports the ids whose read returned a workflow, not a failed or empty one', async () => {
    mocks.statusUpdate.mockImplementation(async ({ workflowId }: { workflowId: string }) => {
      if (workflowId === 'wf-b') throw new Error('transient');
      if (workflowId === 'wf-c') return undefined;
      return { id: workflowId, status: RUNNING, steps: [] };
    });
    await expect(updateWorkflowsStatus(IDS)).resolves.toEqual(['wf-a']);
  });
});
