import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Workflows from '~/server/services/orchestrator/workflows';
import type * as CacheHelpers from '~/server/utils/cache-helpers';

// 🔴 Do NOT mock `~/env/server` here — see `deprecated-rewards.gate.test.ts` for why importing
// `orchestrator.router` relies on the canonical env mock.

type FakeWorkflow = { id: string; status: string; tags: string[]; steps: []; metadata: object };

// A fake orchestrator LIST over `h.workflows`: cursor = start index. It ignores `excludeTags`
// unless `h.honorExcludeTags` is set, so the filter must hold whichever way the real one behaves.
const h = vi.hoisted(() => ({
  workflows: [] as FakeWorkflow[],
  honorExcludeTags: false,
  calls: [] as { tags?: string[]; excludeTags?: string[]; cursor?: string }[],
  cacheKeys: [] as string[],
}));

// Pass-through cache that records the key, so the Queue and the pickers can be told apart.
vi.mock('~/server/utils/cache-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof CacheHelpers>()),
  fetchThroughCache: vi.fn(async (key: string, fetchFn: () => Promise<unknown>) => {
    h.cacheKeys.push(key);
    return fetchFn();
  }),
}));

// Faked at our orchestrator read (`queryWorkflows`), which prepends 'civitai' to the tags.
vi.mock('~/server/services/orchestrator/workflows', async (importOriginal) => ({
  ...(await importOriginal<typeof Workflows>()),
  queryWorkflows: vi.fn(
    async (query: { tags?: string[]; excludeTags?: string[]; cursor?: string; take?: number }) => {
      h.calls.push(query);
      if (h.calls.length > 50) throw new Error('runaway paging');
      const start = Number(query.cursor ?? 0);
      const take = query.take ?? 20;
      const pool = h.workflows.filter(
        (w) =>
          (query.tags ?? []).every((t) => w.tags.includes(t)) &&
          !(h.honorExcludeTags && w.tags.some((t) => query.excludeTags?.includes(t)))
      );
      const items = pool.slice(start, start + take);
      const next = start + take < pool.length ? String(start + take) : undefined;
      return { items, nextCursor: next };
    }
  ),
}));
vi.mock('~/server/orchestrator/get-orchestrator-token', () => ({
  getOrchestratorToken: vi.fn(async () => 'token'),
}));

import { orchestratorRouter } from '~/server/routers/orchestrator.router';
import { OnboardingSteps } from '~/server/common/enums';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { WORKFLOW_TAGS } from '~/shared/constants/generation.constants';

const caller = () =>
  orchestratorRouter.createCaller({
    user: {
      id: 7,
      onboarding: OnboardingSteps.Buzz,
      emailVerified: new Date('2020-01-01'),
      muted: false,
      bannedAt: null,
      showNsfw: false,
    },
    ip: '1.2.3.4',
    features: {},
    acceptableOrigin: true,
    tokenScope: TokenScope.Full,
    apiKeyId: null,
  } as never);

const workflow = (id: string, tags: string[]): FakeWorkflow => ({
  id,
  status: 'succeeded',
  tags: ['civitai', ...tags],
  steps: [],
  metadata: {},
});
// What `buildWorkflowTags` stamps on a dev-tunnel App Block run (synthetic appId).
const appRun = (id: string) =>
  workflow(id, [
    WORKFLOW_TAGS.GENERATION,
    WORKFLOW_TAGS.IMAGE,
    WORKFLOW_TAGS.APP_BLOCK,
    'app-block:ephemeral-demo',
  ]);
const generation = (id: string) => workflow(id, [WORKFLOW_TAGS.GENERATION, WORKFLOW_TAGS.IMAGE]);

const ids = (r: { items: { id: string }[] }) => r.items.map((w) => w.id);

describe('orchestrator.queryGeneratedImages — App Block runs and the generator Queue', () => {
  beforeEach(() => {
    h.workflows = [];
    h.honorExcludeTags = false;
    h.calls = [];
    h.cacheKeys = [];
  });

  it.each([false, true])(
    'the Queue input leaves app runs out and keeps generations (orchestrator honours excludeTags: %s)',
    async (honor) => {
      h.honorExcludeTags = honor;
      h.workflows = [appRun('app-1'), generation('gen-1'), appRun('app-2'), generation('gen-2')];
      const result = await caller().queryGeneratedImages({
        tags: [WORKFLOW_TAGS.GENERATION],
        excludeAppWorkflows: true,
        take: 20,
      });
      expect(ids(result)).toEqual(['gen-1', 'gen-2']);
      expect(h.calls[0].excludeTags).toEqual([WORKFLOW_TAGS.APP_BLOCK]);
    }
  );

  it('without the Queue input (the pickers), app runs are still returned', async () => {
    h.workflows = [appRun('app-1'), generation('gen-1')];
    const result = await caller().queryGeneratedImages({
      tags: [WORKFLOW_TAGS.GENERATION],
      take: 20,
    });
    expect(ids(result)).toEqual(['app-1', 'gen-1']);
    expect(h.calls[0].excludeTags).toBeUndefined();
  });

  it('the Queue and a picker with otherwise equal input do not share a cached page', async () => {
    h.workflows = [appRun('app-1'), generation('gen-1')];
    const input = { tags: [WORKFLOW_TAGS.GENERATION], take: 20 };
    await caller().queryGeneratedImages({ ...input, excludeAppWorkflows: true });
    await caller().queryGeneratedImages(input);
    expect(h.cacheKeys).toHaveLength(2);
    expect(h.cacheKeys[0]).not.toEqual(h.cacheKeys[1]);
  });

  it('a first page of only app runs reads on to the generations behind it', async () => {
    h.workflows = [appRun('app-1'), appRun('app-2'), appRun('app-3'), generation('gen-1')];
    const result = await caller().queryGeneratedImages({
      tags: [WORKFLOW_TAGS.GENERATION],
      excludeAppWorkflows: true,
      take: 2,
    });
    expect(ids(result)).toEqual(['gen-1']);
    expect(h.calls).toHaveLength(2);
  });

  it('stops reading on after a bounded number of empty pages and hands back the cursor', async () => {
    h.workflows = [
      ...Array.from({ length: 40 }, (_, i) => appRun(`app-${i}`)),
      generation('gen-1'),
    ];
    const result = await caller().queryGeneratedImages({
      tags: [WORKFLOW_TAGS.GENERATION],
      excludeAppWorkflows: true,
      take: 2,
    });
    expect(result.items).toEqual([]);
    expect(result.nextCursor).toBeDefined();
    expect(h.calls.length).toBeLessThan(10);
  });
});
