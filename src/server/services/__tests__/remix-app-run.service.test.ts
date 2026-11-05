import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ImageVisibility from '~/server/services/image-visibility.service';
import type * as InputUrls from '~/server/services/generation-input-urls';
import type * as OrchestrationNew from '~/server/services/orchestrator/orchestration-new.service';
import type * as RemixProvenance from '~/server/services/orchestrator/remix-provenance';
import type * as SystemApps from '~/shared/remix-apps/system-apps';

/**
 * Drives the run service through the REAL `submitPresetImageGen` → `generateFromGraph` path down
 * to a fake orchestrator, so the provenance asserted here is the token the graph actually signed.
 * Harness shape from `orchestration-new.submit-reply-coverage.test.ts`.
 */

type FakeWorkflow = {
  id: string;
  status: string;
  tags: string[];
  metadata?: Record<string, unknown>;
  callbacks?: unknown[];
  allowMatureContent?: boolean;
  externalId?: string;
  createdAt: string;
  steps: { output?: { images: { url: string; available?: boolean }[] } }[];
  cost: { total: number };
};

const h = vi.hoisted(() => ({
  images: new Map<number, Record<string, unknown>>(),
  workflows: [] as FakeWorkflow[],
  /** What the orchestrator's whatIf prices every workflow at. */
  price: 30,
  submitWorkflow: vi.fn(),
  queryWorkflows: vi.fn(),
  assertInputs: vi.fn(async () => undefined),
}));

vi.mock('@civitai/orchestration-client', async () =>
  (await import('~/server/services/orchestrator/__tests__/civitai-client.stub')).civitaiClientStub()
);
vi.mock('~/server/services/orchestrator/workflows', () => ({
  submitWorkflow: h.submitWorkflow,
  queryWorkflows: h.queryWorkflows,
  deleteWorkflow: vi.fn(async () => undefined),
}));
vi.mock('~/server/orchestrator/orchestrator-identity-metrics', () => ({
  observeConsumerMismatch: vi.fn(),
  observeConsumerUnverifiable: vi.fn(),
}));
vi.mock('~/server/services/generation/generation.service', () => ({
  resolveTestingAccess: vi.fn(async () => false),
  getGateRules: vi.fn(async () => []),
  getSelfHostedDisabledEcosystems: vi.fn(() => [] as string[]),
  getResourceData: vi.fn(async (refs: { id: number }[]) =>
    refs.map(({ id }) => ({
      id,
      name: 'Edit engine',
      baseModel: 'NanoBanana',
      air: `urn:air:nanobanana:checkpoint:civitai:1@${id}`,
      model: { id: 1, name: 'Edit engine', type: 'Checkpoint', poi: false },
      availability: 'Public',
      covered: true,
      canGenerate: true,
    }))
  ),
}));
vi.mock('~/server/services/orchestrator/orchestration-new.service', async (importOriginal) => ({
  ...(await importOriginal<typeof OrchestrationNew>()),
  buildGenerationContext: vi.fn(async () => ({
    externalCtx: {
      limits: { maxQuantity: 4, maxResources: 10, vidQuantity: 1 },
      user: { isMember: false, tier: 'free' },
      flags: {},
      selfHostedDisabledEcosystems: [],
      selfHostedMode: 'enabled',
      gateRules: [],
    },
  })),
  bustQueriedWorkflowsCache: vi.fn(async () => undefined),
}));
// The mint is the only route to provenance here: the source url resolves to nothing, as an
// orchestrator blob does for every segment after the first.
vi.mock('~/server/services/orchestrator/remix-provenance', async (importOriginal) => ({
  ...(await importOriginal<typeof RemixProvenance>()),
  resolveSourceImageIds: vi.fn(async () => []),
}));
vi.mock('~/server/services/orchestrator/promptAuditing', () => ({
  auditPromptServer: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/orchestrator/orchestrator.service', () => ({
  createXGuardModerationRequest: vi.fn(async () => undefined),
}));
vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: vi.fn() }));
vi.mock('~/server/db/pgDb', () => ({ pgDbReadLong: {}, pgDbRead: {}, pgDbWrite: {} }));
vi.mock('~/server/db/db-lag-helpers', () => ({
  getDbWithoutLag: vi.fn(),
  getDbWithoutLagBatch: vi.fn(),
  preventReplicationLag: vi.fn(),
}));
vi.mock('~/server/db/datapacketDb', () => ({ datapacketDbRead: {}, datapacketDbWrite: {} }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: {} }));
vi.mock('~/server/search-index', () => ({}));
vi.mock('@civitai/db', () => ({
  createLagTracker: vi.fn(() => ({})),
  loadDbEnv: vi.fn(() => ({})),
}));
vi.mock('~/server/services/image.service', () => ({
  getAllImages: vi.fn(),
  enqueueImageIngestion: vi.fn(),
  imagesForModelVersionsCache: {},
}));
vi.mock('~/server/services/generation-input-urls', async (importOriginal) => ({
  ...(await importOriginal<typeof InputUrls>()),
  assertGenerationInputsUsable: h.assertInputs,
}));
vi.mock('~/server/services/image-visibility.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageVisibility>()),
  assertImageVisibleToViewer: vi.fn(async ({ id }: { id: number }) => {
    if (!h.images.has(id)) throw new TRPCError({ code: 'NOT_FOUND', message: 'No image' });
    return { id, userId: 1, nsfwLevel: 1, postId: null };
  }),
}));
vi.mock('~/shared/remix-apps/system-apps', async (importOriginal) => {
  const real = await importOriginal<typeof SystemApps>();
  const { defineRemixApp } = await import('~/shared/remix-apps/define');
  /** Two workflows with a pick between them: the shape a multi-step app has. */
  const pickThenEdit = defineRemixApp({
    slug: 'pick-then-edit',
    name: 'Pick then edit',
    icon: 'sparkles',
    version: 1,
    engine: real.animeIt.engine,
    async run(ctx) {
      const four = await ctx.workflow({
        kind: 'image',
        prompt: 'four takes',
        images: [ctx.source],
        aspectRatio: 'source',
        quantity: 4,
      });
      const pick = await ctx.ask({ kind: 'pick', prompt: 'Pick one', images: four.images });
      const final = await ctx.workflow({
        kind: 'image',
        prompt: 'polish it',
        images: [four.images[pick]],
        aspectRatio: 'source',
        quantity: 1,
      });
      return final.images;
    },
  });
  return {
    ...real,
    getRuntimeRemixApp: (slug: string) =>
      slug === pickThenEdit.slug ? pickThenEdit : real.getRuntimeRemixApp(slug),
  };
});

import { dbMock } from '~/__tests__/mocks/db.mock';
import { OnboardingSteps } from '~/server/common/enums';
import { verifyProvenance } from '~/server/services/orchestrator/remix-provenance';
import {
  advanceRemixRun,
  listRemixRuns,
  startRemixRun,
} from '~/server/services/remix-app-run.service';
import type { RemixAppCaller } from '~/server/services/remix-app.service';
import { RemixReplayError, replayRemixApp } from '~/shared/remix-apps/replay';

const USER_ID = 1;
const SOURCE_ID = 7;
const blob = (name: string) => `https://orchestration.civitai.com/v2/consumer/blobs/${name}.png`;

function addImage(id: number, over: Record<string, unknown> = {}) {
  h.images.set(id, {
    id,
    url: `ab12cd34-ef56-4a7b-8c9d-0e1f2a3b4c${String(id).padStart(2, '0')}`,
    type: 'image',
    nsfwLevel: 1,
    width: 1200,
    height: 800,
    ingestion: 'Scanned',
    blockedFor: null,
    minor: false,
    poi: false,
    ...over,
  });
}

const caller = (over: Partial<RemixAppCaller> = {}): RemixAppCaller => ({
  user: {
    id: USER_ID,
    isModerator: false,
    tier: 'free',
    showNsfw: true,
    onboarding: OnboardingSteps.Buzz,
    muted: false,
  } as RemixAppCaller['user'],
  token: 'token',
  features: { isGreen: false } as RemixAppCaller['features'],
  isGreenDomain: false,
  isApiCaller: false,
  ...over,
});

const submits = () => h.workflows;
const whatIfs = () =>
  h.submitWorkflow.mock.calls.filter(([args]) => (args as { query?: object }).query);

function finish(workflowId: string, urls: string[]) {
  const workflow = h.workflows.find((w) => w.id === workflowId)!;
  workflow.status = 'succeeded';
  workflow.steps = [{ output: { images: urls.map((url) => ({ url, available: true })) } }];
}

beforeEach(() => {
  vi.clearAllMocks();
  h.images.clear();
  h.workflows = [];
  h.price = 30;
  dbMock.dbRead.image.findUnique.mockImplementation(
    async ({ where }: { where: { id: number } }) => h.images.get(where.id) ?? null
  );
  h.submitWorkflow.mockImplementation(
    async ({ body, query }: { body: Record<string, unknown>; query?: { whatif?: boolean } }) => {
      if (query?.whatif) return { cost: { total: h.price }, steps: [] };
      const existing = h.workflows.find((w) => w.externalId && w.externalId === body.externalId);
      if (existing) return existing;
      const workflow: FakeWorkflow = {
        // `<userId>-<n>`: `assertWorkflowOwner` checks the prefix against the submitter.
        id: `${USER_ID}-2026110500000${h.workflows.length}`,
        status: 'processing',
        tags: body.tags as string[],
        metadata: body.metadata as Record<string, unknown>,
        callbacks: body.callbacks as unknown[],
        allowMatureContent: body.allowMatureContent as boolean | undefined,
        externalId: body.externalId as string | undefined,
        createdAt: new Date(2026, 10, 5, 0, h.workflows.length).toISOString(),
        steps: [],
        cost: { total: h.price },
      };
      h.workflows.push(workflow);
      return workflow;
    }
  );
  h.queryWorkflows.mockImplementation(async ({ tags }: { tags: string[] }) => ({
    items: h.workflows.filter((w) => tags.every((tag) => w.tags.includes(tag))),
  }));
});

describe('remix app runs', () => {
  it('submits Anime it with its run tags, the callbacks and a provenance token for the source', async () => {
    addImage(SOURCE_ID);
    const state = await startRemixRun({
      slug: 'anime-it',
      imageId: SOURCE_ID,
      nonce: 'nonce-0001',
      quote: 30,
      caller: caller(),
    });

    expect(state.status).toBe('running');
    const [workflow] = submits();
    expect(workflow.tags).toEqual(
      expect.arrayContaining([
        'gen',
        'img',
        'remix-app',
        'remix-app:anime-it',
        `remix-run:${state.runId}`,
        'remix-seg:0',
      ])
    );
    expect(workflow.callbacks?.length).toBeGreaterThan(0);
    expect(verifyProvenance(workflow.metadata?.provenance, USER_ID)).toEqual([SOURCE_ID]);
    expect(workflow.metadata?.remixRun).toEqual({ app: 'anime-it', version: 1, answers: [] });
  });

  it('a repeated start of the same tap submits nothing new', async () => {
    addImage(SOURCE_ID);
    const tap = { slug: 'anime-it', imageId: SOURCE_ID, nonce: 'nonce-0002', quote: 30 };
    const first = await startRemixRun({ ...tap, caller: caller() });
    const second = await startRemixRun({ ...tap, caller: caller() });

    expect(second).toEqual(first);
    expect(submits()).toHaveLength(1);
  });

  it('refuses a price above the one that was tapped, before anything is submitted', async () => {
    addImage(SOURCE_ID);
    h.price = 31;
    await expect(
      startRemixRun({
        slug: 'anime-it',
        imageId: SOURCE_ID,
        nonce: 'nonce-0003',
        quote: 30,
        caller: caller(),
      })
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(whatIfs()).toHaveLength(1);
    expect(submits()).toHaveLength(0);
  });

  it('prices the next workflow instead of submitting when no price was tapped', async () => {
    addImage(SOURCE_ID);
    const state = await startRemixRun({
      slug: 'anime-it',
      imageId: SOURCE_ID,
      nonce: 'nonce-0004',
      caller: caller(),
    });
    expect(state).toMatchObject({ status: 'priced', cost: 30 });
    expect(submits()).toHaveLength(0);
  });

  it('refuses a mature source on green through the existing rules', async () => {
    addImage(SOURCE_ID, { nsfwLevel: 8 });
    await expect(
      startRemixRun({
        slug: 'anime-it',
        imageId: SOURCE_ID,
        nonce: 'nonce-0005',
        quote: 30,
        caller: caller({ isGreenDomain: true }),
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(submits()).toHaveLength(0);
  });

  it('stops at an ask, then submits the next segment with the source still proven', async () => {
    addImage(SOURCE_ID);
    const { runId } = await startRemixRun({
      slug: 'pick-then-edit',
      imageId: SOURCE_ID,
      nonce: 'nonce-0006',
      quote: 30,
      caller: caller(),
    });
    expect(await advanceRemixRun({ runId, caller: caller() })).toMatchObject({
      status: 'running',
    });

    const takes = ['a', 'b', 'c', 'd'].map(blob);
    finish(submits()[0].id, takes);
    const asked = await advanceRemixRun({ runId, caller: caller() });
    expect(asked).toMatchObject({
      status: 'ask',
      ask: { kind: 'pick', images: takes.map((url) => ({ url })) },
    });
    expect(submits()).toHaveLength(1);

    await expect(
      advanceRemixRun({ runId, answers: [9], quote: 30, caller: caller() })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    const next = await advanceRemixRun({ runId, answers: [2], quote: 30, caller: caller() });
    expect(next.status).toBe('running');

    const second = submits()[1];
    expect(second.tags).toContain('remix-seg:1');
    expect(second.metadata?.remixRun).toMatchObject({ answers: [2] });
    expect(JSON.stringify(second.metadata)).toContain('polish it');
    expect(verifyProvenance(second.metadata?.provenance, USER_ID)).toEqual([SOURCE_ID]);

    finish(second.id, [blob('final')]);
    expect(await advanceRemixRun({ runId, caller: caller() })).toMatchObject({
      status: 'done',
      outputs: [{ url: blob('final') }],
    });
  });

  it('will not continue a run whose source its signed provenance does not vouch for', async () => {
    addImage(SOURCE_ID);
    addImage(SOURCE_ID + 1);
    const { runId } = await startRemixRun({
      slug: 'pick-then-edit',
      imageId: SOURCE_ID,
      nonce: 'nonce-0007',
      quote: 30,
      caller: caller(),
    });
    finish(submits()[0].id, ['a', 'b'].map(blob));
    // What a user can write through `orchestrator.patch`: the metadata, not the sealed token.
    submits()[0].metadata = { ...submits()[0].metadata, remixOfId: SOURCE_ID + 1 };

    await expect(
      advanceRemixRun({ runId, answers: [0], quote: 30, caller: caller() })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(submits()).toHaveLength(1);
  });

  it('lists runs that are neither posted nor dismissed', async () => {
    addImage(SOURCE_ID);
    const start = (nonce: string) =>
      startRemixRun({ slug: 'anime-it', imageId: SOURCE_ID, nonce, quote: 30, caller: caller() });
    const open = await start('nonce-0008');
    await start('nonce-0009');
    await start('nonce-0010');
    submits()[1].tags.push('remix:done');
    submits()[2].tags.push('remix:dismissed');

    const runs = await listRemixRuns({ caller: caller() });
    expect(runs.map((r) => r.runId)).toEqual([open.runId]);
  });
});

describe('replay', () => {
  const source = { imageId: SOURCE_ID, url: blob('source'), width: 1200, height: 800 };
  const result = (name: string) => ({ workflowId: name, images: [{ url: blob(name) }] });

  it('returns the same next effect from the same log, however often it replays', async () => {
    const app = (await import('~/shared/remix-apps/system-apps')).getRuntimeRemixApp(
      'pick-then-edit'
    )!;
    const log = [
      { type: 'workflow' as const, result: result('takes') },
      { type: 'ask' as const, answer: 0 },
    ];
    const first = await replayRemixApp(app, source, log);
    const second = await replayRemixApp(app, source, log);

    expect(first).toMatchObject({ status: 'effect', index: 2, effect: { type: 'workflow' } });
    expect(second).toEqual(first);
  });

  it('refuses a log that disagrees with what the app asks for', async () => {
    const app = (await import('~/shared/remix-apps/system-apps')).getRuntimeRemixApp(
      'pick-then-edit'
    )!;
    await expect(replayRemixApp(app, source, [{ type: 'ask', answer: 0 }])).rejects.toBeInstanceOf(
      RemixReplayError
    );
  });
});
