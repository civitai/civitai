import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Workflow } from '@civitai/orchestration-client';

/**
 * The app-activity read (`app-activity.service.ts`): owner-only (an app that is not the user's own
 * dev app answers null and reads nothing), each part read as THAT user and filtered on THAT app
 * (a pre-approval app by its synthetic id), and a part that fails named rather than failing all.
 */

const m = vi.hoisted(() => ({
  resolve: vi.fn<(blockId: string, userId: number) => Promise<unknown>>(),
  invocations: vi.fn<(opts: Record<string, unknown>) => Promise<unknown>>(),
  token: vi.fn<(userId: number) => Promise<string>>(),
  workflows: vi.fn<(query: Record<string, unknown>) => Promise<unknown>>(),
  errors: vi.fn<(opts: { userId: number; blockId: string }) => Promise<unknown[]>>(),
}));

vi.mock('~/server/services/block-registry.service', () => ({
  BlockRegistry: { resolveDevPageBlockForAuthor: m.resolve },
}));
vi.mock('~/server/services/blocks/user-app-surface.service', () => ({
  listMyScopeInvocations: m.invocations,
}));
vi.mock('~/server/orchestrator/get-orchestrator-token', () => ({ getOrchestratorToken: m.token }));
vi.mock('~/server/services/orchestrator/workflows', () => ({ queryWorkflows: m.workflows }));
vi.mock('~/server/services/app-assistant/preview-errors.service', () => ({
  readPreviewErrors: m.errors,
}));

const { generationOf, readAppActivity, workflowError } = await import(
  '~/server/services/app-assistant/app-activity.service'
);

const NOW = Date.parse('2026-10-30T12:00:00.000Z');
// Pairwise-distinct: user ids, app ids and slugs share no characters' meaning.
const OWNER = 5103;
const OTHER = 6207;
const SLUG = 'slideshow';
const EPHEMERAL = {
  appBlockId: `ephemeral-${SLUG}`,
  appId: `ephemeral-${SLUG}`,
  blockId: SLUG,
  status: 'ephemeral',
};
const OWNED = {
  appBlockId: 'apb_01J0OWNED',
  appId: 'oauth-client-77',
  blockId: SLUG,
  status: 'approved',
};

function workflow(over: Partial<Workflow> & Record<string, unknown> = {}): Workflow {
  return {
    id: 'wf-1',
    createdAt: '2026-10-30T11:56:00.000Z',
    completedAt: '2026-10-30T11:57:00.000Z',
    status: 'succeeded',
    metadata: {},
    tags: [],
    arguments: {},
    steps: [],
    callbacks: [],
    tips: {},
    cost: { total: 12 },
    upgradeMode: 'manual',
    currencies: [],
    forceRefunded: false,
    ...over,
  } as unknown as Workflow;
}

beforeEach(() => {
  vi.clearAllMocks();
  m.resolve.mockImplementation(async (blockId, userId) =>
    userId === OWNER && blockId === SLUG ? EPHEMERAL : null
  );
  m.invocations.mockResolvedValue({ items: [], nextCursor: null });
  m.token.mockResolvedValue('orch-token-owner');
  m.workflows.mockResolvedValue({ items: [], nextCursor: undefined });
  m.errors.mockResolvedValue([]);
});

describe('readAppActivity', () => {
  it('answers null for an app that is not the user’s own, and reads nothing of it', async () => {
    expect(await readAppActivity({ userId: OTHER, blockId: SLUG, now: NOW })).toBeNull();
    expect(m.resolve).toHaveBeenCalledWith(SLUG, OTHER);
    expect(m.invocations).not.toHaveBeenCalled();
    expect(m.token).not.toHaveBeenCalled();
    expect(m.errors).not.toHaveBeenCalled();
  });

  it('reads a pre-approval app’s calls by its synthetic id, as the user, and its generations by its tag', async () => {
    m.invocations.mockResolvedValue({
      items: [
        {
          id: '9',
          createdAt: new Date('2026-10-30T11:59:00.000Z'),
          appBlockId: null,
          scope: 'ai:write:budgeted',
          endpoint: '/api/v1/blocks/workflows/poll',
          statusCode: 200,
        },
      ],
      nextCursor: null,
    });
    m.workflows.mockResolvedValue({ items: [workflow()], nextCursor: undefined });
    m.errors.mockResolvedValue([
      {
        kind: 'error',
        at: '2026-10-30T11:58:00.000Z',
        source: 'error',
        fatal: false,
        message: 'boom',
        stack: null,
      },
    ]);
    const activity = await readAppActivity({ userId: OWNER, blockId: SLUG, now: NOW });
    expect(m.invocations).toHaveBeenCalledWith({
      userId: OWNER,
      syntheticAppId: 'ephemeral-slideshow',
      limit: 100,
    });
    expect(m.token).toHaveBeenCalledWith(OWNER);
    expect(m.workflows).toHaveBeenCalledWith(
      expect.objectContaining({
        token: 'orch-token-owner',
        tags: ['app-block:ephemeral-slideshow'],
        fromDate: new Date('2026-10-30T10:00:00.000Z'),
      })
    );
    expect(m.errors).toHaveBeenCalledWith({ userId: OWNER, blockId: SLUG });
    expect(activity?.items.map((item) => item.kind)).toEqual(['call', 'error', 'generation']);
    expect(activity?.summary).toBe(
      '1 generation: 1 succeeded (last 3 min ago); 0 failed; 0 in progress; 1 error'
    );
    expect(activity?.unavailable).toEqual([]);
  });

  it('reads an app of the user’s with a row by its AppBlock id and its OAuth client’s tag', async () => {
    m.resolve.mockResolvedValue(OWNED);
    await readAppActivity({ userId: OWNER, blockId: SLUG, now: NOW });
    expect(m.invocations).toHaveBeenCalledWith({
      userId: OWNER,
      appBlockId: 'apb_01J0OWNED',
      limit: 100,
    });
    expect(m.workflows).toHaveBeenCalledWith(
      expect.objectContaining({ tags: ['app-block:oauth-client-77'] })
    );
  });

  it('names a part that could not be read and still returns the rest', async () => {
    m.token.mockRejectedValue(new Error('This account has been restricted'));
    m.errors.mockRejectedValue(new Error('redis down'));
    const activity = await readAppActivity({ userId: OWNER, blockId: SLUG, now: NOW });
    expect(activity?.unavailable).toEqual(['generations', 'errors']);
    expect(activity?.summary).toBe(
      '0 generations: 0 succeeded; 0 failed; 0 in progress; 0 errors (could not read: generations, errors)'
    );
  });
});

describe('a workflow as an activity item', () => {
  it('carries its status, times, image count and cost', () => {
    expect(
      generationOf(
        workflow({
          id: 'wf-77',
          status: 'scheduled',
          completedAt: null,
          cost: { total: 30 } as Workflow['cost'],
        })
      )
    ).toEqual({
      kind: 'generation',
      at: '2026-10-30T11:56:00.000Z',
      workflowId: 'wf-77',
      status: 'pending',
      completedAt: null,
      imageCount: 0,
      cost: 30,
      error: null,
    });
  });

  it('says which step failed and why an output was blocked, as far as the orchestrator says', () => {
    const failed = workflow({
      status: 'failed',
      steps: [
        { $type: 'textToImage', name: 'gen', status: 'failed' },
        {
          $type: 'textToImage',
          name: 'gen2',
          status: 'succeeded',
          output: { images: [{ id: 'b', available: false, blockedReason: 'minor-detected' }] },
        },
      ] as unknown as Workflow['steps'],
    });
    expect(workflowError(failed, 'failed')).toBe(
      'step gen (textToImage) failed; output blocked: minor-detected'
    );
    // Nothing in the answer to say why: the status alone.
    expect(workflowError(workflow({ status: 'expired' }), 'expired')).toBe('workflow expired');
    expect(workflowError(workflow(), 'succeeded')).toBeNull();
  });
});
