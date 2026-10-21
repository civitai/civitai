import { describe, it, expect, vi } from 'vitest';
import type { Workflow } from '@civitai/orchestration-client';

// `assertUnlockReleasesOutput` refuses unless the workflow it reads has `allowMatureContent: false`,
// so a read that dropped the field would refuse every unlock. Only the HTTP client is faked here:
// the site's own `getWorkflow` wrapper, which the guard reads through, runs for real.
vi.mock('@civitai/orchestration-client', () => ({
  addWorkflowTag: vi.fn(),
  deleteWorkflow: vi.fn(),
  getWorkflow: vi.fn(),
  patchWorkflow: vi.fn(),
  queryWorkflows: vi.fn(),
  removeWorkflowTag: vi.fn(),
  submitWorkflow: vi.fn(),
  updateWorkflow: vi.fn(),
  handleError: vi.fn(),
  createCivitaiClient: vi.fn().mockReturnValue({
    getConfig: () => ({ baseUrl: 'https://orchestration.civitai.com' }),
  }),
}));

import { getWorkflow as clientGetWorkflow } from '@civitai/orchestration-client';
import { getWorkflow } from '../workflows';

/** A consumer-workflow response for a safe-Buzz, PG-13-capped generation with one mature output. */
const response = {
  id: '5-20261019-1',
  createdAt: '2026-10-19T20:00:00Z',
  completedAt: '2026-10-19T20:00:30Z',
  status: 'succeeded',
  metadata: {},
  tags: ['gen'],
  arguments: {},
  callbacks: [],
  tips: { civitai: 0, creators: 0 },
  cost: { base: 4, factors: {}, fixed: {}, total: 4, tips: { civitai: 0, creators: 0 } },
  nsfwLevel: 'pg13',
  allowMatureContent: false,
  upgradeMode: 'manual',
  steps: [
    {
      $type: 'imageGen',
      name: '$0',
      status: 'succeeded',
      priority: 'normal',
      input: { engine: 'flux' },
      output: {
        images: [
          { id: 'a.jpeg', available: true, nsfwLevel: 'pg', url: 'https://x/a.jpeg' },
          { id: 'b.jpeg', available: true, nsfwLevel: 'x', url: 'https://x/b.jpeg' },
        ],
      },
    },
  ],
} satisfies Partial<Workflow>;

describe('workflows.getWorkflow', () => {
  it('keeps the fields the unlock guard reads', async () => {
    vi.mocked(clientGetWorkflow).mockResolvedValue({
      data: response,
      error: undefined,
      response: { ok: true, status: 200 },
    } as never);

    const workflow = await getWorkflow({ token: 't', path: { workflowId: response.id } });

    expect(workflow.allowMatureContent).toBe(false);
    expect(workflow.nsfwLevel).toBe('pg13');
    expect((workflow.steps?.[0] as { output?: unknown }).output).toEqual(response.steps[0].output);
  });
});
