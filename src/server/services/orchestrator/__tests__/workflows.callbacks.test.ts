import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as OrchestrationClient from '@civitai/orchestration-client';

const h = vi.hoisted(() => ({
  getWorkflow: vi.fn(),
  queryWorkflows: vi.fn(),
  submitWorkflow: vi.fn(),
  updateWorkflow: vi.fn(),
}));

vi.mock('@civitai/orchestration-client', async (importOriginal) => ({
  ...(await importOriginal<typeof OrchestrationClient>()),
  getWorkflow: h.getWorkflow,
  queryWorkflows: h.queryWorkflows,
  submitWorkflow: h.submitWorkflow,
  updateWorkflow: h.updateWorkflow,
}));

import {
  getWorkflow,
  queryWorkflows,
  setWorkflowDownloadPriority,
  submitWorkflow,
} from '~/server/services/orchestrator/workflows';

const MARKER = 'CALLBACK-CONFIG-MARKER';
const withCallbacks = () => ({
  id: 'wf-1',
  status: 'succeeded',
  tags: ['civitai'],
  callbacks: [{ url: `https://example.invalid/hook?k=${MARKER}`, type: ['workflow:*'] }],
  steps: [{ $type: 'textToImage', name: 'gen', metadata: { note: 'kept' } }],
});
const expectNoCallbacks = (workflow: unknown) => {
  expect(workflow).not.toHaveProperty('callbacks');
  expect(JSON.stringify(workflow)).not.toContain(MARKER);
  expect(workflow).toMatchObject({ id: 'wf-1', steps: [{ metadata: { note: 'kept' } }] });
};

describe('orchestrator workflow service — callback configuration is not handed on', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.getWorkflow.mockResolvedValue({ data: withCallbacks() });
    h.queryWorkflows.mockResolvedValue({ data: { items: [withCallbacks(), withCallbacks()] } });
    h.submitWorkflow.mockResolvedValue({ data: withCallbacks() });
    h.updateWorkflow.mockResolvedValue({ data: withCallbacks(), response: { ok: true } });
  });

  it('getWorkflow', async () => {
    expectNoCallbacks(await getWorkflow({ token: 't', path: { workflowId: 'wf-1' } }));
  });

  it('queryWorkflows', async () => {
    const { items } = await queryWorkflows({
      token: 't',
      take: 10,
      tags: [],
      hideMatureContent: false,
    });
    expect(items).toHaveLength(2);
    items.forEach(expectNoCallbacks);
  });

  it('submitWorkflow', async () => {
    expectNoCallbacks(await submitWorkflow({ token: 't', body: { steps: [] } as never }));
  });

  it('setWorkflowDownloadPriority', async () => {
    expectNoCallbacks(await setWorkflowDownloadPriority({ token: 't', workflowId: 'wf-1' }));
  });
});
