import { TRPCError } from '@trpc/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logToAxiom } from '~/server/logging/client';
import type * as ImageVisibility from '~/server/services/image-visibility.service';
import type * as InputUrls from '~/server/services/generation-input-urls';
import type * as CacheHelpers from '~/server/utils/cache-helpers';
import type * as OrchestrationNew from '~/server/services/orchestrator/orchestration-new.service';
import type * as RemixProvenance from '~/server/services/orchestrator/remix-provenance';
import type { RemixApp, RemixImage } from '~/shared/remix-apps/define';
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
  /** The cache cluster, where the option prices are cached (named before they moved there). */
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
  classifyPromptServer: vi.fn(async () => ({ outcome: 'pass', triggers: [] })),
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
      return images;
    },
  });
  /** A choice whose `bad` option leads to an upscale of a url no workflow of the run made. */
  const badOption = defineRemixApp({
    slug: 'bad-option',
    name: 'Bad option',
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
      const options = [
        { value: 'good', label: 'Good' },
        { value: 'bad', label: 'Bad' },
      ];
      const pick = await ctx.ask({ kind: 'choice', prompt: 'Which?', options });
      const image = pick === 'bad' ? foreign : images[0];
      return (await ctx.workflow({ kind: 'upscale', image, scale: 2 })).images;
    },
  });
  /** A choice about a url no workflow of the run made. */
  const aboutForeign = defineRemixApp({
    slug: 'about-foreign',
    name: 'About foreign',
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
      await ctx.ask({
        kind: 'choice',
        prompt: 'That one?',
        options: [{ value: 'ok', label: 'OK' }],
        image: foreign,
      });
      return images;
    },
  });
  /** A built-in app's claim is ours: it upscales the source at the size it names. */
  const claimsBuiltIn = defineRemixApp({
    slug: 'claims-built-in',
    name: 'Claims',
    icon: 'sparkles',
    version: 1,
    engine: DEFAULT_ENGINE,
    async run(ctx) {
      const { url } = ctx.source;
      return (
        await ctx.workflow({ kind: 'upscale', image: { url, width: 64, height: 48 }, scale: 2 })
      ).images;
    },
  });
  const apps = new Map(
    [
      claimsBuiltIn,
      pickThenEdit,
      endless,
      asksFirst,
      thenChoose,
      smuggles,
      aboutTake,
      aboutForeign,
      badOption,
    ].map((app) => [app.slug, app])
  );
  const { replayRemixApp } = await import('~/shared/remix-apps/replay');
  // Apps with shapes no row has, beside the real registry (the seed, or the rows a test serves).
  return {
    ...real,
    getRegisteredRemixApp: async (...args: Parameters<typeof real.getRegisteredRemixApp>) => {
      const app = apps.get(args[0]);
      if (!app) return real.getRegisteredRemixApp(...args);
      const replay: Registry.RegisteredRemixApp['replay'] = (source, log) =>
        replayRemixApp(app, source, log);
      return { app, replay, shape: 'test', enabled: true };
    },
  };
});

import { dbMock } from '~/__tests__/mocks/db.mock';
import { fakeRemixRunner } from '~/__tests__/mocks/remix-runner.fake';
import { bumpRemixAppRegistry } from '~/server/services/remix-app-registry.service';
import { setEnv } from '~/__tests__/mocks/env.mock';
import { createHash, createHmac } from 'crypto';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { OnboardingSteps } from '~/server/common/enums';
import { verifyProvenance } from '~/server/services/orchestrator/remix-provenance';
import {
  advanceRemixRun,
  MAX_RUN_SEGMENTS,
  postRemixResult,
  REMIX_APP_HELD,
  REMIX_APP_PROMPT_REFUSED,
  REMIX_APP_UNCHECKED,
  REMIX_APP_UNJUDGED,
  startRemixRun,
} from '~/server/services/remix-app-run.service';
import { REMIX_APP_UNAVAILABLE } from '~/server/services/remix-app-registry.service';
import { REMIX_SYSTEM_ACTOR } from '~/shared/remix-apps/row.schema';
import {
  buildRuntimeRequest,
  listRemixApps,
  quoteRemixApps,
  type RemixAppCaller,
} from '~/server/services/remix-app.service';
import { getRemixSourceUrl } from '~/shared/utils/remix-tier';
import { RemixReplayError, replayRemixApp } from '~/shared/remix-apps/replay';
import {
  auditPromptServer,
  classifyPromptServer,
} from '~/server/services/orchestrator/promptAuditing';
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

/** Lands a workflow's outputs in the shape the orchestrator returns for its graph, sized unless `unsized`. */
function finish(
  workflowId: string,
  urls: string[],
  nsfwLevel: Record<string, string> = {},
  unsized: string[] = []
) {
  const workflow = h.workflows.find((w) => w.id === workflowId)!;
  workflow.status = 'succeeded';
  const blobs = urls.map((url) => ({
    url,
    available: true,
    nsfwLevel: nsfwLevel[url],
    ...(unsized.includes(url) ? {} : { width: 1024, height: 1536 }),
  }));
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
  redisMock.redis.get.mockImplementation((async (key: string) => sys.get(key) ?? null) as never);
  redisMock.redis.set.mockImplementation((async (key: string, value: string) => {
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
    expect(workflow.metadata?.remixRun).toEqual({
      app: 'anime-it',
      version: 1,
      shape: expect.any(String),
      answers: [],
    });
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
    async function atChoice(
      nonce: string,
      viewer: RemixAppCaller,
      level?: string,
      slug = 'about-take'
    ) {
      addImage(SOURCE_ID);
      const { runId } = await startRemixRun({
        slug,
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

    it('is refused when the run did not make it', async () => {
      // POSITIVE CONTROL: the same shape about the run's own take is asked (above).
      await expect(
        atChoice('nonce-choice-foreign', caller(), 'pg', 'about-foreign')
      ).rejects.toMatchObject({ code: 'CONFLICT' });
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

    const pick = advanceRemixRun({ runId, caller: viewer() });
    await expect(pick).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(JSON.stringify(await pick.catch((error: Error) => error.message))).not.toContain(
      FOREIGN
    );
  });
});

it('leaves an option unpriced when its next step is refused, and refuses the run once it is tapped', async () => {
  addImage(SOURCE_ID);
  const { runId } = await startRemixRun({
    slug: 'bad-option',
    imageId: SOURCE_ID,
    nonce: 'nonce-bad-option',
    quote: 30,
    caller: caller(),
  });
  finish(submits()[0].id, [blob('one')], { [blob('one')]: 'pg' });

  const asked = await advanceRemixRun({ runId, caller: caller() });
  expect(asked).toMatchObject({ status: 'ask', ask: { prompt: 'Which?' }, prices: {} });
  await expect(
    advanceRemixRun({ runId, answers: ['bad'], quote: 30, caller: caller() })
  ).rejects.toMatchObject({ code: 'CONFLICT' });
  // POSITIVE CONTROL: the good option goes on.
  await expect(
    advanceRemixRun({ runId, answers: ['good'], quote: 30, caller: caller() })
  ).resolves.toMatchObject({ status: 'running' });
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

  it("upscales at a built-in app's own size: its claims are ours", async () => {
    addImage(SOURCE_ID);
    await startRemixRun({
      slug: 'claims-built-in',
      imageId: SOURCE_ID,
      nonce: 'nonce-claims-built-in',
      quote: 30,
      caller: caller(),
    });
    expect(JSON.stringify(h.submitWorkflow.mock.calls.at(-1))).toContain('"width":64,"height":48');
  });

  it('gives an unsized take no upscale price, and refuses its upscale before any what-if or submit', async () => {
    addImage(SOURCE_ID);
    const { runId } = await startRemixRun({
      slug: 'pick-of-four',
      imageId: SOURCE_ID,
      nonce: 'nonce-p4-unsized',
      quote: 30,
      caller: caller(),
    });
    finish(submits()[0].id, takes, {}, [takes[2]]);
    await advanceRemixRun({ runId, caller: caller() });
    const state = await advanceRemixRun({ runId, answers: [2], caller: caller() });
    expect(state).toHaveProperty('prices', { keep: 0 });
    const priced = whatIfs().length;
    await expect(
      advanceRemixRun({ runId, answers: [2, 'upscale'], quote: h.upscalePrice, caller: caller() })
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'Upscale unavailable for this image',
    });
    expect(whatIfs()).toHaveLength(priced);
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
    // A cache: on the cache cluster, not in system Redis.
    expect([...h.sys.keys()].some((key) => key.startsWith('remix-app:option-prices:'))).toBe(true);
    expect(
      redisMock.sysRedis.set.mock.calls.filter(([key]: unknown[]) =>
        String(key).startsWith('remix-app:')
      )
    ).toEqual([]);
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

describe("an upscale's input size", () => {
  const take = blob('take');
  const row = (size: { width?: number; height?: number }) =>
    ({
      id: SOURCE_ID,
      url: 'ab12cd34-ef56-4a7b-8c9d-0e1f2a3b4c07',
      type: 'image',
      nsfwLevel: 1,
      ingestion: 'Scanned',
      blockedFor: null,
      minor: false,
      poi: false,
      ...size,
    } as Parameters<typeof buildRuntimeRequest>[0]['image']);
  const sizedRow = row({ width: 1200, height: 800 });
  const unsizedRow = row({});
  const build = (
    image: { url: string; width?: number; height?: number },
    source = sizedRow,
    author?: { userId: number }
  ) =>
    buildRuntimeRequest({
      app: {
        name: 'Pick of four',
        engine: { safe: { ecosystem: 'NanoBanana', versionId: NANO_V2_LITE } },
      },
      image: source,
      request: { kind: 'upscale', image, scale: 2 },
      viewer: { isGreen: false, showNsfw: true },
      author,
      log: [],
    });
  const refused = { code: 'PRECONDITION_FAILED', message: 'Upscale unavailable for this image' };

  it("a sized take's graph input is byte for byte what it was", () => {
    expect(JSON.stringify(build({ url: take, width: 1024, height: 1536 }).graphInput)).toBe(
      `{"workflow":"img2img:upscale","images":[{"url":"${take}","width":1024,"height":1536}],"upscaleSelection":{"type":"multiplier","multiplier":2}}`
    );
  });

  it.each([
    ['no size', {}],
    ['no width', { height: 1536 }],
    ['no height', { width: 1024 }],
    ['a zero size', { width: 0, height: 0 }],
  ])('a built-in take with %s is refused, never priced at 512x512', (_, size) => {
    expect(() => build({ url: take, ...size })).toThrow(expect.objectContaining(refused));
  });

  it('the source of a row with no size is refused, whatever size the app names', () => {
    const url = getRemixSourceUrl(unsizedRow);
    expect(() => build({ url, width: 512, height: 512 }, unsizedRow)).toThrow(
      expect.objectContaining(refused)
    );
    expect(() => build({ url, width: 512, height: 512 }, unsizedRow, { userId: 5 })).toThrow(
      expect.objectContaining(refused)
    );
    // POSITIVE CONTROL: the same upscale of a sized row's source is built.
    expect(
      build({ url: getRemixSourceUrl(sizedRow), width: 1200, height: 800 }).graphInput
    ).toMatchObject({
      images: [{ width: 1200, height: 800 }],
    });
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
    ).getRegisteredRemixApp('pick-then-edit', caller(), { allowDisabled: false });
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
    ).getRegisteredRemixApp('pick-then-edit', caller(), { allowDisabled: false });
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
    expect(edit.metadata?.remixRun).toEqual({
      app: 'comic-it',
      version: 1,
      shape: expect.any(String),
      answers: ['modern'],
    });

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

  it('stops replaying a run once its slug is deleted and made again, on the same run version', async () => {
    serve(row());
    const { runId } = await start(['golden'], h.price);
    finish(submits()[0].id, [blob('edit')], { [blob('edit')]: 'pg' });
    // A new row restarts at run version 1, so only the recorded shape tells the two apart.
    serve(row({ prompt: 'Redraw this image as {{look}} splash page.' }));
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

describe('a user app', () => {
  const OTHER_AUTHOR = 5;
  const userRow = (status = 'remix', author = OTHER_AUTHOR) => ({
    id: 'ab_rx_u5_mine_______________',
    blockId: `remix-u${author}-mine`,
    version: '1.0.0',
    status,
    featuredOrder: 1,
    manifest: {
      kind: 'remix',
      name: 'Mine',
      version: '1.0.0',
      targets: [{ slotId: 'image.remix' }],
      remix: {
        icon: 'sparkles',
        engine: { safe: { ecosystem: 'NanoBanana', versionId: NANO_V2_LITE } },
        source: 'export default defineRemixApp({ async run(ctx) { return []; } });',
      },
      author: { userId: author },
      // Approved, then disabled: a disabled app's runs stop whatever its review says.
      review: 'approved',
    },
  });
  const flagOn = (over: Partial<RemixAppCaller['user']> = {}) =>
    caller({
      user: { ...caller().user, ...over },
      features: { isGreen: false, remixAppsUserCode: true } as RemixAppCaller['features'],
    });
  const serve = (...rows: object[]) =>
    dbMock.dbWrite.appBlock.findMany.mockResolvedValue(rows as never);
  const startMine = (viewer: RemixAppCaller) =>
    startRemixRun({
      slug: 'u5-mine',
      imageId: SOURCE_ID,
      nonce: 'nonce-mine',
      quote: 30,
      caller: viewer,
    });

  /** A run recorded on the user app: a run of the seed's Anime it, relabelled as one of `u5-mine`. */
  async function runOfMine(viewer: RemixAppCaller, author = OTHER_AUTHOR) {
    serve();
    const { runId } = await startRemixRun({
      slug: 'anime-it',
      imageId: SOURCE_ID,
      nonce: `nonce-relabel-${author}`,
      quote: 30,
      caller: viewer,
    });
    serve(userRow('remix', author));
    const { getRemixAppRegistry } = await import('~/server/services/remix-app-registry.service');
    const mine = (await getRemixAppRegistry()).find((app) => app.slug === `u${author}-mine`)!;
    const segment = submits().at(-1)!;
    Object.assign(segment.metadata!.remixRun as object, { app: mine.slug, shape: mine.shape });
    finish(segment.id, [blob('out')], { [blob('out')]: 'pg' });
    return runId;
  }

  beforeEach(() => addImage(SOURCE_ID));

  describe('on the runner', () => {
    const SECRET = 'r'.repeat(32);
    const MATURE_SOURCE = SOURCE_ID + 1;
    const matureEngine = {
      ecosystem: REMIX_ENGINES.edit.mature.ecosystemKey,
      versionId: REMIX_ENGINES.edit.mature.modelVersionId,
    };
    const matureRow = () => {
      const row = userRow();
      (row.manifest.remix as { engine: object }).engine = {
        ...row.manifest.remix.engine,
        mature: matureEngine,
      };
      return row;
    };
    const markedSibling = {
      ...userRow('remix_disabled'),
      id: 'ab_rx_u5_other______________',
      blockId: 'remix-u5-other',
      manifest: { ...userRow().manifest, review: 'rejected', minorThemed: { by: 88, at: 'x' } },
    };
    // Upscales the source, then its own output, each time claiming a smaller size than it has.
    const SHRINKS_SOURCE =
      'export default defineRemixApp({ async run(ctx) { return []; } }); // shrinks';
    // Asks first, so the upscale behind its option is priced at the ask.
    const PRICED_SOURCE =
      "export default defineRemixApp({ async run(ctx) { return []; } }); const t = ['Finish it?', 'up', 'Upscale', 'keep', 'Keep']";
    let runner: ReturnType<typeof fakeRemixRunner>;
    beforeEach(() => {
      const source = userRow().manifest.remix.source;
      runner = fakeRemixRunner({
        secret: SECRET,
        apps: {
          [createHash('sha256').update(PRICED_SOURCE).digest('hex')]: {
            async run(ctx) {
              const finishIt = await ctx.ask({
                kind: 'choice',
                prompt: 'Finish it?',
                options: [
                  { value: 'up', label: 'Upscale' },
                  { value: 'keep', label: 'Keep' },
                ],
              });
              if (finishIt === 'keep') return [];
              const { url } = ctx.source;
              return (
                await ctx.workflow({
                  kind: 'upscale',
                  image: { url, width: 64, height: 48 },
                  scale: 2,
                })
              ).images;
            },
          },
          [createHash('sha256').update(SHRINKS_SOURCE).digest('hex')]: {
            async run(ctx) {
              const claim = { width: 64, height: 48 };
              const first = await ctx.workflow({
                kind: 'upscale',
                image: { url: ctx.source.url, ...claim },
                scale: 2,
              });
              const second = await ctx.workflow({
                kind: 'upscale',
                image: { url: first.images[0].url, ...claim },
                scale: 2,
              });
              return second.images;
            },
          },
          [createHash('sha256').update(source).digest('hex')]: {
            async run(ctx) {
              const out = await ctx.workflow({
                kind: 'image',
                prompt: 'a portrait',
                images: [ctx.source],
                aspectRatio: 'source',
                quantity: 1,
              });
              return out.images;
            },
          },
        },
      });
      setEnv({ REMIX_RUNNER_URL: 'http://runner', REMIX_RUNNER_SECRET: SECRET });
      vi.stubGlobal('fetch', runner.fetchImpl);
      dbMock.dbWrite.appBlock.findUnique.mockResolvedValue(matureRow() as never);
      addImage(MATURE_SOURCE, { nsfwLevel: 8 });
    });
    afterEach(() => {
      vi.unstubAllGlobals();
      setEnv({ REMIX_RUNNER_URL: '', REMIX_RUNNER_SECRET: '' });
    });
    let nonce = 0;
    const startOn = (imageId: number) =>
      startRemixRun({
        slug: 'u5-mine',
        imageId,
        nonce: `nonce-on-${imageId}-${nonce++}`,
        quote: 30,
        caller: flagOn(),
      });

    it("refuses a marked author's app on a mature source, through the real runner path", async () => {
      // POSITIVE CONTROL: unmarked, the same app runs on the same mature source.
      serve(matureRow());
      await expect(startOn(MATURE_SOURCE)).resolves.toMatchObject({ status: 'running' });
      expect(submits()).toHaveLength(1);

      serve(matureRow(), markedSibling);
      // As the minor-themed reject does when it writes the mark.
      await bumpRemixAppRegistry();
      await expect(startOn(MATURE_SOURCE)).rejects.toThrow('Mine does not run on mature images.');
      expect(submits()).toHaveLength(1);
    });

    it.each([
      ['an over-long text answer', ['x'.repeat(1001)]],
      ['a negative number', [-1]],
      ['a fraction', [0.5]],
      ['more answers than a run has steps', Array.from({ length: 17 }, () => 'a')],
      ['something that is not an answer', [{}]],
    ])('never sends the runner a recorded answer that is %s', async (_, answers) => {
      serve(userRow());
      addImage(SOURCE_ID);
      const { runId } = await startOn(SOURCE_ID);
      const workflow = h.workflows[h.workflows.length - 1];
      finish(workflow.id, [blob('made')]);
      const sent = runner.calls.length;
      (workflow.metadata!.remixRun as { answers: unknown[] }).answers = answers;
      await expect(advanceRemixRun({ runId, caller: flagOn() })).rejects.toMatchObject({
        code: 'CONFLICT',
      });
      expect(runner.calls).toHaveLength(sent);
    });

    describe('an upscale', () => {
      const shrinksRow = () => {
        const row = userRow();
        row.manifest.remix.source = SHRINKS_SOURCE;
        return row;
      };
      const sizesOf = (call: unknown) =>
        [...JSON.stringify(call).matchAll(/"width":(\d+),"height":(\d+)/g)].map(
          ([, w, h]) => `${w}x${h}`
        );
      /** Priced and submitted from the input size the host knows, never the 64x48 the app names. */
      const upscaled = (input: string) => {
        const submitted = sizesOf(h.submitWorkflow.mock.calls.at(-1));
        expect(submitted).toContain(input);
        expect(submitted).not.toContain('64x48');
        expect(submitted).toEqual(expect.arrayContaining(sizesOf(whatIfs().at(-1))));
      };
      const sizeBlobs = (workflow: (typeof h.workflows)[number], size?: object) => {
        for (const step of workflow.steps!)
          for (const out of (step.output as unknown as { blobs: Record<string, unknown>[] })
            .blobs) {
            delete out.width;
            delete out.height;
            Object.assign(out, size);
          }
      };
      beforeEach(async () => {
        serve(shrinksRow());
        dbMock.dbWrite.appBlock.findUnique.mockResolvedValue(shrinksRow() as never);
        await bumpRemixAppRegistry();
        addImage(SOURCE_ID);
      });

      it("of a user app is priced and run at the size the host knows, never the app's claim", async () => {
        const { runId } = await startOn(SOURCE_ID);
        upscaled('1200x800');
        const [workflow] = submits();
        finish(workflow.id, [blob('upscaled')]);
        sizeBlobs(workflow, { width: 2400, height: 1600 });
        await advanceRemixRun({ runId, quote: 30, caller: flagOn() });
        upscaled('2400x1600');
        expect(submits()).toHaveLength(2);
      });

      const upscaleWhatIfs = () =>
        whatIfs().filter((call) => JSON.stringify(call).includes('ImageUpscaleWithModel'));

      it("of a user app is priced at its ask's options at the size the host knows", async () => {
        const row = shrinksRow();
        row.manifest.remix.source = PRICED_SOURCE;
        serve(row);
        dbMock.dbWrite.appBlock.findUnique.mockResolvedValue(row as never);
        await bumpRemixAppRegistry();
        const run = (answers: string[]) =>
          startRemixRun({
            slug: 'u5-mine',
            imageId: SOURCE_ID,
            nonce: 'nonce-priced-upscale',
            answers,
            quote: 30,
            caller: flagOn(),
          });
        expect(await run([])).toMatchObject({
          status: 'ask',
          prices: { up: expect.any(Number), keep: 0 },
        });
        const priced = sizesOf(upscaleWhatIfs().at(-1));
        await run(['up']);
        upscaled('1200x800');
        expect(sizesOf(h.submitWorkflow.mock.calls.at(-1))).toEqual(expect.arrayContaining(priced));
      });

      it('of a user app is quoted at the size the host knows, as its run is priced', async () => {
        const { quoteRemixApps } = await import('~/server/services/remix-app.service');
        await quoteRemixApps({ imageId: SOURCE_ID, slug: 'u5-mine', caller: flagOn() });
        const quoted = sizesOf(upscaleWhatIfs().at(-1));
        await startOn(SOURCE_ID);
        expect(quoted).toEqual(sizesOf(whatIfs().at(-1)));
        upscaled('1200x800');
      });

      it('of a user app is refused when it names an output whose size the run never recorded', async () => {
        const { runId } = await startOn(SOURCE_ID);
        const [workflow] = submits();
        finish(workflow.id, [blob('unsized')]);
        sizeBlobs(workflow);
        await expect(advanceRemixRun({ runId, quote: 30, caller: flagOn() })).rejects.toMatchObject(
          {
            code: 'BAD_REQUEST',
            message: 'This upscale names an image of unknown size',
          }
        );
        expect(submits()).toHaveLength(1);
      });
    });

    it('replays a finished step whose size the runner would refuse, with that size left out', async () => {
      serve(userRow());
      addImage(SOURCE_ID);
      const { runId } = await startOn(SOURCE_ID);
      const workflow = h.workflows[h.workflows.length - 1];
      finish(workflow.id, [blob('huge')]);
      const [image] = workflow.steps![0].output!.images;
      Object.assign(image, { width: 2.5, height: 200_000 });
      await expect(advanceRemixRun({ runId, caller: flagOn() })).resolves.toMatchObject({
        status: 'done',
      });
    });

    describe('the run-time audit', () => {
      const ask = "await ctx.ask({ kind: 'text', prompt: 'Who is it?', maxLength: 40 })";
      const ASKING_SOURCE = `export default defineRemixApp({ async run(ctx) { const who = ${ask}; const out = await ctx.workflow({ kind: 'image', prompt: 'a portrait of ' + who, images: [ctx.source], aspectRatio: 'source', quantity: 1 }); return out.images; } });`;
      // Two text answers, joined with nothing between them.
      const TWO_SOURCE = ASKING_SOURCE.replace(
        "prompt: 'a portrait of ' + who",
        "prompt: 'a portrait of ' + who + (await ctx.ask({ kind: 'text', prompt: 'And?', maxLength: 40 }))"
      );
      // Goes another way when its text answer is masked: no author part to judge.
      const DIVERGING_SOURCE = ASKING_SOURCE.replace(
        'const out',
        "if (who === '___') return []; const out"
      );
      // Shows a choice, then claims that step was a text ask on every later replay.
      const RELABEL_SOURCE =
        ASKING_SOURCE.replace('Who is it?', 'Which one?') +
        " const option = { value: 'the-option', label: 'The option' };";
      let shown = false;
      // Adds words of its own after a real answer.
      const SUFFIX_SOURCE = DIVERGING_SOURCE.replace('return []', "return ['suffix']");
      const AUTHOR_PART = 'a portrait of ___';
      const pass = {
        outcome: 'pass',
        source: null,
        triggers: [],
        blockedFor: [],
        categories: [],
        externalError: null,
      };
      const blocked = (category: string, message = category) => ({
        outcome: 'hard',
        source: category === 'external' ? 'external' : 'regex',
        triggers: [{ category, message, matchedWord: message }],
        blockedFor: [message],
        categories: [],
        externalError: null,
      });
      /** The classifier on the author's part and on the viewer's words alone; `whole` on both together. */
      const classify = (
        whole: object | null,
        { alone = pass as object, author = pass as object } = {}
      ) =>
        vi.mocked(classifyPromptServer).mockImplementation((async ({
          prompt,
        }: {
          prompt: string;
        }) => {
          if (prompt === AUTHOR_PART) return author;
          if (!prompt.startsWith('a portrait of')) return alone;
          if (!whole) throw new Error('classifier down');
          return whole;
        }) as never);
      let stored: ReturnType<typeof userRow>;
      const rowOf = (source = ASKING_SOURCE) => {
        const row = userRow();
        row.manifest.remix.source = source;
        return row;
      };
      const written = () =>
        dbMock.dbWrite.appBlock.updateMany.mock.calls.map(
          ([args]) =>
            (args as { data: { status?: string; manifest: Record<string, unknown> } }).data
        );
      const blocks = () => (stored.manifest as { combinationBlocks?: string[] }).combinationBlocks;
      const runAs = (viewerId: number, { who = 'Ada', green = false } = {}) => {
        const viewer = flagOn({ id: viewerId });
        return startRemixRun({
          slug: 'u5-mine',
          imageId: SOURCE_ID,
          nonce: `nonce-audit-${viewerId}-${nonce++}`,
          answers: [who],
          quote: 30,
          caller: green ? { ...viewer, features: { ...viewer.features, isGreen: true } } : viewer,
        });
      };
      const refusal = () =>
        new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Your prompt was flagged: x',
          cause: { blockedFor: ['x'] },
        });
      const appOf = (diverges: boolean): Pick<RemixApp, 'run'> => ({
        async run(ctx) {
          const who = await ctx.ask({ kind: 'text', prompt: 'Who is it?', maxLength: 40 });
          if (diverges && who === '___') return [];
          const out = await ctx.workflow({
            kind: 'image',
            prompt: 'a portrait of ' + who,
            images: [ctx.source],
            aspectRatio: 'source',
            quantity: 1,
          });
          return out.images;
        },
      });

      beforeEach(async () => {
        const sha = (text: string) => createHash('sha256').update(text).digest('hex');
        const runner = fakeRemixRunner({
          secret: SECRET,
          apps: {
            [sha(ASKING_SOURCE)]: appOf(false),
            [sha(DIVERGING_SOURCE)]: appOf(true),
            [sha(RELABEL_SOURCE)]: {
              async run(ctx) {
                const asked = shown
                  ? { kind: 'text' as const, prompt: 'Which one?', maxLength: 40 }
                  : {
                      kind: 'choice' as const,
                      prompt: 'Which one?',
                      options: [{ value: 'the-option', label: 'The option' }],
                    };
                shown = true;
                const which = await ctx.ask(asked);
                const out = await ctx.workflow({
                  kind: 'image',
                  prompt: 'a portrait of ' + which,
                  images: [ctx.source],
                  aspectRatio: 'source',
                  quantity: 1,
                });
                return out.images;
              },
            },
            [sha(SUFFIX_SOURCE)]: {
              async run(ctx) {
                const who = await ctx.ask({ kind: 'text', prompt: 'Who is it?', maxLength: 40 });
                const out = await ctx.workflow({
                  kind: 'image',
                  prompt: who === '___' ? 'a portrait of ___' : 'a portrait of ' + who + ' at dusk',
                  images: [ctx.source],
                  aspectRatio: 'source',
                  quantity: 1,
                });
                return out.images;
              },
            },
            [sha(TWO_SOURCE)]: {
              async run(ctx) {
                const who = await ctx.ask({ kind: 'text', prompt: 'Who is it?', maxLength: 40 });
                const and = await ctx.ask({ kind: 'text', prompt: 'And?', maxLength: 40 });
                const out = await ctx.workflow({
                  kind: 'image',
                  prompt: 'a portrait of ' + who + and,
                  images: [ctx.source],
                  aspectRatio: 'source',
                  quantity: 1,
                });
                return out.images;
              },
            },
          },
        });
        vi.stubGlobal('fetch', runner.fetchImpl);
        shown = false;
        stored = rowOf();
        dbMock.dbWrite.appBlock.findMany.mockImplementation(async () => [stored] as never);
        dbMock.dbWrite.appBlock.findUnique.mockImplementation(async () => stored as never);
        dbMock.dbWrite.appBlock.updateMany.mockImplementation((async ({
          data,
        }: {
          data: object;
        }) => {
          stored = { ...stored, ...data } as typeof stored;
          return { count: 1 };
        }) as never);
        await bumpRemixAppRegistry();
        vi.mocked(classifyPromptServer).mockResolvedValue(pass as never);
        vi.mocked(auditPromptServer).mockImplementation(async () => undefined);
      });
      afterEach(() => {
        // clearAllMocks keeps implementations: these would refuse every later test's runs.
        vi.mocked(auditPromptServer).mockImplementation(async () => undefined);
        vi.mocked(classifyPromptServer).mockResolvedValue(pass as never);
        dbMock.dbWrite.appBlock.updateMany.mockReset();
        dbMock.dbWrite.appBlock.findMany.mockReset();
      });

      it("B: judges the author's part alone, and the viewer's audit stays the generator's own on the whole prompt", async () => {
        await expect(runAs(USER_ID)).resolves.toMatchObject({ status: 'running' });
        // The author's part, then the whole prompt before the viewer's audit.
        expect(vi.mocked(classifyPromptServer).mock.calls.map(([args]) => args)).toEqual([
          { prompt: AUTHOR_PART, isGreen: false },
          { prompt: 'a portrait of Ada', isGreen: false },
        ]);
        // The viewer's audit: once, on the prompt with their words, as the viewer.
        expect(vi.mocked(auditPromptServer)).toHaveBeenCalledTimes(1);
        expect(vi.mocked(auditPromptServer)).toHaveBeenCalledWith(
          expect.objectContaining({ prompt: 'a portrait of Ada', userId: USER_ID, isGreen: false })
        );
        expect(written()).toHaveLength(0);
      });

      it("B: judges the author's part off green on green too, where the viewer's audit keeps green's list", async () => {
        await expect(runAs(USER_ID, { green: true })).resolves.toMatchObject({ status: 'running' });
        expect(vi.mocked(classifyPromptServer)).toHaveBeenCalledWith({
          prompt: AUTHOR_PART,
          isGreen: false,
        });
        expect(vi.mocked(auditPromptServer)).toHaveBeenCalledWith(
          expect.objectContaining({ isGreen: true })
        );
      });

      it("B: an author's part that cannot be built refuses the run before the viewer's audit, and holds nothing", async () => {
        // The viewer's answer can steer an app there, so one viewer must not pull it.
        stored = rowOf(DIVERGING_SOURCE);
        await bumpRemixAppRegistry();
        await expect(runAs(USER_ID)).rejects.toMatchObject({
          code: 'PRECONDITION_FAILED',
          message: REMIX_APP_UNJUDGED,
        });
        expect(vi.mocked(auditPromptServer)).not.toHaveBeenCalled();
        expect(submits()).toHaveLength(0);
        expect(written()).toHaveLength(0);
      });

      it("B: an author's part that blocks sends the app back to review and refuses the run before the viewer's audit", async () => {
        classify(pass, { author: blocked('nsfw_blocklist') });
        await expect(runAs(USER_ID)).rejects.toMatchObject({
          code: 'PRECONDITION_FAILED',
          message: REMIX_APP_HELD,
        });
        expect(vi.mocked(auditPromptServer)).not.toHaveBeenCalled();
        expect(submits()).toHaveLength(0);
        const [held] = written();
        expect(held.status).toBe('remix_disabled');
        expect(held.manifest.review).toBe('submitted');
        expect(held.manifest.reviewLog).toEqual([
          expect.objectContaining({ by: REMIX_SYSTEM_ACTOR, action: 'held-author-prompt' }),
        ]);
      });

      it('B: a pass the classifier could not vouch for refuses the run, and holds nothing', async () => {
        classify(pass, { author: { ...pass, externalError: { message: 'down' } } });
        await expect(runAs(USER_ID)).rejects.toMatchObject({
          code: 'SERVICE_UNAVAILABLE',
          message: REMIX_APP_UNCHECKED,
        });
        expect(vi.mocked(auditPromptServer)).not.toHaveBeenCalled();
        expect(written()).toHaveLength(0);
      });

      it('B: a hold that fails to save still refuses the run', async () => {
        classify(pass, { author: blocked('nsfw_blocklist') });
        dbMock.dbWrite.appBlock.updateMany.mockRejectedValue(new Error('db down'));
        await expect(runAs(USER_ID)).rejects.toMatchObject({ message: REMIX_APP_HELD });
        expect(vi.mocked(auditPromptServer)).not.toHaveBeenCalled();
      });

      it('C: a combination refusal counts once per distinct viewer, and the third takes the app out of menus', async () => {
        classify(blocked('external', 'synthetic-other'));
        // Refused before the viewer's audit, so nothing is recorded against the viewer.
        await expect(runAs(101)).rejects.toMatchObject({
          code: 'BAD_REQUEST',
          message: REMIX_APP_PROMPT_REFUSED,
        });
        expect(vi.mocked(auditPromptServer)).not.toHaveBeenCalled();
        expect(submits()).toHaveLength(0);
        await expect(runAs(101)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
        await expect(runAs(102)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
        expect(stored.status).toBe('remix');
        expect(stored.manifest).toMatchObject({ review: 'approved' });
        expect(blocks()).toHaveLength(2);
        // No viewer id on the author's row.
        expect(JSON.stringify(stored.manifest)).not.toMatch(/\b10[12]\b/);

        await expect(runAs(103)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
        expect(stored.status).toBe('remix_disabled');
        expect(stored.manifest).toMatchObject({
          review: 'submitted',
          reviewLog: [
            expect.objectContaining({ action: 'held-combination-blocks', by: REMIX_SYSTEM_ACTOR }),
          ],
        });
      });

      it("C: the viewer's own words that block are refused before the viewer's audit too, and count against the app", async () => {
        vi.mocked(auditPromptServer).mockRejectedValue(refusal());
        classify(blocked('nsfw_blocklist'), { alone: blocked('nsfw_blocklist') });
        await expect(runAs(101)).rejects.toMatchObject({ message: REMIX_APP_PROMPT_REFUSED });
        expect(vi.mocked(auditPromptServer)).not.toHaveBeenCalled();
        expect(blocks()).toHaveLength(1);
      });

      it('C: an app that calls a step it showed as a choice a text ask is refused, never recorded against the viewer', async () => {
        stored = rowOf(RELABEL_SOURCE);
        await bumpRemixAppRegistry();
        // What the viewer's audit would do with the real prompt: refuse it, and record the viewer.
        vi.mocked(auditPromptServer).mockRejectedValue(refusal());
        vi.mocked(classifyPromptServer).mockImplementation((async ({
          prompt,
        }: {
          prompt: string;
        }) => (prompt.includes('the-option') ? blocked('minor_age') : pass)) as never);
        await expect(runAs(101, { who: 'the-option' })).rejects.toMatchObject({
          code: 'BAD_REQUEST',
          message: REMIX_APP_PROMPT_REFUSED,
        });
        expect(vi.mocked(auditPromptServer)).not.toHaveBeenCalled();
        expect(submits()).toHaveLength(0);
        expect(blocks()).toHaveLength(1);
      });

      it("C: a refusal on green is refused before the viewer's audit, and counts against nobody", async () => {
        classify(blocked('minor_age'));
        await expect(runAs(101, { green: true })).rejects.toMatchObject({
          message: REMIX_APP_PROMPT_REFUSED,
        });
        expect(vi.mocked(classifyPromptServer)).toHaveBeenCalledWith({
          prompt: 'a portrait of Ada',
          isGreen: true,
        });
        expect(vi.mocked(auditPromptServer)).not.toHaveBeenCalled();
        expect(written()).toHaveLength(0);
      });

      it("C: a whole prompt that blocks where the author's part and the viewer's words pass is refused, and counted against the app, not the viewer", async () => {
        stored = rowOf(SUFFIX_SOURCE);
        await bumpRemixAppRegistry();
        // What the viewer's audit would do with the real prompt: refuse it, and record the viewer.
        vi.mocked(auditPromptServer).mockRejectedValue(refusal());
        vi.mocked(classifyPromptServer).mockImplementation((async ({
          prompt,
        }: {
          prompt: string;
        }) => (prompt.endsWith('at dusk') ? blocked('minor_age') : pass)) as never);
        await expect(runAs(101)).rejects.toMatchObject({
          code: 'BAD_REQUEST',
          message: REMIX_APP_PROMPT_REFUSED,
        });
        // auditPromptServer is the one writer of prohibitedRequests and the blocked-prompt count
        // the auto-mute reseeds from: the viewer's only trail is this event, without the prompt.
        expect(vi.mocked(auditPromptServer)).not.toHaveBeenCalled();
        expect(submits()).toHaveLength(0);
        expect(blocks()).toHaveLength(1);
        const events = vi
          .mocked(logToAxiom)
          .mock.calls.filter(([event]) => event.name === 'remix-combination-refusal');
        expect(events.map(([event]) => event)).toEqual([
          expect.objectContaining({
            payload: { slug: 'u5-mine', viewerId: 101, outcome: 'hard', categories: ['minor_age'] },
          }),
        ]);
        expect(JSON.stringify(events)).not.toContain('at dusk');
      });

      it('C: a refusal the prompt, judged again, does not repeat never counts', async () => {
        vi.mocked(auditPromptServer).mockRejectedValue(refusal());
        classify(pass);
        await expect(runAs(101)).rejects.toMatchObject({ message: 'Your prompt was flagged: x' });
        expect(written()).toHaveLength(0);
      });

      it('C: a whole prompt the classifier cannot judge refuses the run as unavailable, and holds nothing', async () => {
        classify(null);
        await expect(runAs(101)).rejects.toMatchObject({
          code: 'SERVICE_UNAVAILABLE',
          message: REMIX_APP_UNCHECKED,
        });
        expect(vi.mocked(auditPromptServer)).not.toHaveBeenCalled();
        expect(written()).toHaveLength(0);
      });

      it('B: a classifier that throws refuses the run as unavailable, and holds nothing', async () => {
        vi.mocked(classifyPromptServer).mockRejectedValue(new Error('redis down'));
        await expect(runAs(USER_ID)).rejects.toMatchObject({
          code: 'SERVICE_UNAVAILABLE',
          message: REMIX_APP_UNCHECKED,
        });
        expect(vi.mocked(auditPromptServer)).not.toHaveBeenCalled();
        expect(written()).toHaveLength(0);
      });

      it.each([
        ['a minor-age regex block', blocked('minor_age'), 'held-combination-blocks'],
        [
          'an inappropriate-minor regex block',
          blocked('inappropriate_minor'),
          'held-combination-blocks',
        ],
        ['an external category', blocked('external', 'synthetic-minor'), 'held-combination-blocks'],
        [
          'a verdict the classifier could not finish',
          { ...blocked('external', 'synthetic-other'), externalError: { message: 'down' } },
          'held-classifier-error',
        ],
      ])(
        "C: %s never takes the app out on one viewer's refusals; the third distinct viewer does",
        async (_, verdict, action) => {
          classify(verdict);
          await expect(runAs(101)).rejects.toMatchObject({ message: REMIX_APP_PROMPT_REFUSED });
          await expect(runAs(101)).rejects.toMatchObject({ message: REMIX_APP_PROMPT_REFUSED });
          expect(stored.status).toBe('remix');
          expect(blocks()).toHaveLength(1);
          await expect(runAs(102)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
          expect(stored.status).toBe('remix');
          await expect(runAs(103)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
          expect(stored.status).toBe('remix_disabled');
          expect(stored.manifest).toMatchObject({
            review: 'submitted',
            reviewLog: [expect.objectContaining({ action })],
          });
        }
      );

      it('C: a count that fails to save still refuses the run', async () => {
        classify(blocked('minor_age'));
        dbMock.dbWrite.appBlock.updateMany.mockRejectedValue(new Error('db down'));
        await expect(runAs(101)).rejects.toMatchObject({
          code: 'BAD_REQUEST',
          message: REMIX_APP_PROMPT_REFUSED,
        });
      });

      it("an author's run of their own held app skips B: their audit runs as them, and nothing is pulled", async () => {
        stored = { ...rowOf(), status: 'remix_disabled' };
        stored.manifest.review = 'submitted';
        vi.mocked(classifyPromptServer).mockResolvedValue(blocked('nsfw_blocklist') as never);
        vi.mocked(auditPromptServer).mockRejectedValue(refusal());
        await expect(runAs(OTHER_AUTHOR)).rejects.toMatchObject({
          message: 'Your prompt was flagged: x',
        });
        expect(vi.mocked(auditPromptServer)).toHaveBeenCalledWith(
          expect.objectContaining({ prompt: 'a portrait of Ada', userId: OTHER_AUTHOR })
        );
        expect(vi.mocked(classifyPromptServer)).not.toHaveBeenCalled();
        expect(written()).toHaveLength(0);
      });

      it("C: an author's refused runs of their own app never move its count", async () => {
        vi.mocked(auditPromptServer).mockRejectedValue(refusal());
        classify(blocked('external', 'synthetic-other'));
        for (let i = 0; i < 3; i++)
          await expect(runAs(OTHER_AUTHOR)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
        expect(written()).toHaveLength(0);
        expect(stored.status).toBe('remix');
        // POSITIVE CONTROL: another viewer's refusal does count.
        await expect(runAs(101)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
        expect(blocks()).toHaveLength(1);
      });

      it('an author runs their own app in review, listed to them alone; never once it is rejected', async () => {
        stored = { ...rowOf(), status: 'remix_disabled' };
        stored.manifest.review = 'submitted';
        await bumpRemixAppRegistry();
        const listed = async (id: number) =>
          (await listRemixApps(flagOn({ id }))).find((app) => app.slug === 'u5-mine');
        expect(await listed(OTHER_AUTHOR)).toMatchObject({ enabled: false, inReview: true });
        expect(await runAs(OTHER_AUTHOR)).toMatchObject({ status: 'running' });
        expect(submits()).toHaveLength(1);
        // Another viewer neither sees it nor starts it.
        expect(await listed(101)).toBeUndefined();
        await expect(runAs(101)).rejects.toMatchObject({ code: 'NOT_FOUND' });

        // Neither once rejected, nor once a mod disables it after approval.
        for (const review of ['rejected', 'approved']) {
          stored = { ...stored, manifest: { ...stored.manifest, review } };
          await bumpRemixAppRegistry();
          expect(await listed(OTHER_AUTHOR)).toMatchObject({ inReview: false });
          await expect(runAs(OTHER_AUTHOR)).rejects.toMatchObject({ code: 'NOT_FOUND' });
        }
        expect(submits()).toHaveLength(1);
      });

      describe('the runner quarantine', () => {
        const quarantine = (tripped: boolean) =>
          vi.stubGlobal(
            'fetch',
            fakeRemixRunner({ secret: SECRET, apps: {}, quarantined: { tripped } }).fetchImpl
          );
        const counted = () =>
          (stored.manifest as { runnerQuarantines?: { viewers: unknown[] } }).runnerQuarantines
            ?.viewers ?? [];
        const reviewLog = () =>
          (stored.manifest as unknown as { reviewLog?: { action: string; note?: string }[] })
            .reviewLog ?? [];
        const unavailable = { code: 'SERVICE_UNAVAILABLE', message: REMIX_APP_UNAVAILABLE };
        const held = { code: 'PRECONDITION_FAILED', message: REMIX_APP_HELD };

        it('a trip refuses the run as unavailable; three distinct viewers tripping one source hold the app', async () => {
          const decision = { action: 'approved', by: 88, at: '2026-11-01T00:00:00.000Z' };
          stored.manifest = { ...stored.manifest, reviewLog: [decision] } as typeof stored.manifest;
          quarantine(true);
          // One viewer, many times: counted once, never a hold.
          for (let i = 0; i < 4; i++) await expect(runAs(101)).rejects.toMatchObject(unavailable);
          expect(vi.mocked(auditPromptServer)).not.toHaveBeenCalled();
          expect(stored.status).toBe('remix');
          expect(written()).toHaveLength(1);
          // The note carries the count, never anything that names the viewer.
          const [, observed] = reviewLog();
          expect(observed).toMatchObject({ action: 'held-runner-quarantine-observed' });
          expect(observed.note).toContain('1 of 3');
          expect(observed.note).not.toMatch(/[0-9a-f]{16}|101/);
          // The author's own runs never count.
          await expect(runAs(OTHER_AUTHOR)).rejects.toMatchObject(unavailable);
          expect(written()).toHaveLength(1);
          // A new source starts the count again.
          stored = {
            ...stored,
            manifest: {
              ...stored.manifest,
              remix: { ...stored.manifest.remix, source: TWO_SOURCE },
            },
          };
          await bumpRemixAppRegistry();
          await expect(runAs(102)).rejects.toMatchObject(unavailable);
          expect(counted()).toHaveLength(1);
          await expect(runAs(103)).rejects.toMatchObject(unavailable);
          expect(stored.status).toBe('remix');
          const observedRows = () =>
            reviewLog().filter(({ action }) => action === 'held-runner-quarantine-observed');
          expect(observedRows().length).toBeLessThanOrEqual(2);
          // The third distinct viewer on this source holds it.
          await expect(runAs(104)).rejects.toMatchObject(held);
          expect(stored.status).toBe('remix_disabled');
          expect(stored.manifest).toMatchObject({ review: 'submitted' });
          expect(reviewLog().at(-1)).toMatchObject({
            action: 'held-runner-quarantine',
            by: REMIX_SYSTEM_ACTOR,
          });
          // Three observed rows were written and one is kept; the mod's decision outlives them all.
          expect(observedRows()).toHaveLength(1);
          expect(reviewLog()[0]).toEqual(decision);
        });

        // The runner answers every call 423 for ten minutes after one trips it: counting those would
        // let two passers-by complete a hold one runaway call earned.
        it('a cached refusal counts for nobody: one trip and two cached refusals hold nothing, three trips do', async () => {
          quarantine(true);
          await expect(runAs(101)).rejects.toMatchObject(unavailable);
          quarantine(false);
          for (const viewer of [102, 103])
            await expect(runAs(viewer)).rejects.toMatchObject(unavailable);
          expect(counted()).toHaveLength(1);
          expect(stored.status).toBe('remix');
          quarantine(true);
          await expect(runAs(102)).rejects.toMatchObject(unavailable);
          await expect(runAs(103)).rejects.toMatchObject(held);
          expect(stored.status).toBe('remix_disabled');
        });

        it.each([
          [
            'an unsigned 423 claiming a trip',
            'wrong-secret'.padEnd(32, 'x'),
            { code: 'quarantined', tripped: true },
          ],
          ['a signed 423 of another kind', SECRET, { code: 'overloaded', tripped: true }],
          ['a trip from a runner that never says tripped', SECRET, { code: 'quarantined' }],
        ])('%s is not counted: unavailable, nothing recorded', async (_, signer, error) => {
          vi.stubGlobal('fetch', (async (_url: string, init: RequestInit) => {
            const request = JSON.parse(String(init.body)) as { ts: number };
            const response = JSON.stringify({
              ts: request.ts,
              req: createHash('sha256').update(String(init.body)).digest('hex'),
              error: { ...error, message: 'x' },
            });
            return new Response(response, {
              status: 423,
              headers: {
                'x-storage-hook-sig': createHmac('sha256', signer).update(response).digest('hex'),
              },
            });
          }) as unknown as typeof fetch);
          for (const viewer of [101, 102, 103])
            await expect(runAs(viewer)).rejects.toMatchObject(unavailable);
          expect(written()).toHaveLength(0);
          // POSITIVE CONTROL: a signed trip on the same row is counted.
          quarantine(true);
          await expect(runAs(101)).rejects.toMatchObject(unavailable);
          expect(written()).toHaveLength(1);
        });

        it('counts each trip for a day: one 23 h old still counts, one 25 h old no longer does', async () => {
          vi.useFakeTimers({ toFake: ['Date'] });
          try {
            quarantine(true);
            vi.setSystemTime(new Date('2026-11-20T00:00:00Z'));
            await expect(runAs(101)).rejects.toMatchObject(unavailable);
            vi.setSystemTime(new Date('2026-11-20T23:00:00Z'));
            await expect(runAs(102)).rejects.toMatchObject(unavailable);
            // 101's trip is 25 h old: 102 and 103 make two, not three.
            vi.setSystemTime(new Date('2026-11-21T01:00:00Z'));
            await expect(runAs(103)).rejects.toMatchObject(unavailable);
            expect(stored.status).toBe('remix');
            // 102's trip, 2 h old, still counts with 103's.
            await expect(runAs(104)).rejects.toMatchObject(held);
          } finally {
            vi.useRealTimers();
          }
        });

        it('an approval starts the count again', async () => {
          quarantine(true);
          for (const viewer of [101, 102]) await expect(runAs(viewer)).rejects.toThrow();
          await expect(runAs(103)).rejects.toMatchObject(held);
          expect(counted()).toHaveLength(3);
          const { reviewUserRemixApp, remixReviewHash } = await import(
            '~/server/services/remix-app-registry.service'
          );
          await reviewUserRemixApp({
            slug: 'u5-mine',
            sha256: remixReviewHash(stored.manifest as never),
            seenReview: 'submitted',
            decision: 'approved',
            moderatorId: 88,
          });
          expect(stored.manifest).not.toHaveProperty('runnerQuarantines');
        });

        it("a trip on the author's part of the prompt counts as the run's does", async () => {
          const real = globalThis.fetch;
          const trip = fakeRemixRunner({
            secret: SECRET,
            apps: {},
            quarantined: { tripped: true },
          });
          // The author part replays with the viewer's text answers masked.
          vi.stubGlobal('fetch', (async (url: string, init: RequestInit) =>
            (String(init.body).includes('"answer":"___"') ? trip.fetchImpl : real)(
              url,
              init
            )) as unknown as typeof fetch);
          await expect(runAs(101)).rejects.toMatchObject(unavailable);
          expect(submits()).toHaveLength(0);
          expect(counted()).toHaveLength(1);
        });

        it('pricing a user app counts a trip as a run does, and names the hold', async () => {
          quarantine(true);
          const quoteAs = (id: number) =>
            quoteRemixApps({ imageId: SOURCE_ID, slug: 'u5-mine', caller: flagOn({ id }) });
          expect(await quoteAs(101)).toEqual({
            prices: [{ slug: 'u5-mine', refusal: 'Price unavailable' }],
          });
          await quoteAs(OTHER_AUTHOR);
          expect(counted()).toHaveLength(1);
          await quoteAs(102);
          expect(await quoteAs(103)).toEqual({
            prices: [{ slug: 'u5-mine', refusal: REMIX_APP_HELD }],
          });
          expect(stored.status).toBe('remix_disabled');
        });

        it("a quarantine while pricing a choice's options refuses as unavailable, not a server error", async () => {
          const CHOICE_SOURCE =
            "export default defineRemixApp({ async run(ctx) { await ctx.ask({ kind: 'choice', prompt: 'Which?', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] }); return []; } });";
          const sha = createHash('sha256').update(CHOICE_SOURCE).digest('hex');
          const asks = fakeRemixRunner({
            secret: SECRET,
            apps: {
              [sha]: {
                async run(ctx) {
                  const options = [
                    { value: 'a', label: 'A' },
                    { value: 'b', label: 'B' },
                  ];
                  await ctx.ask({ kind: 'choice', prompt: 'Which?', options });
                  return [];
                },
              },
            },
          });
          const tripped = fakeRemixRunner({
            secret: SECRET,
            apps: {},
            quarantined: { tripped: true },
          });
          let calls = 0;
          vi.stubGlobal('fetch', (async (url: string, init: RequestInit) =>
            (calls++ === 0 ? asks : tripped).fetchImpl(url, init)) as unknown as typeof fetch);
          stored = rowOf(CHOICE_SOURCE);
          await bumpRemixAppRegistry();
          await expect(
            startRemixRun({
              slug: 'u5-mine',
              imageId: SOURCE_ID,
              nonce: `nonce-choice-${nonce++}`,
              quote: 30,
              caller: flagOn({ id: 101 }),
            })
          ).rejects.toMatchObject(unavailable);
          expect(asks.calls).toHaveLength(1);
          expect(counted()).toHaveLength(1);
        });
      });

      it("calls the remix runner's own URL and secret, never the permission-check runner's", async () => {
        setEnv({
          REMIX_RUNNER_URL: '',
          REMIX_RUNNER_SECRET: '',
          STORAGE_HOOK_RUNNER_URL: 'http://runner',
          STORAGE_HOOK_RUNNER_SECRET: SECRET,
        });
        await expect(runAs(101)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
        expect(submits()).toHaveLength(0);
        setEnv({
          REMIX_RUNNER_URL: 'http://runner',
          REMIX_RUNNER_SECRET: SECRET,
          STORAGE_HOOK_RUNNER_URL: '',
          STORAGE_HOOK_RUNNER_SECRET: '',
        });
        // POSITIVE CONTROL: on its own config the same run goes through.
        await expect(runAs(101)).resolves.toMatchObject({ status: 'running' });
      });

      it('a mod dry run plays the stored source and names the hash it reviewed', async () => {
        const { validateUserRemixApp, remixReviewHash } = await import(
          '~/server/services/remix-app-registry.service'
        );
        const result = await validateUserRemixApp('u5-mine');
        expect(result.sha256).toBe(remixReviewHash(stored.manifest as never));
        expect(result.issues).toEqual([]);
        expect(result.graph).toMatchObject({
          type: 'ask',
          spec: { prompt: 'Who is it?' },
          branches: [
            {
              next: {
                type: 'workflow',
                request: { prompt: expect.stringMatching(/^a portrait of /) },
              },
            },
          ],
        });
      });

      it("a mod dry run sends the runner only sizes its log accepts, whatever the app's upscales make", async () => {
        const BIG_SOURCE =
          "export default defineRemixApp({ async run(ctx) { const a = await ctx.workflow({ kind: 'upscale', image: { url: ctx.source.url, width: 60000, height: 60000 }, scale: 2 }); const b = await ctx.workflow({ kind: 'upscale', image: a.images[0], scale: 2 }); return b.images; } });";
        const big: Pick<RemixApp, 'run'> = {
          async run(ctx) {
            const a = await ctx.workflow({
              kind: 'upscale',
              image: { url: ctx.source.url, width: 60000, height: 60000 },
              scale: 2,
            });
            const b = await ctx.workflow({ kind: 'upscale', image: a.images[0], scale: 2 });
            return b.images;
          },
        };
        const sha = createHash('sha256').update(BIG_SOURCE).digest('hex');
        vi.stubGlobal('fetch', fakeRemixRunner({ secret: SECRET, apps: { [sha]: big } }).fetchImpl);
        stored = rowOf(BIG_SOURCE);
        await bumpRemixAppRegistry();
        const { validateUserRemixApp } = await import(
          '~/server/services/remix-app-registry.service'
        );
        const { issues, paths } = await validateUserRemixApp('u5-mine');
        expect(issues).toEqual([]);
        expect(paths).toBe(1);
      });

      it('C: an approval starts the count again', async () => {
        vi.mocked(auditPromptServer).mockRejectedValue(refusal());
        classify(blocked('external', 'synthetic-other'));
        for (const viewer of [101, 102, 103])
          await expect(runAs(viewer)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
        expect(stored.manifest).toMatchObject({ review: 'submitted' });
        expect(blocks()).toHaveLength(3);
        const { reviewUserRemixApp, remixReviewHash } = await import(
          '~/server/services/remix-app-registry.service'
        );
        await reviewUserRemixApp({
          slug: 'u5-mine',
          sha256: remixReviewHash(stored.manifest as never),
          seenReview: 'submitted',
          decision: 'approved',
          moderatorId: 88,
        });
        expect(stored.manifest).not.toHaveProperty('combinationBlocks');
      });
    });
  });

  it('is absent from start with its flag off, and refuses to run in-process with it on', async () => {
    serve(userRow());
    await expect(startMine(caller())).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(startMine(flagOn())).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: 'This app is unavailable right now',
    });
    expect(submits()).toHaveLength(0);
  });

  it('is absent from advance with its flag off', async () => {
    const runId = await runOfMine(flagOn());
    await expect(advanceRemixRun({ runId, caller: caller() })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    // POSITIVE CONTROL: with the flag, the run reaches its replay (which no runner serves yet).
    await expect(advanceRemixRun({ runId, caller: flagOn() })).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    });
  });

  it('stops its runs at the next step once it is disabled, except for a mod, or its author while it waits on review', async () => {
    const runId = await runOfMine(flagOn());
    serve(userRow('remix_disabled', OTHER_AUTHOR));
    await expect(advanceRemixRun({ runId, caller: flagOn() })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'This app is no longer available',
    });
    // A mod's run, and the author's own of an app in review, get past the gate to the replay (which no runner serves yet).
    await expect(
      advanceRemixRun({ runId, caller: flagOn({ isModerator: true }) })
    ).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    });
    const own = await runOfMine(flagOn(), USER_ID);
    const inReview = userRow('remix_disabled', USER_ID);
    inReview.manifest.review = 'submitted';
    serve(inReview);
    await bumpRemixAppRegistry();
    await expect(advanceRemixRun({ runId: own, caller: flagOn() })).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    });
    // A mod's disable of an approved app stops its author's runs too.
    serve(userRow('remix_disabled', USER_ID));
    await bumpRemixAppRegistry();
    await expect(advanceRemixRun({ runId: own, caller: flagOn() })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
  });

  it("stops its author's own runs once it is rejected, but not a mod's", async () => {
    const own = await runOfMine(flagOn(), USER_ID);
    const rejected = userRow('remix_disabled', USER_ID);
    rejected.manifest.review = 'rejected';
    serve(rejected);
    await bumpRemixAppRegistry();
    await expect(advanceRemixRun({ runId: own, caller: flagOn() })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'This app is no longer available',
    });
    // POSITIVE CONTROL: a mod's run gets past the gate to the replay (which no runner serves).
    await expect(
      advanceRemixRun({ runId: own, caller: flagOn({ isModerator: true }) })
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });

  it('never replays a run recorded on another shape of the app, or on none', async () => {
    const runId = await runOfMine(flagOn());
    const meta = submits()[0].metadata!.remixRun as Record<string, unknown>;
    meta.shape = 'a-deleted-app';
    await expect(advanceRemixRun({ runId, caller: flagOn() })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    // Only a system app's run may predate shapes; a user app's with none is refused, not replayed.
    delete meta.shape;
    await expect(advanceRemixRun({ runId, caller: flagOn() })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });
});
