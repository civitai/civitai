import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ImageVisibility from '~/server/services/image-visibility.service';
import type * as InputUrls from '~/server/services/generation-input-urls';
import type * as CacheHelpers from '~/server/utils/cache-helpers';
import type * as OrchestrationNew from '~/server/services/orchestrator/orchestration-new.service';
import type * as RemixProvenance from '~/server/services/orchestrator/remix-provenance';
import type { RemixImage } from '~/shared/remix-apps/define';
import type * as Registry from '~/server/services/remix-app-registry.service';

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
  /** As the orchestrator returns them: `$type` decides whether images sit under `images` or `blobs`. */
  steps: {
    $type?: string;
    name?: string;
    status?: string;
    output?: Record<
      string,
      { url: string; available?: boolean; nsfwLevel?: string; [field: string]: unknown }[]
    >;
  }[];
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
  headlessPost: vi.fn(),
  patchTags: vi.fn(),
  patchWorkflows: vi.fn(),
  /** What the whatIf prices an upscale at, apart from every other workflow. */
  upscalePrice: 12,
  /** sysRedis, where the option prices are cached. */
  sys: new Map<string, string>(),
}));

vi.mock('@civitai/orchestration-client', async () => ({
  ...(
    await import('~/server/services/orchestrator/__tests__/civitai-client.stub')
  ).civitaiClientStub(),
  // Read by `isMature`; the stub's placeholder would make every level non-mature.
  NsfwLevel: { PG: 'pg', PG13: 'pg13', R: 'r', X: 'x', XXX: 'xxx', NA: 'na' },
}));
vi.mock('~/server/services/orchestrator/workflows', () => ({
  submitWorkflow: h.submitWorkflow,
  queryWorkflows: h.queryWorkflows,
  deleteWorkflow: vi.fn(async () => undefined),
  getWorkflow: vi.fn(async ({ path }: { path: { workflowId: string } }) =>
    h.workflows.find((w) => w.id === path.workflowId)
  ),
  patchWorkflowTags: h.patchTags,
  patchWorkflows: h.patchWorkflows,
}));
vi.mock('~/server/services/headless-post.service', () => ({
  createHeadlessPost: h.headlessPost,
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
    status: { mode: 'enabled' },
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
vi.mock('~/server/utils/cache-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof CacheHelpers>()),
  fetchThroughCache: async (_key: string, fetch: () => Promise<unknown>) => fetch(),
  setFetchThroughCache: async () => undefined,
}));
vi.mock('~/server/services/remix-app-registry.service', async (importOriginal) => {
  const real = await importOriginal<typeof Registry>();
  const { defineRemixApp } = await import('~/shared/remix-apps/define');
  const { DEFAULT_ENGINE } = await import('~/shared/constants/remix-apps.constants');
  /** Two workflows with a pick between them: the shape a multi-step app has. */
  const pickThenEdit = defineRemixApp({
    slug: 'pick-then-edit',
    name: 'Pick then edit',
    icon: 'sparkles',
    version: 1,
    engine: DEFAULT_ENGINE,
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
  /** One workflow after another, more than a run may hold. */
  const endless = defineRemixApp({
    slug: 'endless',
    name: 'Endless',
    icon: 'sparkles',
    version: 1,
    engine: DEFAULT_ENGINE,
    async run(ctx) {
      let images: RemixImage[] = [ctx.source];
      for (let i = 0; i < 20; i++) {
        const result = await ctx.workflow({
          kind: 'image',
          prompt: `pass ${i}`,
          images: [images[0]],
          aspectRatio: 'source',
          quantity: 1,
        });
        images = result.images;
      }
      return images;
    },
  });
  /** Asks before it has run anything: there is no workflow to keep the answer on. */
  const asksFirst = defineRemixApp({
    slug: 'asks-first',
    name: 'Asks first',
    icon: 'sparkles',
    version: 1,
    engine: DEFAULT_ENGINE,
    async run(ctx) {
      const style = await ctx.ask({
        kind: 'choice',
        prompt: 'Style?',
        options: [{ value: 'anime', label: 'Anime' }],
      });
      const { images } = await ctx.workflow({
        kind: 'image',
        prompt: style,
        images: [ctx.source],
        aspectRatio: 'source',
        quantity: 1,
      });
      return images;
    },
  });
  /** A choice straight after its first workflow: a run whose recorded state stops at a choice. */
  const thenChoose = defineRemixApp({
    slug: 'then-choose',
    name: 'Then choose',
    icon: 'sparkles',
    version: 1,
    engine: DEFAULT_ENGINE,
    async run(ctx) {
      const { images } = await ctx.workflow({
        kind: 'image',
        prompt: 'one take',
        images: [ctx.source],
        aspectRatio: 'source',
        quantity: 1,
      });
      const finish = await ctx.ask({
        kind: 'choice',
        prompt: 'Finish it',
        options: [
          { value: 'upscale', label: 'Upscale' },
          { value: 'keep', label: 'Keep' },
        ],
      });
      if (finish === 'keep') return images;
      return (await ctx.workflow({ kind: 'upscale', image: images[0], scale: 2 })).images;
    },
  });
  /** Slips a url no workflow of the run made into its pick and its outputs. */
  const foreign = { url: 'https://example.com/not-from-this-run.png' };
  const smuggles = defineRemixApp({
    slug: 'smuggles',
    name: 'Smuggles',
    icon: 'sparkles',
    version: 1,
    engine: DEFAULT_ENGINE,
    async run(ctx) {
      const { images } = await ctx.workflow({
        kind: 'image',
        prompt: 'one take',
        images: [ctx.source],
        aspectRatio: 'source',
        quantity: 1,
      });
      await ctx.ask({ kind: 'pick', prompt: 'Pick one', images: [...images, foreign] });
      return [...images, foreign];
    },
  });
  /** A choice about its one take, then one about a url no workflow of the run made. */
  const aboutTake = defineRemixApp({
    slug: 'about-take',
    name: 'About take',
    icon: 'sparkles',
    version: 1,
    engine: DEFAULT_ENGINE,
    async run(ctx) {
      const { images } = await ctx.workflow({
        kind: 'image',
        prompt: 'one take',
        images: [ctx.source],
        aspectRatio: 'source',
        quantity: 1,
      });
      const options = [{ value: 'ok', label: 'OK' }];
      await ctx.ask({ kind: 'choice', prompt: 'This one?', options, image: images[0] });
      await ctx.ask({ kind: 'choice', prompt: 'That one?', options, image: foreign });
      return images;
    },
  });
  const apps = new Map(
    [pickThenEdit, endless, asksFirst, thenChoose, smuggles, aboutTake].map((app) => [
      app.slug,
      app,
    ])
  );
  // Apps with shapes no row has, beside the real registry (the seed, or the rows a test serves).
  return {
    ...real,
    getRegisteredRemixApp: async (slug: string, opts: { allowDisabled: boolean }) => {
      const app = apps.get(slug);
      return app ? { app } : real.getRegisteredRemixApp(slug, opts);
    },
  };
});

import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { OnboardingSteps } from '~/server/common/enums';
import { verifyProvenance } from '~/server/services/orchestrator/remix-provenance';
import {
  advanceRemixRun,
  MAX_RUN_SEGMENTS,
  postRemixResult,
  startRemixRun,
} from '~/server/services/remix-app-run.service';
import type { RemixAppCaller } from '~/server/services/remix-app.service';
import { RemixReplayError, replayRemixApp } from '~/shared/remix-apps/replay';
import { auditPromptServer } from '~/server/services/orchestrator/promptAuditing';
import { SEED_REMIX_APPS } from '~/shared/remix-apps/seed';
import { REMIX_ENGINES } from '~/shared/constants/remix.constants';

const NANO_V2_LITE = REMIX_ENGINES.edit.safe.modelVersionId;

const restyleSpec = SEED_REMIX_APPS.find((app) => app.slug === 'restyle')!.spec as unknown as {
  asks: [{ maxLength: number }, { options: { value: string }[] }];
};
const RESTYLE_EXTRA_MAX_LENGTH = restyleSpec.asks[0].maxLength;
const RESTYLE_STYLES = restyleSpec.asks[1].options;

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

/** Lands a workflow's outputs in the shape the orchestrator returns for its graph. */
function finish(workflowId: string, urls: string[], nsfwLevel: Record<string, string> = {}) {
  const workflow = h.workflows.find((w) => w.id === workflowId)!;
  workflow.status = 'succeeded';
  const blobs = urls.map((url) => ({ url, available: true, nsfwLevel: nsfwLevel[url] }));
  workflow.steps = [
    // img2img:upscale runs as a comfy step, whose output is `blobs`, not `images`.
    workflow.tags.includes('img2img:upscale')
      ? { $type: 'comfy', output: { blobs: blobs.map((b) => ({ ...b, type: 'image' })) } }
      : { $type: 'imageGen', output: { images: blobs } },
  ];
}

/** A pick-then-edit run stopped at its pick, with four takes. */
async function runToPick(nonce: string, viewer = caller()) {
  addImage(SOURCE_ID);
  const { runId } = await startRemixRun({
    slug: 'pick-then-edit',
    imageId: SOURCE_ID,
    nonce,
    quote: 30,
    caller: viewer,
  });
  const takes = ['a', 'b', 'c', 'd'].map(blob);
  // Rated, so the pick is shown to every viewer.
  finish(submits()[0].id, takes, Object.fromEntries(takes.map((url) => [url, 'pg'])));
  return runId;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.images.clear();
  h.workflows = [];
  h.price = 30;
  // No rows yet: the registry serves the seed.
  dbMock.dbWrite.appBlock.findMany.mockResolvedValue([]);
  dbMock.dbRead.image.findUnique.mockImplementation(
    async ({ where }: { where: { id: number } }) => h.images.get(where.id) ?? null
  );
  h.submitWorkflow.mockImplementation(
    async ({ body, query }: { body: Record<string, unknown>; query?: { whatif?: boolean } }) => {
      if (query?.whatif) {
        const upscale = JSON.stringify(body).includes('upscale');
        return { cost: { total: upscale ? h.upscalePrice : h.price }, steps: [] };
      }
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
  h.headlessPost.mockResolvedValue({ postId: 500, imageIds: [1], deduped: false });
  h.patchTags.mockResolvedValue(undefined);
  h.upscalePrice = 12;
  const { sys } = h;
  sys.clear();
  redisMock.sysRedis.get.mockImplementation((async (key: string) => sys.get(key) ?? null) as never);
  redisMock.sysRedis.set.mockImplementation((async (key: string, value: string) => {
    sys.set(key, value);
    return 'OK';
  }) as never);
  // `add` at /metadata/remixRun/<key>: the one patch the run service writes.
  h.patchWorkflows.mockImplementation(
    async ({
      input,
    }: {
      input: { workflowId: string; patches: { path: string; value: unknown }[] }[];
    }) => {
      for (const { workflowId, patches } of input) {
        const workflow = h.workflows.find((w) => w.id === workflowId)!;
        for (const { path, value } of patches) {
          const key = path.replace('/metadata/remixRun/', '');
          (workflow.metadata!.remixRun as Record<string, unknown>)[key] = value;
        }
      }
    }
  );
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
    // The queue's topic, and the remix topic the tray listens on instead of every generation's.
    expect(
      (workflow.callbacks as { url: string }[]).map(({ url }) => url.split('/').pop())
    ).toEqual(['orchestrator:text-to-image-update', 'orchestrator:remix-app-update']);
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

  it('refuses a price raised after the ask, and submits nothing for that step', async () => {
    const runId = await runToPick('nonce-0011');
    expect(await advanceRemixRun({ runId, caller: caller() })).toMatchObject({ status: 'ask' });

    h.price = 31;
    await expect(
      advanceRemixRun({ runId, answers: [1], quote: 30, caller: caller() })
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(submits()).toHaveLength(1);

    // The same answer at the new price goes through.
    await expect(
      advanceRemixRun({ runId, answers: [1], quote: 31, caller: caller() })
    ).resolves.toMatchObject({ status: 'running' });
    expect(submits()).toHaveLength(2);
  });

  it.each(['failed', 'expired', 'canceled'])('a %s step ends the run as failed', async (status) => {
    const runId = await runToPick(`nonce-${status}`);
    submits()[0].status = status;
    await expect(
      advanceRemixRun({ runId, answers: [0], quote: 30, caller: caller() })
    ).resolves.toMatchObject({ status: 'failed', reason: `This step ${status}.` });
    expect(submits()).toHaveLength(1);
  });

  it('a step with no usable output ends the run as failed', async () => {
    const runId = await runToPick('nonce-0012');
    submits()[0].steps = [
      { $type: 'imageGen', output: { images: [{ url: blob('gone'), available: false }] } },
    ];
    await expect(
      advanceRemixRun({ runId, answers: [0], quote: 30, caller: caller() })
    ).resolves.toMatchObject({ status: 'failed', reason: 'This step has no usable output.' });
    expect(submits()).toHaveLength(1);
  });

  it('asks first without submitting, then records the answer on the first workflow', async () => {
    addImage(SOURCE_ID);
    const args = { slug: 'asks-first', imageId: SOURCE_ID, nonce: 'nonce-0019', caller: caller() };

    const ask = await startRemixRun({ ...args, quote: 30 });
    expect(ask).toMatchObject({ status: 'ask', ask: { kind: 'choice' } });
    expect(submits()).toHaveLength(0);

    const running = await startRemixRun({ ...args, answers: ['anime'], quote: 30 });
    expect(running).toMatchObject({ status: 'running' });
    expect(submits()).toHaveLength(1);
    expect(submits()[0].metadata?.remixRun).toMatchObject({ answers: ['anime'] });

    // The run replays from its workflow alone: the answer lives there, and a repeat tap reloads it.
    finish(submits()[0].id, [blob('styled')]);
    const { runId } = running as { runId: string };
    expect(await advanceRemixRun({ runId, caller: caller() })).toMatchObject({ status: 'done' });
    expect(await startRemixRun({ ...args, answers: ['anime'], quote: 30 })).toMatchObject({
      status: 'done',
    });
    expect(submits()).toHaveLength(1);
  });

  it(`stops a run at ${MAX_RUN_SEGMENTS} steps`, async () => {
    addImage(SOURCE_ID);
    const { runId } = await startRemixRun({
      slug: 'endless',
      imageId: SOURCE_ID,
      nonce: 'nonce-0013',
      quote: 30,
      caller: caller(),
    });
    for (let i = 1; i < MAX_RUN_SEGMENTS; i++) {
      finish(submits()[i - 1].id, [blob(`pass-${i}`)]);
      await advanceRemixRun({ runId, quote: 30, caller: caller() });
    }
    expect(submits()).toHaveLength(MAX_RUN_SEGMENTS);

    finish(submits()[MAX_RUN_SEGMENTS - 1].id, [blob('last')]);
    await expect(advanceRemixRun({ runId, quote: 30, caller: caller() })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(submits()).toHaveLength(MAX_RUN_SEGMENTS);
  });

  it('will not continue a run started on another version of the app', async () => {
    const runId = await runToPick('nonce-0014');
    const meta = submits()[0].metadata!;
    submits()[0].metadata = { ...meta, remixRun: { ...(meta.remixRun as object), version: 2 } };
    await expect(
      advanceRemixRun({ runId, answers: [0], quote: 30, caller: caller() })
    ).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('app changed') });
    expect(submits()).toHaveLength(1);
  });

  it('will not continue a run with a step deleted', async () => {
    const runId = await runToPick('nonce-0015');
    await advanceRemixRun({ runId, answers: [0], quote: 30, caller: caller() });
    expect(submits()).toHaveLength(2);
    h.workflows.splice(0, 1);
    await expect(advanceRemixRun({ runId, caller: caller() })).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('a step was deleted'),
    });
    expect(submits()).toHaveLength(1);
  });

  describe('mature outputs', () => {
    async function finishedRun(nonce: string, viewer: RemixAppCaller) {
      const runId = await runToPick(nonce, viewer);
      await advanceRemixRun({ runId, answers: [0], quote: 30, caller: viewer });
      finish(submits()[1].id, [blob('pg'), blob('x')], { [blob('pg')]: 'pg', [blob('x')]: 'x' });
      return advanceRemixRun({ runId, caller: viewer });
    }
    const urls = (state: Awaited<ReturnType<typeof advanceRemixRun>>) =>
      state.status === 'done' ? state.outputs.map((o) => o.url) : state;

    it('are shown to a viewer who shows mature content off green', async () => {
      expect(urls(await finishedRun('nonce-0016', caller()))).toEqual([blob('pg'), blob('x')]);
    });

    it('are hidden on green', async () => {
      const green = caller({ isGreenDomain: true });
      expect(urls(await finishedRun('nonce-0017', green))).toEqual([blob('pg')]);
    });

    it.each([
      ['on green', caller({ isGreenDomain: true })],
      [
        'from a viewer who hides mature content',
        caller({ user: { ...caller().user, showNsfw: false } }),
      ],
    ])('wait for a rating %s', async (_, viewer) => {
      const runId = await runToPick(`nonce-unrated-${viewer.isGreenDomain}`, viewer);
      await advanceRemixRun({ runId, answers: [0], quote: 30, caller: viewer });
      finish(submits()[1].id, [blob('pg'), blob('unrated')], { [blob('pg')]: 'pg' });
      expect(await advanceRemixRun({ runId, caller: viewer })).toMatchObject({ status: 'running' });

      submits()[1].steps[0].output!.images[1].nsfwLevel = 'pg13';
      expect(urls(await advanceRemixRun({ runId, caller: viewer }))).toEqual([
        blob('pg'),
        blob('unrated'),
      ]);
    });

    it('show an unrated output to a viewer who shows mature content', async () => {
      const runId = await runToPick('nonce-unrated-shown');
      await advanceRemixRun({ runId, answers: [0], quote: 30, caller: caller() });
      finish(submits()[1].id, [blob('unrated')]);
      expect(urls(await advanceRemixRun({ runId, caller: caller() }))).toEqual([blob('unrated')]);
    });

    it('are hidden from a viewer who hides mature content', async () => {
      const viewer = caller();
      viewer.user = { ...viewer.user, showNsfw: false };
      expect(urls(await finishedRun('nonce-0018', viewer))).toEqual([blob('pg')]);
    });
  });

  describe("a choice's image goes through the viewer gate", () => {
    const hidesMature = () => caller({ user: { ...caller().user, showNsfw: false } });
    /** The run at its first choice, its one take rated `level` (absent = not rated yet). */
    async function atChoice(nonce: string, viewer: RemixAppCaller, level?: string) {
      addImage(SOURCE_ID);
      const { runId } = await startRemixRun({
        slug: 'about-take',
        imageId: SOURCE_ID,
        nonce,
        quote: 30,
        caller: viewer,
      });
      finish(submits()[0].id, [blob('take')], level ? { [blob('take')]: level } : {});
      const state = await advanceRemixRun({ runId, caller: viewer });
      return { runId, state };
    }

    it('is shown when the viewer may see it', async () => {
      const { state } = await atChoice('nonce-choice-shown', caller({ isGreenDomain: true }), 'pg');
      expect(state).toMatchObject({ status: 'ask', ask: { image: { url: blob('take') } } });
    });

    it.each([
      ['mature, on green', caller({ isGreenDomain: true }), 'x'],
      ['mature, for a viewer who hides mature content', hidesMature(), 'x'],
      ['not rated yet, for a viewer who hides mature content', hidesMature(), undefined],
    ])('is left off when it is %s, and the choice is still asked', async (_, viewer, level) => {
      const { state } = await atChoice(
        `nonce-choice-${level}-${viewer.isGreenDomain}`,
        viewer,
        level
      );
      expect(state).toMatchObject({ status: 'ask', ask: { kind: 'choice', prompt: 'This one?' } });
      expect(JSON.stringify(state)).not.toContain(blob('take'));
    });

    it('is left off when the run did not make it, for any viewer', async () => {
      const viewer = caller();
      const { runId, state } = await atChoice('nonce-choice-foreign', viewer, 'pg');
      // POSITIVE CONTROL: this viewer is shown the run's own take.
      expect(state).toMatchObject({ ask: { image: { url: blob('take') } } });

      const next = await advanceRemixRun({ runId, answers: ['ok'], caller: viewer });

      expect(next).toMatchObject({ status: 'ask', ask: { prompt: 'That one?' } });
      expect(next).not.toHaveProperty('ask.image');
    });
  });

  it.each([
    ['who shows mature content off green', () => caller()],
    ['on green', () => caller({ isGreenDomain: true })],
  ])('never sends a url the run did not make, to a viewer %s', async (_, viewer) => {
    const FOREIGN = 'https://example.com/not-from-this-run.png';
    addImage(SOURCE_ID);
    const { runId } = await startRemixRun({
      slug: 'smuggles',
      imageId: SOURCE_ID,
      nonce: `nonce-foreign-${viewer().isGreenDomain}`,
      quote: 30,
      caller: viewer(),
    });
    finish(submits()[0].id, [blob('one')], { [blob('one')]: 'pg' });

    const pick = await advanceRemixRun({ runId, caller: viewer() });
    expect(pick).toMatchObject({ status: 'ask', ask: { images: [{ url: blob('one') }, null] } });
    expect(JSON.stringify(pick)).not.toContain(FOREIGN);
    await expect(advanceRemixRun({ runId, answers: [1], caller: viewer() })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });

    const done = await advanceRemixRun({ runId, answers: [0], caller: viewer() });
    expect(done).toMatchObject({ status: 'done', outputs: [{ url: blob('one') }] });
    expect(JSON.stringify(done)).not.toContain(FOREIGN);
  });
});

describe('posting a finished run', () => {
  /** A finished Anime it run whose one output is `url`. */
  async function finishedAnime(nonce: string, url: string, level?: string) {
    addImage(SOURCE_ID);
    const { workflowId } = (await startRemixRun({
      slug: 'anime-it',
      imageId: SOURCE_ID,
      nonce,
      quote: 30,
      caller: caller(),
    })) as { workflowId: string };
    finish(workflowId, [url], level ? { [url]: level } : {});
    return workflowId;
  }
  const post = (
    workflowId: string,
    over: {
      caller?: RemixAppCaller;
      gallery?: Parameters<typeof postRemixResult>[0]['gallery'];
    } = {}
  ) => postRemixResult({ workflowId, caller: caller(), ctx: {} as never, ...over });

  it("posts the workflow's own outputs, published, once per workflow, and takes the run off the tray", async () => {
    const workflowId = await finishedAnime('nonce-post-1', blob('out'));

    await post(workflowId);

    expect(h.headlessPost).toHaveBeenCalledWith(
      expect.objectContaining({
        media: [expect.objectContaining({ workflowId, url: blob('out') })],
        publish: true,
        idempotencyKey: `remix:${workflowId}`,
      })
    );
    expect(h.patchTags).toHaveBeenCalledWith(
      expect.objectContaining({ input: [{ workflowId, tag: 'remix:done', op: 'add' }] })
    );
  });

  it('refuses while an output is unrated for a viewer who hides mature content', async () => {
    const workflowId = await finishedAnime('nonce-post-2', blob('unrated'));
    const viewer = caller();
    viewer.user = { ...viewer.user, showNsfw: false };

    await expect(post(workflowId, { caller: viewer })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    expect(h.headlessPost).not.toHaveBeenCalled();
    expect(h.patchTags).not.toHaveBeenCalled();
  });

  it('leaves a mature output out on green', async () => {
    const workflowId = await finishedAnime('nonce-post-3', blob('x'), 'x');

    await expect(post(workflowId, { caller: caller({ isGreenDomain: true }) })).rejects.toThrow(
      'Nothing from this remix can be posted.'
    );
    expect(h.headlessPost).not.toHaveBeenCalled();
  });

  it("submits to the source's gallery only, and still posts when asked for another", async () => {
    const workflowId = await finishedAnime('nonce-post-4', blob('out'));
    const ownGallery = { hostImageId: SOURCE_ID, method: 'free' as const };

    await post(workflowId, { gallery: ownGallery });
    expect(h.headlessPost).toHaveBeenLastCalledWith(
      expect.objectContaining({ remixGallery: ownGallery })
    );

    const other = await post(workflowId, { gallery: { hostImageId: 999, method: 'free' } });
    expect(h.headlessPost).toHaveBeenLastCalledWith(
      expect.objectContaining({ remixGallery: undefined })
    );
    expect(other).toMatchObject({ postId: 500, gallery: { submitted: false } });
  });

  it('does not post a workflow that is not a remix', async () => {
    h.workflows.push({
      id: 'plain',
      status: 'succeeded',
      tags: ['gen'],
      createdAt: new Date().toISOString(),
      steps: [{ $type: 'imageGen', output: { images: [{ url: blob('plain') }] } }],
      cost: { total: 0 },
    });

    await expect(post('plain')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(h.headlessPost).not.toHaveBeenCalled();
  });
});

describe('Pick of four', () => {
  const takes = ['a', 'b', 'c', 'd'].map(blob);

  /** Four takes finished, the third one picked: the run waits on "Finish it". */
  async function atFinish(nonce: string) {
    addImage(SOURCE_ID);
    const { runId } = await startRemixRun({
      slug: 'pick-of-four',
      imageId: SOURCE_ID,
      nonce,
      quote: 30,
      caller: caller(),
    });
    finish(submits()[0].id, takes);
    const pick = await advanceRemixRun({ runId, caller: caller() });
    expect(pick).toMatchObject({ status: 'ask', ask: { kind: 'pick' } });
    const state = await advanceRemixRun({ runId, answers: [2], caller: caller() });
    return { runId, state };
  }

  describe('the pick shows only takes the viewer may see', () => {
    /** Four takes finished with `levels` (url → nsfw level; absent = not rated yet). */
    async function atPick(nonce: string, levels: Record<string, string>, viewer = caller()) {
      addImage(SOURCE_ID);
      const { runId } = await startRemixRun({
        slug: 'pick-of-four',
        imageId: SOURCE_ID,
        nonce,
        quote: 30,
        caller: viewer,
      });
      finish(submits()[0].id, takes, levels);
      return runId;
    }
    const rated = Object.fromEntries(takes.map((url) => [url, 'pg']));
    const hidesMature = () => {
      const viewer = caller();
      viewer.user = { ...viewer.user, showNsfw: false };
      return viewer;
    };

    it('holds the run while a take is not rated yet', async () => {
      const viewer = hidesMature();
      const { [takes[1]]: _, ...oneUnrated } = rated;
      const runId = await atPick('nonce-p4-unrated', oneUnrated, viewer);

      expect(await advanceRemixRun({ runId, caller: viewer })).toMatchObject({ status: 'running' });
      // POSITIVE CONTROL: rated, the pick is shown.
      finish(submits()[0].id, takes, rated);
      expect(await advanceRemixRun({ runId, caller: viewer })).toMatchObject({ status: 'ask' });
    });

    it.each([
      ['on green', () => caller({ isGreenDomain: true })],
      ['for a viewer who hides mature content', hidesMature],
    ])('leaves a mature take out %s, and refuses a pick of it', async (_, viewer) => {
      const runId = await atPick('nonce-p4-mature', { ...rated, [takes[1]]: 'x' }, viewer());

      const state = await advanceRemixRun({ runId, caller: viewer() });

      expect(state).toMatchObject({ status: 'ask', ask: { kind: 'pick' } });
      const images = (state as { ask: { images: ({ url: string } | null)[] } }).ask.images;
      expect(images.map((image) => image?.url ?? null)).toEqual([
        takes[0],
        null,
        takes[2],
        takes[3],
      ]);
      expect(JSON.stringify(state)).not.toContain(takes[1]);
      await expect(
        advanceRemixRun({ runId, answers: [1], caller: viewer() })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });

    it('ends the run when none of the takes can be shown', async () => {
      const allMature = Object.fromEntries(takes.map((url) => [url, 'x']));
      const runId = await atPick('nonce-p4-none', allMature);

      expect(
        await advanceRemixRun({ runId, caller: caller({ isGreenDomain: true }) })
      ).toMatchObject({
        status: 'failed',
        reason: 'None of the results can be shown here.',
      });
    });
  });

  it('prices each option from a whatIf on the workflow it leads to, and keeping as free', async () => {
    const { state } = await atFinish('nonce-p4-prices');

    // Finish it shows the picked take.
    expect(state).toMatchObject({
      status: 'ask',
      ask: { kind: 'choice', image: { url: takes[2] } },
    });
    expect(state).toHaveProperty('prices', { upscale: h.upscalePrice, keep: 0 });
    // The priced body is the upscaler run on the picked take. Graph values nested under `input`
    // would validate as an empty form and price the default model instead, silently.
    const [[{ body }]] = whatIfs().slice(-1) as [[{ body: unknown }]];
    const priced = JSON.stringify(body);
    expect(priced).toContain('ImageUpscaleWithModel');
    expect(priced).toContain(takes[2]);
    expect(submits()).toHaveLength(1);
  });

  it('upscales the pick at the price its button showed, with the source still proven', async () => {
    const { runId } = await atFinish('nonce-p4-upscale');

    const state = await advanceRemixRun({
      runId,
      answers: [2, 'upscale'],
      quote: h.upscalePrice,
      caller: caller(),
    });

    expect(state).toMatchObject({ status: 'running' });
    expect(submits()).toHaveLength(2);
    const [first, second] = submits();
    // The upscale graph, on the picked take.
    expect(second.tags).toEqual(expect.arrayContaining(['img2img:upscale', 'remix-seg:1']));
    expect(JSON.stringify(h.submitWorkflow.mock.calls.at(-1))).toContain(takes[2]);
    expect(verifyProvenance(second.metadata?.provenance, USER_ID)).toEqual([SOURCE_ID]);
    expect(verifyProvenance(second.metadata?.provenance, USER_ID)).toEqual(
      verifyProvenance(first.metadata?.provenance, USER_ID)
    );
  });

  it('ends an upscaled pick done and postable, from the comfy step the upscale graph returns', async () => {
    const { runId } = await atFinish('nonce-p4-upscaled');
    await advanceRemixRun({
      runId,
      answers: [2, 'upscale'],
      quote: h.upscalePrice,
      caller: caller(),
    });
    const upscale = submits()[1];
    const upscaled = blob('upscaled');
    upscale.status = 'succeeded';
    // As the orchestrator returns img2img:upscale: one comfy step, its image under `blobs`.
    upscale.steps = [
      {
        $type: 'comfy',
        name: '0',
        status: 'succeeded',
        output: {
          blobs: [
            {
              type: 'image',
              id: 'upscaled.jpeg',
              available: true,
              url: upscaled,
              nsfwLevel: 'pg',
              width: 2048,
              height: 2048,
            },
          ],
        },
      },
    ];

    const state = await advanceRemixRun({ runId, caller: caller() });

    expect(state).toMatchObject({ status: 'done', outputs: [{ url: upscaled }] });
    await postRemixResult({ runId, caller: caller(), ctx: {} as never });
    expect(h.headlessPost).toHaveBeenCalledWith(
      expect.objectContaining({
        media: [expect.objectContaining({ workflowId: upscale.id, url: upscaled })],
      })
    );
  });

  it('keeps the pick, and a run that ends on that answer stays ended', async () => {
    const { runId } = await atFinish('nonce-p4-keep');

    const kept = await advanceRemixRun({ runId, answers: [2, 'keep'], caller: caller() });
    expect(kept).toMatchObject({ status: 'done', outputs: [{ url: takes[2] }] });

    // A reload, and a repeat of the same tap, find the run ended rather than asking again.
    for (const answers of [[], [2, 'keep']]) {
      expect(await advanceRemixRun({ runId, answers, caller: caller() })).toMatchObject({
        status: 'done',
        outputs: [{ url: takes[2] }],
      });
    }
    expect(submits()).toHaveLength(1);
  });

  it('posts only the kept take, from the workflow that made it', async () => {
    const { runId } = await atFinish('nonce-p4-post');
    await advanceRemixRun({ runId, answers: [2, 'keep'], caller: caller() });
    const [takesWorkflow] = submits();

    await postRemixResult({ runId, caller: caller(), ctx: {} as never });

    expect(h.headlessPost).toHaveBeenCalledWith(
      expect.objectContaining({
        media: [expect.objectContaining({ workflowId: takesWorkflow.id, url: takes[2] })],
        idempotencyKey: `remix:${runId}`,
      })
    );
    expect(h.patchTags).toHaveBeenCalledWith(
      expect.objectContaining({
        input: [{ workflowId: takesWorkflow.id, tag: 'remix:done', op: 'add' }],
      })
    );
  });

  it('prices the options once while that ask is open', async () => {
    const { runId } = await atFinish('nonce-p4-cache');
    const priced = whatIfs().length;

    const again = await advanceRemixRun({ runId, answers: [2], caller: caller() });

    expect(again).toHaveProperty('prices', { upscale: h.upscalePrice, keep: 0 });
    expect(whatIfs()).toHaveLength(priced);
  });

  it('will not post a run still waiting on an answer, and prices nothing to find that out', async () => {
    addImage(SOURCE_ID);
    const { runId } = await startRemixRun({
      slug: 'then-choose',
      imageId: SOURCE_ID,
      nonce: 'nonce-choose-post',
      quote: 30,
      caller: caller(),
    });
    finish(submits()[0].id, [blob('one')]);
    // POSITIVE CONTROL: at this ask, an advance prices its options.
    const before = whatIfs().length;
    expect(await advanceRemixRun({ runId, caller: caller() })).toHaveProperty('prices');
    expect(whatIfs().length).toBeGreaterThan(before);
    h.sys.clear();

    const priced = whatIfs().length;
    await expect(postRemixResult({ runId, caller: caller(), ctx: {} as never })).rejects.toThrow(
      'This remix has not finished.'
    );
    expect(h.headlessPost).not.toHaveBeenCalled();
    expect(whatIfs()).toHaveLength(priced);
  });
});

describe('replay', () => {
  const source = { imageId: SOURCE_ID, url: blob('source'), width: 1200, height: 800 };

  it('will not continue a run whose recorded answer does not fit its ask', async () => {
    // Recorded answers sit in workflow metadata, which its owner can patch.
    const runId = await runToPick('nonce-forged-answer');
    await advanceRemixRun({ runId, answers: [0], quote: 30, caller: caller() });
    finish(submits()[1].id, [blob('polished')]);
    // POSITIVE CONTROL: as recorded, the run is done.
    expect(await advanceRemixRun({ runId, caller: caller() })).toMatchObject({ status: 'done' });
    (submits()[1].metadata!.remixRun as { answers: unknown[] }).answers = [9];

    await expect(advanceRemixRun({ runId, caller: caller() })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('builds the next workflow from the recorded answer alone', async () => {
    const { app } = await (
      await import('~/server/services/remix-app-registry.service')
    ).getRegisteredRemixApp('pick-then-edit', { allowDisabled: false });
    const takes = { workflowId: 'takes', images: ['a', 'b', 'c'].map((n) => ({ url: blob(n) })) };
    const replayWith = (answer: number) =>
      replayRemixApp(app, source, [
        { type: 'workflow', result: takes },
        { type: 'ask', answer },
      ]);
    const imagesOf = (outcome: Awaited<ReturnType<typeof replayWith>>) =>
      outcome.status === 'effect' &&
      outcome.effect.type === 'workflow' &&
      outcome.effect.request.kind === 'image'
        ? outcome.effect.request.images
        : outcome;

    // Each replay starts the app over: a later replay must not see an earlier one's answer.
    expect(imagesOf(await replayWith(2))).toEqual([{ url: blob('c') }]);
    expect(imagesOf(await replayWith(0))).toEqual([{ url: blob('a') }]);
    expect(imagesOf(await replayWith(2))).toEqual([{ url: blob('c') }]);
  });

  it('refuses a log that disagrees with what the app asks for', async () => {
    const { app } = await (
      await import('~/server/services/remix-app-registry.service')
    ).getRegisteredRemixApp('pick-then-edit', { allowDisabled: false });
    await expect(replayRemixApp(app, source, [{ type: 'ask', answer: 0 }])).rejects.toBeInstanceOf(
      RemixReplayError
    );
  });
});

describe('Restyle', () => {
  const start = (answers: (string | number)[], quote?: number, nonce = 'nonce-restyle') => {
    addImage(SOURCE_ID);
    return startRemixRun({
      slug: 'restyle',
      imageId: SOURCE_ID,
      nonce,
      answers,
      quote,
      caller: caller(),
    });
  };
  const submittedPrompt = () => JSON.stringify(h.submitWorkflow.mock.calls.at(-1));
  const blockedText = 'something the audit refuses';

  beforeEach(() => {
    vi.mocked(auditPromptServer).mockImplementation(async ({ prompt }) => {
      if (prompt.includes(blockedText))
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Your prompt was flagged.' });
    });
  });

  it('asks for an optional addition, then a style priced on every option, and spends nothing until a style is tapped', async () => {
    expect(await start([])).toMatchObject({
      status: 'ask',
      ask: { kind: 'text', optional: true, maxLength: RESTYLE_EXTRA_MAX_LENGTH },
    });

    const style = await start(['']);
    expect(style).toMatchObject({ status: 'ask', ask: { kind: 'choice' } });
    expect((style as { prices: Record<string, number> }).prices).toEqual(
      Object.fromEntries(RESTYLE_STYLES.map(({ value }) => [value, h.price]))
    );
    expect(submits()).toHaveLength(0);

    expect(await start(['', 'ukiyo-e'], h.price)).toMatchObject({ status: 'running' });
    expect(submits()).toHaveLength(1);
    expect(submittedPrompt()).toContain('ukiyo-e woodblock print');
    expect(submittedPrompt()).not.toContain('Also add to the scene');
  });

  it("adds the viewer's text to the edit", async () => {
    await start(['a red paper umbrella', 'watercolor'], h.price);
    expect(submittedPrompt()).toContain('watercolor painting');
    expect(submittedPrompt()).toContain('Also add to the scene: a red paper umbrella');
  });

  it(`takes up to ${RESTYLE_EXTRA_MAX_LENGTH} characters and refuses more, or blank text that is not a skip`, async () => {
    // POSITIVE CONTROL: at the cap, the text is taken.
    await expect(
      start(['x'.repeat(RESTYLE_EXTRA_MAX_LENGTH)], undefined, 'nonce-cap')
    ).resolves.toMatchObject({
      status: 'ask',
      ask: { kind: 'choice' },
    });
    for (const text of ['x'.repeat(RESTYLE_EXTRA_MAX_LENGTH + 1), '   '])
      await expect(
        start([text, 'watercolor'], h.price, `nonce-${text.length}`)
      ).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
    expect(submits()).toHaveLength(0);
  });

  it('refuses text the prompt audit blocks, cleanly and without charging', async () => {
    // POSITIVE CONTROL: the same flow with text the audit passes submits.
    await start(['a lantern', 'claymation'], h.price, 'nonce-audit-ok');
    expect(submits()).toHaveLength(1);
    expect(vi.mocked(auditPromptServer)).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: expect.stringContaining('a lantern') })
    );

    await expect(
      start([blockedText, 'claymation'], h.price, 'nonce-audit-blocked')
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Your prompt was flagged.',
    });
    expect(submits()).toHaveLength(1);
  });
});

describe('a row-defined app', () => {
  /** An app no code defines: a choice, an edit, then an upscale of the edit. */
  const row = (over: { status?: string; version?: number; prompt?: string } = {}) => {
    const version = over.version ?? 1;
    return {
      id: 'apb_remix_comic_it',
      blockId: 'remix-comic-it',
      version: `${version}.0.0`,
      status: over.status ?? 'remix',
      featuredOrder: 0,
      manifest: {
        kind: 'remix',
        name: 'Comic it',
        version: `${version}.0.0`,
        targets: [{ slotId: 'image.remix' }],
        remix: {
          icon: 'pencil',
          engine: { safe: { ecosystem: 'NanoBanana', versionId: NANO_V2_LITE } },
          asks: [
            {
              id: 'era',
              kind: 'choice',
              prompt: 'Pick an era',
              options: [
                { value: 'golden', label: 'Golden age', fragments: { look: 'a 1940s comic' } },
                { value: 'modern', label: 'Modern', fragments: { look: 'a modern comic' } },
              ],
            },
          ],
          steps: [
            {
              kind: 'image',
              prompt: over.prompt ?? 'Redraw this image as {{look}} panel.',
              aspectRatio: 'source',
              quantity: 1,
              input: 'source',
            },
            { kind: 'upscale', scale: 2 },
          ],
        },
      },
    };
  };
  const serve = (...rows: ReturnType<typeof row>[]) =>
    dbMock.dbWrite.appBlock.findMany.mockResolvedValue(rows as never);
  const start = (answers: string[], quote?: number, nonce = 'nonce-comic', allowDisabled = false) =>
    startRemixRun({
      slug: 'comic-it',
      imageId: SOURCE_ID,
      nonce,
      answers,
      quote,
      caller: caller(),
      allowDisabled,
    });

  beforeEach(() => addImage(SOURCE_ID));

  it('runs end to end from its row: ask, priced edit, upscale of the edit, done', async () => {
    serve(row());
    expect(await start([])).toMatchObject({
      status: 'ask',
      ask: { kind: 'choice', prompt: 'Pick an era' },
      prices: { golden: h.price, modern: h.price },
    });
    // Priced, not spent, until the tap carries the quote.
    expect(await start(['modern'])).toMatchObject({ status: 'priced', cost: h.price });
    expect(submits()).toHaveLength(0);

    const { runId } = await start(['modern'], h.price);
    expect(submits()).toHaveLength(1);
    const [edit] = submits();
    expect(JSON.stringify(edit)).toContain('Redraw this image as a modern comic panel.');
    expect(edit.tags).toEqual(expect.arrayContaining(['remix-app:comic-it', 'remix:runtime']));
    expect(edit.metadata?.remixRun).toEqual({ app: 'comic-it', version: 1, answers: ['modern'] });

    finish(edit.id, [blob('edit')], { [blob('edit')]: 'pg' });
    expect(await advanceRemixRun({ runId, caller: caller() })).toMatchObject({
      status: 'priced',
      cost: h.upscalePrice,
    });
    await advanceRemixRun({ runId, quote: h.upscalePrice, caller: caller() });
    expect(submits()).toHaveLength(2);
    expect(JSON.stringify(submits()[1])).toContain(blob('edit'));

    finish(submits()[1].id, [blob('big')], { [blob('big')]: 'pg' });
    expect(await advanceRemixRun({ runId, caller: caller() })).toMatchObject({
      status: 'done',
      outputs: [{ url: blob('big') }],
    });
  });

  it('refuses a new run of a disabled app, but a mod test run and a run already paid for go on', async () => {
    serve(row());
    const { runId } = await start(['golden'], h.price);
    serve(row({ status: 'remix_disabled' }));

    // POSITIVE CONTROL above: the same start succeeded while the row was enabled.
    await expect(start(['golden'], h.price, 'nonce-after')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(submits()).toHaveLength(1);

    finish(submits()[0].id, [blob('edit')], { [blob('edit')]: 'pg' });
    expect(await advanceRemixRun({ runId, caller: caller() })).toMatchObject({
      status: 'priced',
    });
    expect(await start(['golden'], undefined, 'nonce-mod', true)).toMatchObject({
      status: 'priced',
    });
  });

  it('stops replaying a run once its row changes what it runs', async () => {
    serve(row());
    const { runId } = await start(['golden'], h.price);
    finish(submits()[0].id, [blob('edit')], { [blob('edit')]: 'pg' });
    // POSITIVE CONTROL: on the same version the run advances.
    await expect(advanceRemixRun({ runId, caller: caller() })).resolves.toMatchObject({
      status: 'priced',
    });

    serve(row({ version: 2, prompt: 'Redraw this image as {{look}} splash page.' }));
    await expect(advanceRemixRun({ runId, caller: caller() })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('skips a stored row that no longer validates, and lists the others', async () => {
    const broken = row();
    // An engine off the allowlist still serves (checked on save only); a row with no steps does not.
    (broken.manifest.remix as { steps: unknown[] }).steps = [];
    serve(broken);
    await expect(start(['golden'], h.price)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // POSITIVE CONTROL: the same row with its steps runs.
    serve(row());
    await expect(start(['golden'], h.price, 'nonce-ok')).resolves.toMatchObject({
      status: 'running',
    });
  });
});
