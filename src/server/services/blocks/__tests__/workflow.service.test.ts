import { describe, expect, it, vi, beforeEach } from 'vitest';
import { TRPCError } from '@trpc/server';

/**
 * Pure-helper coverage for the block workflow service. Snapshot mapping and
 * input building have no I/O, so we test them directly. resolveBlockVersion
 * goes through Prisma — mocked at the module boundary so the test stays
 * in-process and deterministic.
 */

const { mockDbRead } = vi.hoisted(() => ({
  mockDbRead: {
    modelVersion: { findUnique: vi.fn() },
  },
}));

vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead }));

import {
  appBlockTag,
  assertCheckpointVersionSupportsWorkflow,
  buildCustomComfyWorkflowInput,
  buildImageWorkflowInput,
  buildTextToImageInput,
  BLOCK_CUSTOM_COMFY_STEP_NAME,
  BLOCK_IMAGE_WORKFLOW_TYPES,
  createBlockCustomComfyStep,
  isPageLoraResource,
  assertSourceImageCount,
  normalizeBlockSourceImages,
  projectAppWorkflow,
  resolveBlockImageWorkflowType,
  resolveBlockVersionContext,
  resolvePageResourceContext,
  snapshotFromWorkflow,
} from '../workflow.service';
import { blockWorkflowBodySchema } from '~/server/schema/blocks/workflow.schema';
import { getRecipe, REGISTERED_RECIPE_IDS } from '../recipes';
import {
  getStepByOrchestratorType,
  listRegisteredSteps,
  NATIVELY_EXTRACTED_STEP_TYPES,
  type AnyBlockStep,
} from '../steps';
import { nsfwLevelFromContentRating } from '~/shared/constants/browsingLevel.constants';
// REAL param-building path (no mocks): the generation graph validator and the
// step-metadata snapshot fn are the exact functions the orchestrator's
// `createWorkflowStepsFromGraph` runs to derive `workflowMetadata.params`. Both
// live in the browser-safe `shared/` tree (no DB/redis), so we import and run
// them for real in the integration-style test below.
import { generationGraph } from '~/shared/data-graph/generation/generation-graph';
import { ECO, ecosystems } from '~/shared/constants/basemodel.constants';
import { isWorkflowAvailable } from '~/shared/data-graph/generation/config/workflows';
import { getImagesLimit } from '~/shared/data-graph/generation/images-limit';
import { toStepMetadata } from '~/shared/utils/resource.utils';
import { removeEmpty } from '~/utils/object-helpers';
import type { GenerationCtx } from '~/shared/data-graph/generation/context';

function fakeWorkflow(over: Record<string, unknown> = {}) {
  return {
    id: 'wf_123',
    createdAt: '2026-05-24T00:00:00Z',
    status: 'succeeded' as const,
    metadata: {},
    tags: [],
    arguments: {},
    steps: [],
    callbacks: [],
    tips: { civitai: 0, creators: 0 },
    cost: { total: 42 },
    currencies: [],
    upgradeMode: 'manual' as const,
    forceRefunded: false,
    ...over,
  };
}

describe('snapshotFromWorkflow', () => {
  it('maps the happy path with image URLs', () => {
    const wf = fakeWorkflow({
      steps: [
        {
          $type: 'textToImage',
          name: 's1',
          status: 'succeeded',
          metadata: {},
          output: {
            images: [
              { id: 'b1', url: 'https://cdn/img1.png', available: true, type: 'image' },
              { id: 'b2', url: 'https://cdn/img2.png', available: true, type: 'image' },
            ],
          },
        },
      ],
    });
    const snap = snapshotFromWorkflow(wf as never);
    expect(snap.workflowId).toBe('wf_123');
    expect(snap.status).toBe('succeeded');
    expect(snap.cost).toEqual({ total: 42 });
    expect(snap.imageUrls).toEqual(['https://cdn/img1.png', 'https://cdn/img2.png']);
  });

  it('drops blobs that are pending or have no url (no broken-image links)', () => {
    const wf = fakeWorkflow({
      steps: [
        {
          $type: 'textToImage',
          name: 's1',
          status: 'processing',
          metadata: {},
          output: {
            images: [
              { id: 'b1', url: 'https://cdn/ok.png', available: true, type: 'image' },
              { id: 'b2', url: null, available: false, type: 'image' },
              { id: 'b3', url: 'https://cdn/blocked.png', available: false, type: 'image' },
              { id: 'b4', url: '', available: true, type: 'image' },
            ],
          },
        },
      ],
    });
    const snap = snapshotFromWorkflow(wf as never);
    expect(snap.imageUrls).toEqual(['https://cdn/ok.png']);
  });

  it('emits a non-empty sentinel workflowId for whatif/estimate (no orchestrator id)', () => {
    // The block SDK validator drops snapshots with an empty workflowId, which
    // strands ESTIMATE_RESULT until the 120s timeout (gotcha #55). A whatif
    // workflow has no id, so the snapshot must carry a non-empty sentinel.
    const snap = snapshotFromWorkflow(fakeWorkflow({ id: undefined }) as never);
    expect(snap.workflowId).toBe('whatif');
    expect(snap.workflowId.length).toBeGreaterThan(0);
  });

  it('maps orchestrator-internal statuses (unassigned/preparing/scheduled) to pending', () => {
    for (const status of ['unassigned', 'preparing', 'scheduled'] as const) {
      const snap = snapshotFromWorkflow(fakeWorkflow({ status }) as never);
      expect(snap.status).toBe('pending');
    }
  });

  it('omits cost when orchestrator returns no total', () => {
    const snap = snapshotFromWorkflow(fakeWorkflow({ cost: {} }) as never);
    expect(snap.cost).toBeUndefined();
  });

  it('omits imageUrls when there are no available images', () => {
    const snap = snapshotFromWorkflow(fakeWorkflow({ steps: [] }) as never);
    expect(snap.imageUrls).toBeUndefined();
  });

  it('ignores steps with non-image-producing types (e.g. chatCompletion)', () => {
    const wf = fakeWorkflow({
      steps: [
        {
          $type: 'chatCompletion',
          name: 's1',
          status: 'succeeded',
          metadata: {},
          output: { images: [{ id: 'x', url: 'https://leak/', available: true }] },
        },
      ],
    });
    const snap = snapshotFromWorkflow(wf as never);
    expect(snap.imageUrls).toBeUndefined();
  });

  // ---- #3520: silent model substitutions surfaced on the snapshot ----------
  //
  // The substitution happens during graph validation, before anything is
  // submitted, so it arrives EITHER as an explicit second argument (submit /
  // estimate replies, where the request's collector is still in scope) OR — and
  // this is the one that matters — off the workflow's persisted `metadata`, which
  // is what makes it survive to the TERMINAL POLL, the snapshot a block actually
  // renders from. The invariant being protected is "a caller billed for model A
  // and given model B must be able to find that out".
  it('surfaces modelSubstitutions passed alongside the workflow', () => {
    const snap = snapshotFromWorkflow(fakeWorkflow() as never, {
      modelSubstitutions: [{ requested: 2558804, applied: 2552908, reason: 'wrong-workflow' }],
    });
    expect(snap.modelSubstitutions).toEqual([
      { requested: 2558804, applied: 2552908, reason: 'wrong-workflow' },
    ]);
  });

  it('OMITS modelSubstitutions when nothing was substituted (byte-identical to before)', () => {
    // Three shapes that all mean "nothing to report": no second argument at all
    // (every pre-existing call site), an empty object, and an empty array. None
    // may add a key to the wire payload.
    for (const extra of [undefined, {}, { modelSubstitutions: [] }]) {
      const snap = snapshotFromWorkflow(fakeWorkflow() as never, extra);
      expect('modelSubstitutions' in snap).toBe(false);
    }
  });

  // ---- 🔴 #3520 FIX 1: the record must SURVIVE TO THE POLL -----------------
  //
  // `pollWorkflow` / `cancelWorkflow` call `snapshotFromWorkflow(workflow)` with
  // NO second argument — they only have a freshly fetched Workflow. The poll is
  // also the only snapshot that carries `imageUrls`, i.e. the one a block renders
  // from. A submit-reply-only field is therefore gone before there is anything to
  // display beside it, and `block_workflows` does not retain the submitted body
  // to recover it from. These pin the metadata round-trip that closes that.
  describe('recovered from the workflow metadata (the poll path)', () => {
    const persisted = [
      { requested: 2558804, applied: 2552908, reason: 'wrong-workflow' },
      { requested: 987654321, applied: 2552908, reason: 'unrecognized' },
    ];

    it('reads modelSubstitutions off workflow.metadata with NO extra argument', () => {
      const snap = snapshotFromWorkflow(
        fakeWorkflow({
          metadata: { params: { prompt: 'a cat' }, modelSubstitutions: persisted },
        }) as never
      );
      expect(snap.modelSubstitutions).toEqual(persisted);
    });

    it('is present on the TERMINAL poll shape — alongside the imageUrls it describes', () => {
      // The shape `pollWorkflow` actually hands to the block: succeeded, with
      // outputs. This is the exact call the fix exists for.
      const snap = snapshotFromWorkflow(
        fakeWorkflow({
          status: 'succeeded',
          metadata: { modelSubstitutions: persisted },
          steps: [
            {
              $type: 'textToImage',
              name: 's1',
              status: 'succeeded',
              metadata: {},
              output: {
                images: [{ id: 'b1', url: 'https://cdn/img1.png', available: true, type: 'image' }],
              },
            },
          ],
        }) as never
      );
      expect(snap.imageUrls).toEqual(['https://cdn/img1.png']);
      expect(snap.modelSubstitutions).toEqual(persisted);
    });

    it('an EXPLICIT extra wins over the metadata (the submit reply is authoritative)', () => {
      const fromRequest = [{ requested: 1, applied: 2, reason: 'gated' as const }];
      const snap = snapshotFromWorkflow(
        fakeWorkflow({ metadata: { modelSubstitutions: persisted } }) as never,
        { modelSubstitutions: fromRequest }
      );
      expect(snap.modelSubstitutions).toEqual(fromRequest);
    });

    it('still OMITS the field when the metadata has none (unchanged wire payload)', () => {
      for (const metadata of [
        {},
        { params: { prompt: 'x' } },
        { modelSubstitutions: [] },
        { modelSubstitutions: null },
        { modelSubstitutions: 'nope' },
      ]) {
        const snap = snapshotFromWorkflow(fakeWorkflow({ metadata }) as never);
        expect('modelSubstitutions' in snap).toBe(false);
      }
    });

    // 🔴 The metadata crosses a service boundary and feeds a PUBLIC wire field
    // whose `reason` is also a bounded prom label, so it is validated, not cast.
    it.each([
      ['a non-array', { modelSubstitutions: { requested: 1, applied: 2, reason: 'gated' } }],
      ['a null entry', { modelSubstitutions: [null] }],
      [
        'a non-numeric requested',
        { modelSubstitutions: [{ requested: '1', applied: 2, reason: 'gated' }] },
      ],
      [
        'a NaN applied',
        { modelSubstitutions: [{ requested: 1, applied: Number.NaN, reason: 'gated' }] },
      ],
      ['a missing reason', { modelSubstitutions: [{ requested: 1, applied: 2 }] }],
      [
        'an unknown reason',
        { modelSubstitutions: [{ requested: 1, applied: 2, reason: 'because' }] },
      ],
    ])('DROPS %s from the metadata rather than putting it on the wire', (_label, metadata) => {
      const snap = snapshotFromWorkflow(fakeWorkflow({ metadata }) as never);
      expect('modelSubstitutions' in snap).toBe(false);
    });

    it('keeps the VALID entries when a malformed one rides alongside', () => {
      const snap = snapshotFromWorkflow(
        fakeWorkflow({
          metadata: {
            modelSubstitutions: [
              { requested: 1, applied: 2, reason: 'because' },
              { requested: 3, applied: 4, reason: 'gated' },
            ],
          },
        }) as never
      );
      expect(snap.modelSubstitutions).toEqual([{ requested: 3, applied: 4, reason: 'gated' }]);
    });
  });

  // ---- image extraction across ALL image-producing step types --------------
  // The extractor accepts THREE step types (textToImage / imageGen / comfy);
  // the happy-path test above only exercises textToImage. These pin the other
  // two branches + the cross-step concatenation order.
  it('surfaces images from an imageGen step', () => {
    const wf = fakeWorkflow({
      steps: [
        {
          $type: 'imageGen',
          name: 's1',
          status: 'succeeded',
          metadata: {},
          output: { images: [{ id: 'g1', url: 'https://cdn/gen.png', available: true }] },
        },
      ],
    });
    const snap = snapshotFromWorkflow(wf as never);
    expect(snap.imageUrls).toEqual(['https://cdn/gen.png']);
  });

  it('surfaces images from a comfy step', () => {
    const wf = fakeWorkflow({
      steps: [
        {
          $type: 'comfy',
          name: 's1',
          status: 'succeeded',
          metadata: {},
          output: { images: [{ id: 'c1', url: 'https://cdn/comfy.png', available: true }] },
        },
      ],
    });
    const snap = snapshotFromWorkflow(wf as never);
    expect(snap.imageUrls).toEqual(['https://cdn/comfy.png']);
  });

  it('concatenates available images across mixed image-producing steps in step order', () => {
    const wf = fakeWorkflow({
      steps: [
        {
          $type: 'textToImage',
          name: 's1',
          status: 'succeeded',
          metadata: {},
          output: { images: [{ id: 'a', url: 'https://cdn/a.png', available: true }] },
        },
        {
          // A non-image step interleaved — must be skipped, not break ordering.
          $type: 'chatCompletion',
          name: 's2',
          status: 'succeeded',
          metadata: {},
          output: { images: [{ id: 'leak', url: 'https://leak/', available: true }] },
        },
        {
          $type: 'comfy',
          name: 's3',
          status: 'succeeded',
          metadata: {},
          output: { images: [{ id: 'b', url: 'https://cdn/b.png', available: true }] },
        },
      ],
    });
    const snap = snapshotFromWorkflow(wf as never);
    expect(snap.imageUrls).toEqual(['https://cdn/a.png', 'https://cdn/b.png']);
  });

  it('tolerates an image-producing step that carries no output (undefined images)', () => {
    const wf = fakeWorkflow({
      steps: [{ $type: 'textToImage', name: 's1', status: 'processing', metadata: {} }],
    });
    const snap = snapshotFromWorkflow(wf as never);
    expect(snap.imageUrls).toBeUndefined();
  });

  // ---- spentAccountType (money page blocks) --------------------------------
  // The snapshot surfaces the account that PRIMARILY funded the generation:
  // the accountType of the LARGEST realized debit on transactions.list.
  describe('spentAccountType (realized spent account)', () => {
    it('omits spentAccountType when there are no transactions (backward compatible)', () => {
      const snap = snapshotFromWorkflow(fakeWorkflow() as never);
      expect(snap.spentAccountType).toBeUndefined();
    });

    it('omits spentAccountType when the transactions list is empty', () => {
      const snap = snapshotFromWorkflow(
        fakeWorkflow({ transactions: { list: [] } }) as never
      );
      expect(snap.spentAccountType).toBeUndefined();
    });

    it('surfaces the accountType of the largest debit (split blue+green → green when green is larger)', () => {
      const snap = snapshotFromWorkflow(
        fakeWorkflow({
          transactions: {
            list: [
              { type: 'debit', amount: 10, accountType: 'blue' },
              { type: 'debit', amount: 90, accountType: 'green' },
            ],
          },
        }) as never
      );
      expect(snap.spentAccountType).toBe('green');
    });

    it('reports blue when blue is the largest debit (free-funded generation)', () => {
      const snap = snapshotFromWorkflow(
        fakeWorkflow({
          transactions: {
            list: [
              { type: 'debit', amount: 80, accountType: 'blue' },
              { type: 'debit', amount: 5, accountType: 'yellow' },
            ],
          },
        }) as never
      );
      expect(snap.spentAccountType).toBe('blue');
    });

    it('ignores credits when picking the largest debit', () => {
      const snap = snapshotFromWorkflow(
        fakeWorkflow({
          transactions: {
            list: [
              { type: 'debit', amount: 20, accountType: 'yellow' },
              // A larger CREDIT (refund/correction) must not be treated as a spend.
              { type: 'credit', amount: 100, accountType: 'green' },
            ],
          },
        }) as never
      );
      expect(snap.spentAccountType).toBe('yellow');
    });

    it('omits spentAccountType when the largest debit is an internal-only account (fakeRed)', () => {
      const snap = snapshotFromWorkflow(
        fakeWorkflow({
          transactions: { list: [{ type: 'debit', amount: 50, accountType: 'fakeRed' }] },
        }) as never
      );
      expect(snap.spentAccountType).toBeUndefined();
    });

    it('compares debits by MAGNITUDE, so negatively-signed debit amounts still rank (Math.abs)', () => {
      // The orchestrator may represent a debit as a negative amount. The picker
      // ranks by absolute value, so a -90 green debit must outrank a -10 blue one
      // (existing tests only use positive amounts — this pins the sign-agnostic
      // branch).
      const snap = snapshotFromWorkflow(
        fakeWorkflow({
          transactions: {
            list: [
              { type: 'debit', amount: -10, accountType: 'blue' },
              { type: 'debit', amount: -90, accountType: 'green' },
            ],
          },
        }) as never
      );
      expect(snap.spentAccountType).toBe('green');
    });

    it('breaks an equal-magnitude tie deterministically toward the FIRST debit (reduce keeps the accumulator)', () => {
      // Two debits of equal magnitude: the reduce keeps `a` on a non-strict-greater
      // `b`, so the FIRST-listed debit wins. Pinning this guards against a flip to
      // `>=` that would silently change which account gets reported.
      const snap = snapshotFromWorkflow(
        fakeWorkflow({
          transactions: {
            list: [
              { type: 'debit', amount: 50, accountType: 'green' },
              { type: 'debit', amount: 50, accountType: 'yellow' },
            ],
          },
        }) as never
      );
      expect(snap.spentAccountType).toBe('green');
    });

    it('treats a debit with no amount as 0, so a real debit outranks it', () => {
      const snap = snapshotFromWorkflow(
        fakeWorkflow({
          transactions: {
            list: [
              { type: 'debit', accountType: 'blue' }, // amount omitted → 0
              { type: 'debit', amount: 5, accountType: 'green' },
            ],
          },
        }) as never
      );
      expect(snap.spentAccountType).toBe('green');
    });

    it('omits spentAccountType when the ONLY entries are credits (no debit to attribute)', () => {
      const snap = snapshotFromWorkflow(
        fakeWorkflow({
          transactions: {
            list: [
              { type: 'credit', amount: 30, accountType: 'green' },
              { type: 'credit', amount: 5, accountType: 'yellow' },
            ],
          },
        }) as never
      );
      expect(snap.spentAccountType).toBeUndefined();
    });
  });
});

describe('appBlockTag', () => {
  it('formats the per-app subqueue tag', () => {
    expect(appBlockTag('app_abc')).toBe('app-block:app_abc');
  });
  it('is the SAME format the submit path stamps (stamp/read cannot desync)', () => {
    // buildWorkflowTags (blocks.router) stamps `app-block:${claims.appId}`; the
    // read filter calls appBlockTag(claims.appId). Pin the literal so a change to
    // one without the other is caught.
    const appId = 'oauthClient_123';
    expect(appBlockTag(appId)).toBe(`app-block:${appId}`);
  });
});

describe('projectAppWorkflow', () => {
  it('projects the happy path to the clean AppWorkflow wire shape', () => {
    const wf = fakeWorkflow({
      id: 'wf_a',
      createdAt: '2026-07-15T12:00:00.000Z',
      status: 'succeeded',
      cost: { total: 30 },
      steps: [
        {
          $type: 'textToImage',
          name: 's1',
          status: 'succeeded',
          metadata: {},
          output: {
            images: [
              {
                id: 'b1',
                url: 'https://cdn/i1.png',
                available: true,
                width: 1024,
                height: 768,
                nsfwLevel: 'pg',
                type: 'image',
              },
            ],
          },
        },
      ],
    });
    expect(projectAppWorkflow(wf as never)).toEqual({
      workflowId: 'wf_a',
      status: 'succeeded',
      images: [{ url: 'https://cdn/i1.png', width: 1024, height: 768, nsfwLevel: 1 }],
      cost: 30,
      createdAt: '2026-07-15T12:00:00.000Z',
    });
  });

  it('maps the orchestrator string nsfwLevel to the numeric browsing-level bitflag', () => {
    const cases: Array<[string, number | null]> = [
      ['g', 1], // SFW 'g' → PG (the raw map lacks it; canonical helper supplies it)
      ['pg', 1],
      ['pg13', 2],
      ['r', 4],
      ['x', 8],
      ['xxx', 16],
      ['na', null], // genuinely unrated → null
    ];
    for (const [rating, expected] of cases) {
      const wf = fakeWorkflow({
        steps: [
          {
            $type: 'textToImage',
            name: 's1',
            status: 'succeeded',
            metadata: {},
            output: {
              images: [{ id: 'b', url: 'https://cdn/x.png', available: true, nsfwLevel: rating }],
            },
          },
        ],
      });
      expect(projectAppWorkflow(wf as never).images[0].nsfwLevel).toBe(expected);
    }
  });

  it('nulls width/height/nsfwLevel when the orchestrator omits them', () => {
    const wf = fakeWorkflow({
      steps: [
        {
          $type: 'textToImage',
          name: 's1',
          status: 'succeeded',
          metadata: {},
          output: { images: [{ id: 'b', url: 'https://cdn/x.png', available: true }] },
        },
      ],
    });
    expect(projectAppWorkflow(wf as never).images[0]).toEqual({
      url: 'https://cdn/x.png',
      width: null,
      height: null,
      nsfwLevel: null,
    });
  });

  it('drops pending/blocked/urless blobs (no dead links leaked)', () => {
    const wf = fakeWorkflow({
      steps: [
        {
          $type: 'textToImage',
          name: 's1',
          status: 'processing',
          metadata: {},
          output: {
            images: [
              { id: 'b1', url: 'https://cdn/ok.png', available: true, type: 'image' },
              { id: 'b2', url: null, available: false, type: 'image' },
              { id: 'b3', url: 'https://cdn/blocked.png', available: false, type: 'image' },
              { id: 'b4', url: '', available: true, type: 'image' },
            ],
          },
        },
      ],
    });
    expect(projectAppWorkflow(wf as never).images).toEqual([
      { url: 'https://cdn/ok.png', width: null, height: null, nsfwLevel: null },
    ]);
  });

  it('maps orchestrator-internal statuses to the block-contract status set', () => {
    const map: Array<[string, string]> = [
      ['unassigned', 'pending'],
      ['preparing', 'pending'],
      ['scheduled', 'pending'],
      ['processing', 'processing'],
      ['succeeded', 'succeeded'],
      ['failed', 'failed'],
      ['expired', 'expired'],
      ['canceled', 'canceled'],
    ];
    for (const [orch, contract] of map) {
      expect(projectAppWorkflow(fakeWorkflow({ status: orch }) as never).status).toBe(contract);
    }
  });

  it('returns cost:null when the orchestrator omits a total, and an empty images list for a pending workflow', () => {
    const wf = fakeWorkflow({ status: 'preparing', cost: {}, steps: [] });
    const projected = projectAppWorkflow(wf as never);
    expect(projected.cost).toBeNull();
    expect(projected.images).toEqual([]);
    expect(projected.status).toBe('pending');
  });

  it('does NOT leak internal fields (steps/params/tags/transactions/metadata)', () => {
    const wf = fakeWorkflow({
      steps: [
        {
          $type: 'textToImage',
          name: 's1',
          status: 'succeeded',
          metadata: { params: { prompt: 'secret prompt' } },
          output: { images: [{ id: 'b', url: 'https://cdn/x.png', available: true }] },
        },
      ],
      tags: ['civitai', 'app-block:app_x'],
      transactions: { list: [{ type: 'debit', amount: 30, accountType: 'yellow' }] },
    });
    const projected = projectAppWorkflow(wf as never);
    expect(Object.keys(projected).sort()).toEqual(
      ['cost', 'createdAt', 'images', 'status', 'workflowId'].sort()
    );
    expect(JSON.stringify(projected)).not.toContain('secret prompt');
    expect(JSON.stringify(projected)).not.toContain('transactions');
  });

  it('ignores non-image-producing step types (no image leak from e.g. chatCompletion)', () => {
    const wf = fakeWorkflow({
      steps: [
        {
          $type: 'chatCompletion',
          name: 's1',
          status: 'succeeded',
          metadata: {},
          output: { images: [{ id: 'x', url: 'https://leak/', available: true }] },
        },
      ],
    });
    expect(projectAppWorkflow(wf as never).images).toEqual([]);
  });
});

describe('resolveBlockVersionContext', () => {
  beforeEach(() => {
    mockDbRead.modelVersion.findUnique.mockReset();
  });

  it('returns resolved fields when the version is published and belongs to the bound model', async () => {
    mockDbRead.modelVersion.findUnique.mockResolvedValue({
      id: 99,
      baseModel: 'SDXL 1.0',
      modelId: 7,
      status: 'Published',
      model: { id: 7, type: 'Checkpoint' },
    });
    const out = await resolveBlockVersionContext(99, 7);
    expect(out).toEqual({
      modelId: 7,
      modelVersionId: 99,
      baseModel: 'SDXL 1.0',
      modelType: 'Checkpoint',
      // `gate` is the additive entitlement context the resolver now returns
      // (early-access / availability / coverage / members-only). This mock only
      // stubs id/baseModel/status/model, so the optional gate fields resolve to
      // undefined and coverage defaults to false.
      gate: {
        id: 99,
        status: 'Published',
        availability: undefined,
        usageControl: undefined,
        baseModel: 'SDXL 1.0',
        covered: false,
        modelUserId: undefined,
        modelType: 'Checkpoint',
        modelVersionAlias: null,
      },
    });
  });

  it('throws NOT_FOUND when the version is missing', async () => {
    mockDbRead.modelVersion.findUnique.mockResolvedValue(null);
    await expect(resolveBlockVersionContext(99, 7)).rejects.toBeInstanceOf(TRPCError);
    await expect(resolveBlockVersionContext(99, 7)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('throws NOT_FOUND when the version is unpublished (no information leak about other models)', async () => {
    mockDbRead.modelVersion.findUnique.mockResolvedValue({
      id: 99,
      baseModel: 'SDXL 1.0',
      modelId: 7,
      status: 'Draft',
      model: { id: 7, type: 'Checkpoint' },
    });
    await expect(resolveBlockVersionContext(99, 7)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('throws FORBIDDEN when the version belongs to a different model than the bound one', async () => {
    mockDbRead.modelVersion.findUnique.mockResolvedValue({
      id: 99,
      baseModel: 'SDXL 1.0',
      modelId: 8,
      status: 'Published',
      model: { id: 8, type: 'Checkpoint' },
    });
    await expect(resolveBlockVersionContext(99, 7)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('buildTextToImageInput', () => {
  const baseBody = {
    kind: 'textToImage' as const,
    modelId: 7,
    modelVersionId: 99,
    params: {
      prompt: 'a cat',
      quantity: 1,
    },
  };
  // checkpointVersionId === body.modelVersionId for Checkpoint-bound installs
  // (resolveBlockCheckpoint returns the model as its own anchor). For LoRAs the
  // resolver returns a different versionId — represented here. `checkpointBaseModel`
  // is the RESOLVED checkpoint's baseModel (drives the graph `ecosystem`).
  const checkpointResolved = {
    baseModel: 'SDXL 1.0',
    modelType: 'Checkpoint',
    checkpointVersionId: 99,
    checkpointBaseModel: 'SDXL 1.0',
  };
  const sd1CheckpointResolved = {
    baseModel: 'SD 1.5',
    modelType: 'Checkpoint',
    checkpointVersionId: 99,
    checkpointBaseModel: 'SD 1.5',
  };
  const fluxLoraResolved = {
    baseModel: 'Flux.1 D',
    modelType: 'LORA',
    checkpointVersionId: 691639,
    checkpointBaseModel: 'Flux.1 D',
  };

  // New shape: the function now emits the flat generation-graph `input`
  // (`{ workflow, ecosystem, model, resources, prompt, ...top-level params }`)
  // rather than the legacy `{ params, resources }` GenerateImageSchema. The
  // checkpoint is the `model` anchor; `resources` holds ONLY additional networks
  // (LoRAs). Dimensions live on `aspectRatio` (raw here — the graph's
  // aspectRatio node snaps them to a canonical bucket at validation time).

  it('derives the graph ecosystem from the resolved checkpoint baseModel', () => {
    expect(buildTextToImageInput(baseBody as never, checkpointResolved).ecosystem).toBe('SDXL');
    expect(buildTextToImageInput(baseBody as never, sd1CheckpointResolved).ecosystem).toBe('SD1');
    expect(buildTextToImageInput(baseBody as never, fluxLoraResolved).ecosystem).toBe('Flux1');
  });

  it('fills SDXL/Flux-class defaults (1024x1024) when the block omits dimensions', () => {
    const out = buildTextToImageInput(baseBody as never, checkpointResolved) as {
      aspectRatio: { width: number; height: number };
    };
    expect(out.aspectRatio.width).toBe(1024);
    expect(out.aspectRatio.height).toBe(1024);
  });

  it('fills SD1/SD2 defaults (512x512) for older base models', () => {
    const out = buildTextToImageInput(baseBody as never, sd1CheckpointResolved) as {
      aspectRatio: { width: number; height: number };
    };
    expect(out.aspectRatio.width).toBe(512);
    expect(out.aspectRatio.height).toBe(512);
  });

  it('respects block-supplied width/height when set', () => {
    const body = {
      ...baseBody,
      params: { ...baseBody.params, width: 768, height: 1152 },
    };
    const out = buildTextToImageInput(body as never, checkpointResolved) as {
      aspectRatio: { value: string; width: number; height: number };
    };
    expect(out.aspectRatio.width).toBe(768);
    expect(out.aspectRatio.height).toBe(1152);
    expect(out.aspectRatio.value).toBe('768:1152');
  });

  it('defaults sampler/steps and pins workflow to txt2img', () => {
    const out = buildTextToImageInput(baseBody as never, checkpointResolved);
    expect(out.sampler).toBe('Euler');
    expect(out.steps).toBe(25);
    expect(out.workflow).toBe('txt2img');
    expect(out.priority).toBe('low');
    expect(out.prompt).toBe('a cat');
  });

  it('puts the bound Checkpoint at `model` with no additional resources', () => {
    const out = buildTextToImageInput(baseBody as never, checkpointResolved);
    expect(out.model).toEqual({ id: 99 });
    expect(out.resources).toEqual([]);
  });

  it('anchors `model` on the resolved checkpoint and pushes the bound LoRA into resources', () => {
    const out = buildTextToImageInput(baseBody as never, fluxLoraResolved);
    // The resolver picks 691639 for Flux1 family (publisher default in this
    // fixture); the host doesn't second-guess what the resolver returned. The
    // bound LoRA (body model 99) is the only additional network.
    expect(out.model).toEqual({ id: 691639 });
    expect(out.resources).toEqual([{ id: 99, strength: 1 }]);
  });

  it('forwards block-supplied sampler/steps/seed overrides', () => {
    const body = {
      ...baseBody,
      params: { ...baseBody.params, sampler: 'DPM++ 2M Karras', steps: 30, seed: 12345 },
    };
    const out = buildTextToImageInput(body as never, checkpointResolved);
    expect(out.sampler).toBe('DPM++ 2M Karras');
    expect(out.steps).toBe(30);
    expect(out.seed).toBe(12345);
  });

  // ── Page-LoRA (Increment 1): fan additionalResources into `resources` ──────
  it('fans N additional LoRAs into the resources array (checkpoint stays on `model`)', () => {
    const body = {
      ...baseBody,
      additionalResources: [
        { modelVersionId: 201, strength: 0.8 },
        { modelVersionId: 202, strength: 1.2 },
        { modelVersionId: 203, strength: -0.5 },
      ],
    };
    const out = buildTextToImageInput(body as never, checkpointResolved);
    expect(out.model).toEqual({ id: 99 });
    expect(out.resources).toEqual([
      { id: 201, strength: 0.8 },
      { id: 202, strength: 1.2 },
      { id: 203, strength: -0.5 },
    ]);
  });

  it('does NOT duplicate the checkpoint when an additionalResource repeats it', () => {
    const body = {
      ...baseBody,
      additionalResources: [
        { modelVersionId: 99, strength: 0.7 }, // same as the checkpoint anchor (`model`)
        { modelVersionId: 201, strength: 1 },
      ],
    };
    const out = buildTextToImageInput(body as never, checkpointResolved);
    // The checkpoint stays as the `model` anchor (no double-bill); only the
    // genuinely-new LoRA lands in resources.
    expect(out.model).toEqual({ id: 99 });
    expect(out.resources).toEqual([{ id: 201, strength: 1 }]);
  });

  it('does NOT duplicate the bound-model network when the body model is a LoRA', () => {
    // fluxLoraResolved: checkpointVersionId=691639 (resolver anchor → `model`),
    // body.modelVersionId=99 is itself a LoRA pushed into resources. An
    // additionalResource repeating either id must be deduped.
    const body = {
      ...baseBody,
      additionalResources: [
        { modelVersionId: 691639, strength: 0.5 }, // == checkpoint anchor (`model`)
        { modelVersionId: 99, strength: 0.5 }, // == bound-model network
        { modelVersionId: 300, strength: 0.9 }, // genuinely new
      ],
    };
    const out = buildTextToImageInput(body as never, fluxLoraResolved);
    expect(out.model).toEqual({ id: 691639 });
    expect(out.resources).toEqual([
      { id: 99, strength: 1 },
      { id: 300, strength: 0.9 },
    ]);
  });

  it('first-wins dedupe for a LoRA that appears twice in additionalResources', () => {
    const body = {
      ...baseBody,
      additionalResources: [
        { modelVersionId: 201, strength: 0.3 },
        { modelVersionId: 201, strength: 0.9 }, // duplicate id
      ],
    };
    const out = buildTextToImageInput(body as never, checkpointResolved);
    expect(out.resources).toEqual([{ id: 201, strength: 0.3 }]); // first occurrence kept
  });

  it('emits no additional resources when additionalResources is absent', () => {
    const out = buildTextToImageInput(baseBody as never, checkpointResolved);
    expect(out.model).toEqual({ id: 99 });
    expect(out.resources).toEqual([]);
  });
});

describe('isPageLoraResource', () => {
  it('returns true for the LoRA family (LORA / LoCon / DoRA)', () => {
    expect(isPageLoraResource('LORA')).toBe(true);
    expect(isPageLoraResource('LoCon')).toBe(true);
    expect(isPageLoraResource('DoRA')).toBe(true);
  });

  it('returns false for non-LoRA types (Checkpoint / VAE / TextualInversion)', () => {
    expect(isPageLoraResource('Checkpoint')).toBe(false);
    expect(isPageLoraResource('VAE')).toBe(false);
    expect(isPageLoraResource('TextualInversion')).toBe(false);
    expect(isPageLoraResource('Upscaler')).toBe(false);
  });
});

describe('resolvePageResourceContext', () => {
  beforeEach(() => {
    mockDbRead.modelVersion.findUnique.mockReset();
  });

  it('returns the gate bag + baseModel + modelType with NO modelId binding check', async () => {
    // Note: modelId (8) intentionally differs from any "expected" model — the
    // page resolver has no binding to enforce, so this resolves successfully
    // where resolveBlockVersionContext(…, 7) would FORBIDDEN.
    mockDbRead.modelVersion.findUnique.mockResolvedValue({
      id: 201,
      baseModel: 'SDXL 1.0',
      modelId: 8,
      status: 'Published',
      availability: 'Public',
      usageControl: 'Download',
      meta: null,
      generationCoverage: { covered: true },
      model: { id: 8, type: 'LORA', userId: 55 },
    });
    const out = await resolvePageResourceContext(201);
    expect(out).toEqual({
      modelId: 8,
      modelVersionId: 201,
      baseModel: 'SDXL 1.0',
      modelType: 'LORA',
      gate: {
        id: 201,
        status: 'Published',
        availability: 'Public',
        usageControl: 'Download',
        baseModel: 'SDXL 1.0',
        covered: true,
        modelUserId: 55,
        modelType: 'LORA',
        modelVersionAlias: null,
      },
    });
  });

  it('defaults covered to false when no generationCoverage row exists', async () => {
    mockDbRead.modelVersion.findUnique.mockResolvedValue({
      id: 201,
      baseModel: 'SDXL 1.0',
      modelId: 8,
      status: 'Published',
      availability: 'Public',
      usageControl: 'Download',
      meta: null,
      generationCoverage: null,
      model: { id: 8, type: 'LORA', userId: 55 },
    });
    const out = await resolvePageResourceContext(201);
    expect(out.gate.covered).toBe(false);
  });

  it('reads the generation alias from version.meta.generationAlias', async () => {
    mockDbRead.modelVersion.findUnique.mockResolvedValue({
      id: 201,
      baseModel: 'SDXL 1.0',
      modelId: 8,
      status: 'Published',
      availability: 'Public',
      usageControl: 'Download',
      meta: { generationAlias: { versionId: 999 } },
      generationCoverage: { covered: true },
      model: { id: 8, type: 'LORA', userId: 55 },
    });
    const out = await resolvePageResourceContext(201);
    expect(out.gate.modelVersionAlias).toEqual({ versionId: 999 });
  });

  it('throws NOT_FOUND when the version is missing', async () => {
    mockDbRead.modelVersion.findUnique.mockResolvedValue(null);
    await expect(resolvePageResourceContext(201)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('throws NOT_FOUND when the version is unpublished (no info leak)', async () => {
    mockDbRead.modelVersion.findUnique.mockResolvedValue({
      id: 201,
      baseModel: 'SDXL 1.0',
      modelId: 8,
      status: 'Draft',
      availability: 'Public',
      usageControl: 'Download',
      meta: null,
      generationCoverage: { covered: true },
      model: { id: 8, type: 'LORA', userId: 55 },
    });
    await expect(resolvePageResourceContext(201)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Integration-style: REAL block input → REAL graph validation → REAL params
// ─────────────────────────────────────────────────────────────────────────────
//
// WHY THIS EXISTS (the audit's 🟡 gap): the router-level tests in
// `src/server/routers/__tests__/blocks.router.workflow.test.ts` mock
// `createWorkflowStepsFromGraphInput` WHOLESALE — they hand the router a canned
// `{ workflowMetadata }` and assert the router attaches it to the real submit
// body / omits it on whatIf. That proves the router PLUMBING but NOT the PR's
// headline claim: that REAL block input, run through the ACTUAL param-mapping,
// yields a POPULATED `workflowMetadata.params`. A regression in
// `buildTextToImageInput` or the param snapshot (e.g. dropping `prompt`/`seed`,
// or the graph silently blanking them) would leave those plumbing tests green
// while shipping blank queue/remix metadata. This closes that gap.
//
// WHAT IS REAL vs STUBBED, and why:
//   • REAL  — `buildTextToImageInput` (the block→graph-input translator under
//             test), `generationGraph.safeParse` (the EXACT validator
//             `createWorkflowStepsFromGraph` runs via `validateInput`), and
//             `toStepMetadata` + `removeEmpty` (the EXACT param-snapshot fns
//             that build `workflowMetadata.params`). This is the whole
//             param-mapping path the PR touches — nothing about how `params` is
//             derived is mocked.
//   • STUBBED (by NOT running it) — resource ENRICHMENT
//             (`validateAndEnrichResources` → `getResourceData`, a DB/network
//             lookup) and the orchestrator step-input handlers. Those are
//             external IO and do NOT contribute to `params` (params come from
//             the validated graph output minus model/resources/vae). We re-run
//             `createWorkflowStepsFromGraph`'s param logic faithfully
//             (safeParse → toStepMetadata → removeEmpty) rather than calling
//             `createWorkflowStepsFromGraphInput`, which would drag in the real
//             DB client + event-engine-common import graph (un-runnable on this
//             host, and the reason the router tests mock it wholesale).
//
// HONEST LIMITATION: this asserts the params snapshot + the CHECKPOINT in
// `resources`. It does NOT assert ADDITIONAL LoRA resources land in
// `workflowMetadata.resources`, because the graph's `resources` node requires
// the enriched ResourceData map (from `getResourceData`) to validate unknown
// version ids — without enrichment `safeParse` rejects them. Faking that map
// would prove a mock, not real behavior, so the additional-resource→metadata
// linkage is intentionally left to the (mocked) router test's
// `realBody.metadata.resources` assertion. The checkpoint anchor, which the
// graph resolves WITHOUT enrichment, IS covered here.
describe('block input yields populated workflow metadata params (real graph path)', () => {
  // A free user's generation context — the same shape `buildGenerationContext`
  // produces, hand-built so the test stays off sysRedis/DB. The graph validator
  // reads limits/tier/gateRules from this; nothing here affects how `params` is
  // snapshotted.
  const externalCtx: GenerationCtx = {
    limits: { maxQuantity: 4, maxResources: 10, vidQuantity: 1 },
    user: { isMember: false, tier: 'free' },
    flags: {},
    selfHostedDisabledEcosystems: [],
    selfHostedMode: 'enabled',
    gateRules: [],
  };

  // Mirror of the param-snapshot CALCULATION inside
  // `createWorkflowStepsFromGraph`: validate the graph input, then
  // `removeEmpty(toStepMetadata(data).params)`. (Computed-key stripping and the
  // seed default also live there, but our body supplies a literal seed and our
  // asserted fields are all form inputs, never computed — so this faithfully
  // reproduces the `workflowMetadata.params` for this body.)
  function paramsFromRealGraph(input: Record<string, unknown>) {
    const result = generationGraph.safeParse(input, externalCtx);
    if (!result.success) {
      throw new Error(`graph validation failed: ${JSON.stringify(result.errors)}`);
    }
    const meta = toStepMetadata(result.data as never);
    return {
      params: removeEmpty(meta.params as Record<string, unknown>),
      resources: meta.resources,
    };
  }

  it('populates params (prompt/seed/sampler/cfgScale/steps) from real block input', () => {
    // A realistic form-shaped textToImage block body — the Extract<…,'textToImage'>
    // shape the iframe posts: per-image params the user set in the block UI.
    const body = {
      kind: 'textToImage' as const,
      modelId: 7,
      modelVersionId: 99,
      params: {
        prompt: 'a photo of a cat astronaut',
        negativePrompt: 'blurry, low quality',
        cfgScale: 7,
        sampler: 'Euler a',
        steps: 25,
        seed: 12345,
        quantity: 1,
      },
    };
    // checkpoint-bound install: the resolved checkpoint IS body.modelVersionId.
    const resolved = {
      baseModel: 'SDXL 1.0',
      modelType: 'Checkpoint',
      checkpointVersionId: 99,
      checkpointBaseModel: 'SDXL 1.0',
    };

    // REAL translator → REAL graph validation → REAL param snapshot.
    const input = buildTextToImageInput(body as never, resolved);
    const { params, resources } = paramsFromRealGraph(input);

    // The headline claim: params is POPULATED with the user's form fields
    // (verbatim), not blank. A regression that re-blanks block metadata fails here.
    expect(params).toMatchObject({
      workflow: 'txt2img',
      prompt: 'a photo of a cat astronaut',
      negativePrompt: 'blurry, low quality',
      cfgScale: 7,
      sampler: 'Euler a',
      steps: 25,
      seed: 12345,
      quantity: 1,
    });
    // ecosystem is derived from the checkpoint baseModel by the real translator.
    expect(params.ecosystem).toBe('SDXL');

    // The checkpoint anchor shows up in the resources snapshot (this is the part
    // of `workflowMetadata.resources` the graph resolves without enrichment).
    expect(resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 99, model: { type: 'Checkpoint' } }),
      ])
    );
  });

  it('snaps SD1 defaults and still populates params for an SD1.5 checkpoint', () => {
    // Cross-check a second ecosystem so the assertion isn't SDXL-specific: the
    // real graph must snap SD1.5 to 512² and carry the same form params through.
    const body = {
      kind: 'textToImage' as const,
      modelId: 7,
      modelVersionId: 99,
      params: { prompt: 'a dog', sampler: 'DPM++ 2M Karras', steps: 30, seed: 777, quantity: 2 },
    };
    const resolved = {
      baseModel: 'SD 1.5',
      modelType: 'Checkpoint',
      checkpointVersionId: 99,
      checkpointBaseModel: 'SD 1.5',
    };
    const input = buildTextToImageInput(body as never, resolved);
    const { params } = paramsFromRealGraph(input);
    expect(params).toMatchObject({
      workflow: 'txt2img',
      ecosystem: 'SD1',
      prompt: 'a dog',
      sampler: 'DPM++ 2M Karras',
      steps: 30,
      seed: 777,
      quantity: 2,
    });
    expect(params.aspectRatio).toMatchObject({ width: 512, height: 512 });
  });

  it('emitted img2img input validates through the REAL generation graph (SDXL)', () => {
    // Proves the generalized bridge output is graph-valid end-to-end: a bounded
    // source image → workflow:img2img with an images[] init node the SD-family
    // graph accepts (denoise applies at its default; aspectRatio is dropped).
    const body = {
      kind: 'textToImage' as const,
      modelId: 7,
      modelVersionId: 99,
      params: { prompt: 'a cat', quantity: 1 },
      sourceImage: { url: 'https://image.civitai.com/abc/def.jpeg', width: 768, height: 1024 },
    };
    const resolved = {
      baseModel: 'SDXL 1.0',
      modelType: 'Checkpoint',
      checkpointVersionId: 99,
      checkpointBaseModel: 'SDXL 1.0',
    };
    const input = buildImageWorkflowInput(body as never, resolved);
    const result = generationGraph.safeParse(input, externalCtx);
    if (!result.success) {
      throw new Error(`img2img graph validation failed: ${JSON.stringify(result.errors)}`);
    }
    expect((result.data as { workflow: string }).workflow).toBe('img2img');
    const images = (result.data as { images?: Array<{ url: string }> }).images;
    expect(images).toEqual([
      expect.objectContaining({ url: 'https://image.civitai.com/abc/def.jpeg' }),
    ]);
  });

  // Edit-capable ecosystems (EDIT_IMG_IDS) route a source-image body to
  // `img2img:edit`, NOT plain `img2img`. Prove end-to-end that the emitted input
  // validates through the REAL generation graph AND routes to img2img:edit (i.e.
  // the ecosystem is NOT silently auto-corrected) for each edit ecosystem — the
  // same `images` reference node the onsite generator feeds (openai-graph /
  // flux-kontext-graph / qwen-graph). `checkpointVersionId` uses each ecosystem's
  // real locked version id so the modelLocked graph doesn't remap it.
  it.each([
    ['OpenAI', 'OpenAI', 1733399],
    ['Qwen', 'Qwen', 2558804],
    ['Flux.1 Kontext', 'Flux1Kontext', 1892509],
  ])(
    'emitted img2img:edit input validates through the REAL graph for %s (ecosystem %s)',
    (baseModel, ecoKey, versionId) => {
      const body = {
        kind: 'textToImage' as const,
        modelId: 7,
        modelVersionId: versionId,
        params: { prompt: 'make the cat wear a hat', quantity: 1 },
        sourceImage: {
          url: 'https://image.civitai.com/abc/def.jpeg',
          width: 1024,
          height: 1024,
        },
      };
      const resolved = {
        baseModel,
        modelType: 'Checkpoint',
        checkpointVersionId: versionId,
        checkpointBaseModel: baseModel,
      };
      const input = buildImageWorkflowInput(body as never, resolved);
      // The builder routes to img2img:edit deterministically.
      expect(input.workflow).toBe('img2img:edit');
      expect(input.ecosystem).toBe(ecoKey);

      // The REAL graph accepts it AND keeps it routed to img2img:edit on the
      // asserted ecosystem (no auto-correction to a supported-but-wrong route).
      const result = generationGraph.safeParse(input, externalCtx);
      if (!result.success) {
        throw new Error(`img2img:edit graph validation failed: ${JSON.stringify(result.errors)}`);
      }
      const data = result.data as { workflow: string; ecosystem: string; images?: Array<{ url: string }> };
      expect(data.workflow).toBe('img2img:edit');
      expect(data.ecosystem).toBe(ecoKey);
      // The bounded source image rides into the graph's reference `images` node.
      expect(data.images).toEqual([
        expect.objectContaining({ url: 'https://image.civitai.com/abc/def.jpeg' }),
      ]);
    }
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// App Blocks IMAGE bridge (Phase-2a): generalized image-workflow builder
// ─────────────────────────────────────────────────────────────────────────────
describe('buildImageWorkflowInput (generalized image-workflow bridge)', () => {
  const baseBody = {
    kind: 'textToImage' as const,
    modelId: 7,
    modelVersionId: 99,
    params: { prompt: 'a cat', quantity: 1 },
  };
  const checkpointResolved = {
    baseModel: 'SDXL 1.0',
    modelType: 'Checkpoint',
    checkpointVersionId: 99,
    checkpointBaseModel: 'SDXL 1.0',
  };
  const validSourceImage = {
    url: 'https://image.civitai.com/abc/def.jpeg',
    width: 768,
    height: 1024,
  };

  it('exposes exactly the image workflow allowlist (txt2img, img2img, img2img:edit)', () => {
    expect([...BLOCK_IMAGE_WORKFLOW_TYPES]).toEqual(['txt2img', 'img2img', 'img2img:edit']);
  });

  it('resolveBlockImageWorkflowType derives the variant from body + ecosystem', () => {
    // No source image → txt2img regardless of ecosystem.
    expect(resolveBlockImageWorkflowType(baseBody as never)).toBe('txt2img');
    expect(resolveBlockImageWorkflowType(baseBody as never, ECO.OpenAI)).toBe('txt2img');
    // Source image + SD-family ecosystem → img2img.
    expect(
      resolveBlockImageWorkflowType(
        { ...baseBody, sourceImage: validSourceImage } as never,
        ECO.SDXL
      )
    ).toBe('img2img');
    // Source image + edit-capable ecosystem → img2img:edit.
    for (const eco of [ECO.OpenAI, ECO.Qwen, ECO.Flux1Kontext]) {
      expect(
        resolveBlockImageWorkflowType({ ...baseBody, sourceImage: validSourceImage } as never, eco)
      ).toBe('img2img:edit');
    }
    // Source image + ecosystem that supports neither img2img variant (Flux.1 →
    // Flux1, txt2img-only) → BAD_REQUEST.
    let caught: unknown;
    try {
      resolveBlockImageWorkflowType(
        { ...baseBody, sourceImage: validSourceImage } as never,
        ECO.Flux1
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TRPCError);
    expect(caught).toMatchObject({ code: 'BAD_REQUEST' });
    // Source image + unknown ecosystem (undefined) → BAD_REQUEST too.
    expect(() =>
      resolveBlockImageWorkflowType({ ...baseBody, sourceImage: validSourceImage } as never)
    ).toThrow(TRPCError);
  });

  it('emits workflow:img2img + an images[] init image when a source image is present', () => {
    const body = { ...baseBody, sourceImage: validSourceImage };
    const out = buildImageWorkflowInput(body as never, checkpointResolved);
    expect(out.workflow).toBe('img2img');
    // The graph's imagesNode consumes { url, width, height }.
    expect(out.images).toEqual([
      { url: 'https://image.civitai.com/abc/def.jpeg', width: 768, height: 1024 },
    ]);
    // Dimensions come from the source image in img2img → aspectRatio is omitted
    // (the SD graph gates aspectRatio to `when: !hasImages`).
    expect(out.aspectRatio).toBeUndefined();
    // The checkpoint anchor + cost-profile fields are unchanged.
    expect(out.model).toEqual({ id: 99 });
    expect(out.quantity).toBe(1);
    expect(out.priority).toBe('low');
  });

  it('emits workflow:txt2img (with aspectRatio, no images) when there is no source image', () => {
    const out = buildImageWorkflowInput(baseBody as never, checkpointResolved);
    expect(out.workflow).toBe('txt2img');
    expect(out.images).toBeUndefined();
    expect(out.aspectRatio).toMatchObject({ width: 1024, height: 1024 });
  });

  it('buildTextToImageInput is the same builder (back-compat alias) and stays txt2img-compatible', () => {
    expect(buildTextToImageInput).toBe(buildImageWorkflowInput);
    const out = buildTextToImageInput(baseBody as never, checkpointResolved);
    expect(out.workflow).toBe('txt2img');
  });

  it('rejects a non-image (explicit) workflow type fail-closed with BAD_REQUEST', () => {
    let caught: unknown;
    try {
      buildImageWorkflowInput(baseBody as never, checkpointResolved, 'txt2vid');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TRPCError);
    expect(caught).toMatchObject({ code: 'BAD_REQUEST' });
    expect((caught as TRPCError).message).toMatch(/only image workflows/);
  });

  it('preserves the LoRA-stack fan-out on the img2img path (gates + resources unchanged)', () => {
    // The additionalResources fan-out (each entry gated per-item upstream in the
    // router) must apply identically whether or not a source image is present —
    // generalizing the builder must not drop the resource path.
    const body = {
      ...baseBody,
      sourceImage: validSourceImage,
      additionalResources: [
        { modelVersionId: 201, strength: 0.8 },
        { modelVersionId: 202, strength: 1.2 },
      ],
    };
    const out = buildImageWorkflowInput(body as never, checkpointResolved);
    expect(out.workflow).toBe('img2img');
    expect(out.model).toEqual({ id: 99 });
    expect(out.resources).toEqual([
      { id: 201, strength: 0.8 },
      { id: 202, strength: 1.2 },
    ]);
    // The init image rides alongside the resources — both are present.
    expect(out.images).toHaveLength(1);
  });

  it('carries the same cost-profile fields on img2img as txt2img (budget preflight sees the same shape)', () => {
    // The router's budget preflight costs the built input via the orchestrator
    // whatIf. Generalizing to img2img must not change the fields that drive cost
    // (quantity / priority / prompt / resources) — only add the init image.
    const txt = buildImageWorkflowInput(baseBody as never, checkpointResolved);
    const img = buildImageWorkflowInput(
      { ...baseBody, sourceImage: validSourceImage } as never,
      checkpointResolved
    );
    for (const key of ['quantity', 'priority', 'prompt', 'model', 'resources', 'ecosystem']) {
      expect(img[key]).toEqual(txt[key]);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// App Blocks IMAGE bridge: img2img variant selection + fail-close guard
//
// Plain `img2img` ("Image Variations") is SD-family-only and `img2img:edit` is
// EDIT_IMG_IDS-only (OpenAI/Qwen/Flux Kontext/…) in the generation graph.
// buildImageWorkflowInput must (a) route SD-family checkpoints to `img2img`, (b)
// route edit-capable checkpoints to `img2img:edit`, and (c) reject a checkpoint
// whose ecosystem supports NEITHER variant with BAD_REQUEST — deterministically,
// rather than let DataGraph.safeParse silently auto-correct the ecosystem and
// return a mis-routed graph as success.
// ─────────────────────────────────────────────────────────────────────────────
describe('buildImageWorkflowInput img2img variant selection + ecosystem guard', () => {
  const baseBody = {
    kind: 'textToImage' as const,
    modelId: 7,
    modelVersionId: 99,
    params: { prompt: 'a cat', quantity: 1 },
    sourceImage: { url: 'https://image.civitai.com/abc/def.jpeg', width: 768, height: 1024 },
  };
  const resolved = (checkpointBaseModel: string) => ({
    baseModel: checkpointBaseModel,
    modelType: 'Checkpoint',
    checkpointVersionId: 99,
    checkpointBaseModel,
  });

  // baseModel → expected graph ecosystem key. These are the SD-family members
  // configured for plain img2img (SD_FAMILY_IDS).
  it.each([
    ['SDXL 1.0', 'SDXL'],
    ['SD 1.5', 'SD1'],
    ['Pony', 'Pony'],
    ['Illustrious', 'Illustrious'],
    ['NoobAI', 'NoobAI'],
  ])('builds img2img for SD-family checkpoint %s (ecosystem %s)', (baseModel, ecoKey) => {
    const out = buildImageWorkflowInput(baseBody as never, resolved(baseModel));
    expect(out.workflow).toBe('img2img');
    expect(out.ecosystem).toBe(ecoKey);
    expect(out.images).toHaveLength(1);
  });

  // Edit-capable checkpoints (EDIT_IMG_IDS): plain img2img is NOT available but
  // img2img:edit IS — the builder must route them to `img2img:edit` (NOT reject,
  // NOT silently SD1-correct) and still carry the source image.
  it.each([
    ['Flux.1 Kontext', 'Flux1Kontext'],
    ['Qwen', 'Qwen'],
    ['OpenAI', 'OpenAI'],
  ])('builds img2img:edit for edit-capable checkpoint %s (ecosystem %s)', (baseModel, ecoKey) => {
    const out = buildImageWorkflowInput(baseBody as never, resolved(baseModel));
    expect(out.workflow).toBe('img2img:edit');
    expect(out.ecosystem).toBe(ecoKey);
    expect(out.images).toHaveLength(1);
    // aspectRatio is omitted for the edit variant (graph default applies).
    expect(out.aspectRatio).toBeUndefined();
  });

  // Checkpoints whose ecosystem supports NEITHER img2img variant: the builder
  // must throw BAD_REQUEST (not silently emit an auto-corrected graph). Flux.1 D
  // (Flux1) / Chroma are txt2img-only; SD 3.5 / SD 2.1 are in neither set.
  it.each(['Flux.1 D', 'SD 3.5', 'Chroma', 'SD 2.1'])(
    'rejects img2img for a no-img2img-variant checkpoint %s with BAD_REQUEST',
    (baseModel) => {
      let caught: unknown;
      try {
        buildImageWorkflowInput(baseBody as never, resolved(baseModel));
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(TRPCError);
      expect(caught).toMatchObject({ code: 'BAD_REQUEST' });
      expect((caught as TRPCError).message).toMatch(/not supported/);
    }
  );

  it('still builds txt2img (no source image) for a non-SD-family checkpoint (guard is img2img-only)', () => {
    // The guard must not affect the txt2img path — a Flux block with no source
    // image is unchanged.
    const { sourceImage, ...txtBody } = baseBody;
    void sourceImage;
    const out = buildImageWorkflowInput(txtBody as never, resolved('Flux.1 D'));
    expect(out.workflow).toBe('txt2img');
    expect(out.ecosystem).toBe('Flux1');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Edit-only checkpoint version submitted with NO sourceImage
// ─────────────────────────────────────────────────────────────────────────────
//
// The bridge chooses its workflow purely from `sourceImage` presence, so naming
// an EDIT-ONLY checkpoint version and omitting `sourceImage` resolves to
// `txt2img`. What the graph does with that then depends on whether the
// ecosystem is `modelLocked`:
//
//   modelLocked (Qwen, MageFlow, 23 of 35 image ecosystems)
//     The `checkpointInputSchema` clamp in common.ts replaces the id with the
//     workflow's `defaultModelId` and returns SUCCESS. The caller is billed and
//     gets images from a checkpoint it never asked for, with nothing in the
//     response or the `block_workflows` read-model revealing the swap.
//   not modelLocked (Boogu, SDXL, Flux1, …)
//     The id survives, the mode discriminator routes to the edit subgraph, and
//     validation then FAILS on the missing image. A plain error, not a swap.
//
// So this guard is a correctness fix on the first group and an
// earlier/clearer error on the second. Both are covered below.
//
// The version lists are real config (qwen-graph / boogu-graph / mage-flow-graph
// `workflowVersions`), read through `workflow-capability`'s graph probe — no
// hardcoded id table lives in the guard.
describe('edit-only checkpoint version + no sourceImage', () => {
  // Qwen (modelLocked, txt2img default 2552908). Model 2268063 hosts BOTH:
  // 2558804 is "Image Edit 2511" (img2img:edit only), 2552908 is v2512 (txt2img
  // only). Same model, disjoint workflows.
  const QWEN_EDIT_V2511 = 2558804;
  const QWEN_TXT_V2512 = 2552908;
  // The INDEX-0 members of each list — the discriminator pair. Index-mapping
  // would send QWEN_EDIT_V2509 to QWEN_TXT_V2509; the clamp sends it to the
  // default, QWEN_TXT_V2512.
  const QWEN_EDIT_V2509 = 2133258;
  const QWEN_TXT_V2509 = 2110043;
  // Boogu: Edit / Edit Turbo are img2img:edit-only; Base / Turbo are
  // txt2img-only. NOT modelLocked — see the characterization test below.
  const BOOGU_EDIT = 3049824;
  const BOOGU_BASE = 3049541;
  // MageFlow (modelLocked, txt2img default 3172038): Standard(edit) vs
  // Standard(txt2img).
  const MAGEFLOW_EDIT_STANDARD = 3172043;
  const MAGEFLOW_TXT_STANDARD = 3172038;
  // MageFlow's INDEX-1 pair, the second discriminator: index-mapping would send
  // edit_turbo to txt2img_turbo (3172039); the clamp sends it to 3172038.
  const MAGEFLOW_EDIT_TURBO = 3172044;
  const MAGEFLOW_TXT_TURBO = 3172039;

  const body = (over: Record<string, unknown> = {}) => ({
    kind: 'textToImage' as const,
    modelId: 2268063,
    modelVersionId: QWEN_EDIT_V2511,
    params: { prompt: 'a cat', quantity: 1 },
    ...over,
  });
  const resolved = (checkpointVersionId: number, checkpointBaseModel = 'Qwen') => ({
    baseModel: checkpointBaseModel,
    modelType: 'Checkpoint',
    checkpointVersionId,
    checkpointBaseModel,
  });
  const sourceImage = {
    url: 'https://image.civitai.com/abc/def.jpeg',
    width: 1024,
    height: 1024,
  };

  function catchError(fn: () => unknown): unknown {
    try {
      fn();
    } catch (e) {
      return e;
    }
    return undefined;
  }

  // ── WHAT THE GUARD REJECTS ─────────────────────────────────────────────────
  //
  // Qwen and MageFlow are the SILENT-SWAP cases (`modelLocked`) — those are the
  // correctness fix. Boogu is NOT `modelLocked`: it already failed loudly with
  // "An image is required", so the guard only moves that error earlier and
  // makes it name the remedy. Rejecting all three uniformly is the point; the
  // difference is in what was happening before, not in what happens now.
  it.each([
    ['Qwen', QWEN_EDIT_V2511, 'Qwen'],
    ['Boogu', BOOGU_EDIT, 'Boogu'],
    ['MageFlow', MAGEFLOW_EDIT_STANDARD, 'MageFlow'],
  ])(
    'rejects an edit-only %s version submitted with no sourceImage',
    (_eco, versionId, baseModel) => {
      const caught = catchError(() =>
        buildImageWorkflowInput(
          body({ modelVersionId: versionId }) as never,
          resolved(versionId, baseModel)
        )
      );
      expect(caught).toBeInstanceOf(TRPCError);
      expect(caught).toMatchObject({ code: 'BAD_REQUEST' });
    }
  );

  it('names the actual fix in the error message', () => {
    const caught = catchError(() =>
      buildImageWorkflowInput(body() as never, resolved(QWEN_EDIT_V2511))
    ) as TRPCError;
    // Points at the offending version, the workflow it IS for, the sourceImage
    // remedy, AND the concrete txt2img version to use instead.
    expect(caught.message).toContain(String(QWEN_EDIT_V2511));
    expect(caught.message).toContain('img2img:edit');
    expect(caught.message).toContain('sourceImage');
    expect(caught.message).toContain(String(QWEN_TXT_V2512));
  });

  // NOTE: same-position is the GUARD's own suggestion policy (it reads the
  // graph's `buildVersionMappings` pairing to name a useful alternative in the
  // error). It is NOT what the graph does when it substitutes — that is the
  // default-clamp, pinned by the characterization tests at the bottom.
  it.each([
    [BOOGU_EDIT, 'Boogu', BOOGU_BASE],
    [MAGEFLOW_EDIT_STANDARD, 'MageFlow', MAGEFLOW_TXT_STANDARD],
  ])(
    'suggests the same-position txt2img sibling for version %s',
    (versionId, baseModel, expectedSuggestion) => {
      const caught = catchError(() =>
        buildImageWorkflowInput(
          body({ modelVersionId: versionId }) as never,
          resolved(versionId, baseModel)
        )
      ) as TRPCError;
      expect(caught.message).toContain(String(expectedSuggestion));
    }
  );

  it('guards the RESOLVED CHECKPOINT version, not body.modelVersionId (LoRA install)', () => {
    // A LoRA-bound install: the body names the LoRA, the resolver picked the
    // edit-only checkpoint. The guard must fire on the checkpoint.
    const caught = catchError(() =>
      buildImageWorkflowInput(body({ modelVersionId: 555001 }) as never, {
        baseModel: 'Qwen',
        modelType: 'LORA',
        checkpointVersionId: QWEN_EDIT_V2511,
        checkpointBaseModel: 'Qwen',
      })
    );
    expect(caught).toMatchObject({ code: 'BAD_REQUEST' });
  });

  // ── NO REGRESSION ──────────────────────────────────────────────────────────
  it('still accepts an edit-only version WITH a sourceImage (img2img:edit)', () => {
    const out = buildImageWorkflowInput(
      body({ sourceImage }) as never,
      resolved(QWEN_EDIT_V2511)
    );
    expect(out.workflow).toBe('img2img:edit');
    expect(out.ecosystem).toBe('Qwen');
    // The version the caller asked for is the one that anchors the graph.
    expect(out.model).toEqual({ id: QWEN_EDIT_V2511 });
  });

  it.each([
    [QWEN_TXT_V2512, 'Qwen'],
    [BOOGU_BASE, 'Boogu'],
    [MAGEFLOW_TXT_STANDARD, 'MageFlow'],
  ])('still accepts a txt2img-capable version %s with no sourceImage', (versionId, baseModel) => {
    const out = buildImageWorkflowInput(
      body({ modelVersionId: versionId }) as never,
      resolved(versionId, baseModel)
    );
    expect(out.workflow).toBe('txt2img');
    expect(out.model).toEqual({ id: versionId });
  });

  // An ecosystem whose txt2img and img2img:edit offer the SAME version list is
  // not workflow-scoped at all — both modes must keep working on one version.
  it.each([
    ['Flux.2 D', 'Flux2', 2439067],
    ['OpenAI', 'OpenAI', 1733399],
  ])(
    'keeps BOTH modes working for the dual-capable ecosystem %s',
    (baseModel, ecoKey, versionId) => {
      const txt = buildImageWorkflowInput(
        body({ modelVersionId: versionId }) as never,
        resolved(versionId, baseModel)
      );
      expect(txt.workflow).toBe('txt2img');
      expect(txt.ecosystem).toBe(ecoKey);
      expect(txt.model).toEqual({ id: versionId });

      const edit = buildImageWorkflowInput(
        body({ modelVersionId: versionId, sourceImage }) as never,
        resolved(versionId, baseModel)
      );
      expect(edit.workflow).toBe('img2img:edit');
      expect(edit.ecosystem).toBe(ecoKey);
      expect(edit.model).toEqual({ id: versionId });
    }
  );

  it('leaves an UNLISTED community checkpoint of a scoped ecosystem alone', () => {
    // Not in ANY of Qwen's workflow version lists → the graph would not have
    // substituted it, so the guard must not invent a rejection.
    const out = buildImageWorkflowInput(
      body({ modelVersionId: 987654321 }) as never,
      resolved(987654321)
    );
    expect(out.workflow).toBe('txt2img');
    expect(out.model).toEqual({ id: 987654321 });
  });

  it('leaves an ecosystem with no version scoping alone (SDXL)', () => {
    const out = buildImageWorkflowInput(
      body({ modelVersionId: 128078 }) as never,
      resolved(128078, 'SDXL 1.0')
    );
    expect(out.workflow).toBe('txt2img');
  });

  // ── REVERSE DIRECTION UNCHANGED ────────────────────────────────────────────
  it('leaves the pre-existing "neither img2img variant" rejection unchanged', () => {
    const caught = catchError(() =>
      buildImageWorkflowInput(body({ sourceImage }) as never, resolved(99, 'SD 3.5'))
    ) as TRPCError;
    expect(caught).toBeInstanceOf(TRPCError);
    expect(caught.message).toMatch(/img2img \(source image\) is not supported/);
  });

  // ── THE UNDERLYING PLATFORM BEHAVIOUR THIS DEFENDS AGAINST ─────────────────
  //
  // Characterization tests, run against the REAL graph: this is what used to
  // happen — and still happens to anything that reaches the graph with this
  // shape. If the graph ever starts rejecting instead of substituting, or
  // starts substituting by a DIFFERENT rule, these fail and tell us the guard's
  // premise changed.
  //
  // The mechanism is the `modelLocked` clamp in `createCheckpointGraph`'s
  // `checkpointInputSchema` (`shared/data-graph/generation/common.ts`): on a
  // `modelLocked` ecosystem, any id not in the CURRENT workflow's visible list
  // is replaced with that workflow's `defaultModelId`. It is NOT
  // `buildModelTransform`'s same-index sibling mapping: that transform is gated
  // on `!isDirectUpdate`, and a one-shot `safeParse` passing `model` explicitly
  // is a direct update, so it never runs on this path at all.
  //
  // Naming the right mechanism is load-bearing, so these cases are chosen to
  // DISCRIMINATE between the two candidates rather than merely to observe that
  // "some substitution happens". The two hypotheses agree only where the input's
  // same-index sibling happens to BE the workflow default (Qwen's index-1 pair,
  // the row the original test used); every other row below is a case where they
  // predict different ids, and the graph picks the default every time.
  const graphCtx: GenerationCtx = {
    limits: { maxQuantity: 4, maxResources: 10, vidQuantity: 1 },
    user: { isMember: false, tier: 'free' },
    flags: {},
    selfHostedDisabledEcosystems: [],
    selfHostedMode: 'enabled',
    gateRules: [],
  };
  // The exact input the bridge used to emit for "edit version, no sourceImage".
  const parseGraph = (over: Record<string, unknown>) =>
    generationGraph.safeParse(
      {
        workflow: 'txt2img',
        resources: [],
        prompt: 'a cat',
        sampler: 'Euler',
        steps: 25,
        quantity: 1,
        priority: 'low',
        aspectRatio: { value: '1024:1024', width: 1024, height: 1024 },
        ...over,
      },
      graphCtx
    );
  const parsedModelId = (r: ReturnType<typeof parseGraph>) =>
    (r.data as { model?: { id?: number } } | undefined)?.model?.id;

  it.each([
    // label                                  | eco        | input             | index-map predicts | actual
    ['index 1 — both hypotheses agree', 'Qwen', QWEN_EDIT_V2511, QWEN_TXT_V2512, QWEN_TXT_V2512],
    // ↓ THE DISCRIMINATOR. Index-mapping predicts QWEN_TXT_V2509 (2110043);
    //   the default-clamp predicts QWEN_TXT_V2512 (2552908). The graph returns
    //   the default. Delete the clamp and this case changes answer.
    ['index 0 — DISCRIMINATOR', 'Qwen', QWEN_EDIT_V2509, QWEN_TXT_V2509, QWEN_TXT_V2512],
    // ↓ MageFlow's index-1 pair is a second, independent discriminator:
    //   index-mapping predicts txt2img_turbo (3172039), the clamp predicts the
    //   ecosystem default txt2img_standard (3172038).
    [
      'index 1 — DISCRIMINATOR',
      'MageFlow',
      MAGEFLOW_EDIT_TURBO,
      MAGEFLOW_TXT_TURBO,
      MAGEFLOW_TXT_STANDARD,
    ],
  ])(
    'graph SILENTLY SUBSTITUTES to the workflow DEFAULT, not the same-index sibling (%s, %s)',
    (_label, ecosystem, inputId, sameIndexSibling, expected) => {
      const result = parseGraph({ ecosystem, model: { id: inputId } });
      expect(result.success).toBe(true);
      // Success — with a DIFFERENT checkpoint than the one that was asked for.
      expect(parsedModelId(result)).toBe(expected);
      // …and specifically NOT the same-index sibling, wherever the two differ.
      // This is the assertion that makes the test mechanism-specific: without
      // it, an index-mapping implementation would pass the row above too.
      if (sameIndexSibling !== expected) {
        expect(parsedModelId(result)).not.toBe(sameIndexSibling);
      }
    }
  );

  // The wider class the guard does NOT close, pinned so #3520's scope is a
  // measured fact rather than a description. An id the ecosystem has never
  // heard of is substituted just the same on a `modelLocked` ecosystem — it is
  // NOT "left alone".
  it.each([
    ['Qwen', QWEN_TXT_V2512],
    ['MageFlow', MAGEFLOW_TXT_STANDARD],
  ])(
    'graph substitutes even an UNRECOGNIZED id on modelLocked %s (tracked in #3520)',
    (ecosystem, expectedDefault) => {
      const result = parseGraph({ ecosystem, model: { id: 987654321 } });
      expect(result.success).toBe(true);
      expect(parsedModelId(result)).toBe(expectedDefault);
    }
  );

  // The contrast case that proves the clamp — not the workflow routing — is
  // what does the substituting. Boogu ships the same per-workflow version
  // scoping but is NOT `modelLocked`, so an unrecognized id survives untouched
  // and an edit-only id fails loudly instead of being swapped.
  it('does NOT substitute on a NON-modelLocked ecosystem (Boogu)', () => {
    const unknown = parseGraph({ ecosystem: 'Boogu', model: { id: 987654321 } });
    expect(unknown.success).toBe(true);
    expect(parsedModelId(unknown)).toBe(987654321);

    // The edit-only version resolves to the edit subgraph and then trips on the
    // missing image — a plain error, never a silent swap. So for Boogu this
    // PR's guard is an earlier, better-worded error, not a correctness fix.
    const editOnly = parseGraph({ ecosystem: 'Boogu', model: { id: BOOGU_EDIT } });
    expect(editOnly.success).toBe(false);
  });

  // The reverse direction is the same substitution, and is deliberately NOT
  // rejected by this PR (see #3520 / the guard's SCOPE docblock).
  it('graph substitutes in the REVERSE direction too (txt2img-only version + images)', () => {
    const result = parseGraph({
      workflow: 'img2img:edit',
      ecosystem: 'Qwen',
      model: { id: QWEN_TXT_V2512 },
      images: [sourceImage],
    });
    expect(result.success).toBe(true);
    expect(parsedModelId(result)).toBe(QWEN_EDIT_V2511);
  });

  // ── The exported helper itself ─────────────────────────────────────────────
  it('assertCheckpointVersionSupportsWorkflow is direction-agnostic', () => {
    // The txt2img-only version offered on img2img:edit is equally wrong; the
    // helper reports it even though the bridge only calls it for txt2img today.
    const caught = catchError(() =>
      assertCheckpointVersionSupportsWorkflow({
        ecosystem: 'Qwen',
        ecosystemId: ECO.Qwen,
        workflow: 'img2img:edit',
        checkpointVersionId: QWEN_TXT_V2512,
      })
    ) as TRPCError;
    expect(caught).toBeInstanceOf(TRPCError);
    expect(caught.message).toContain('txt2img');
    expect(caught.message).toContain(String(QWEN_EDIT_V2511));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// App Blocks IMAGE bridge (Phase-2a): source-image URL bound (untrusted iframe)
// ─────────────────────────────────────────────────────────────────────────────
describe('blockWorkflowBodySchema sourceImage bound (SSRF / arbitrary-URL guard)', () => {
  const baseBody = {
    kind: 'textToImage' as const,
    modelId: 7,
    modelVersionId: 99,
    params: { prompt: 'a cat', quantity: 1 },
  };
  function parseWithSource(url: string) {
    return blockWorkflowBodySchema.safeParse({
      ...baseBody,
      sourceImage: { url, width: 768, height: 1024 },
    });
  }

  it('accepts a body with NO source image (byte-compatible txt2img path)', () => {
    const res = blockWorkflowBodySchema.safeParse(baseBody);
    expect(res.success).toBe(true);
  });

  it('accepts a Civitai-hosted https source image (orchestrator / CDN / apex)', () => {
    expect(parseWithSource('https://orchestration.civitai.com/v2/blobs/abc.jpeg').success).toBe(
      true
    );
    expect(parseWithSource('https://image.civitai.com/abc/def.jpeg').success).toBe(true);
    expect(parseWithSource('https://civitai.com/images/xyz.jpeg').success).toBe(true);
    expect(parseWithSource('https://image.civitai.red/abc/def.jpeg').success).toBe(true);
  });

  it('rejects an arbitrary/remote source-image URL', () => {
    expect(parseWithSource('https://evil.example/x.png').success).toBe(false);
    expect(parseWithSource('https://cdn.attacker.io/leak.png').success).toBe(false);
  });

  it('rejects a non-https URL (no http SSRF)', () => {
    expect(parseWithSource('http://image.civitai.com/abc.jpeg').success).toBe(false);
    expect(parseWithSource('ftp://image.civitai.com/abc.jpeg').success).toBe(false);
  });

  it('rejects a host-confusion URL that merely CONTAINS a civitai host as a substring', () => {
    // The bound is hostname-based, not substring — so this attacker origin is
    // rejected where a `.includes("image.civitai.com")` check would accept it.
    expect(parseWithSource('https://evil.example/?x=image.civitai.com').success).toBe(false);
    expect(parseWithSource('https://image.civitai.com.evil.example/x.png').success).toBe(false);
  });

  it('rejects out-of-bound source-image dimensions', () => {
    expect(
      blockWorkflowBodySchema.safeParse({
        ...baseBody,
        sourceImage: { url: 'https://image.civitai.com/a.jpeg', width: 99999, height: 1024 },
      }).success
    ).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// customComfy bridge (App Blocks customComfy bridge, v1) — INERT building blocks.
// ─────────────────────────────────────────────────────────────────────────────
describe('blockWorkflowBodySchema: customComfy member', () => {
  it('accepts a registered recipe with opaque params', () => {
    const r = blockWorkflowBodySchema.safeParse({
      kind: 'customComfy',
      recipe: REGISTERED_RECIPE_IDS[0],
      params: { prompt: 'an icy lake', engine: 'zimage-turbo' },
    });
    expect(r.success).toBe(true);
  });

  it('rejects an unregistered recipe id at the wire schema (fail-closed)', () => {
    const r = blockWorkflowBodySchema.safeParse({
      kind: 'customComfy',
      recipe: 'not-a-real-recipe',
      params: {},
    });
    expect(r.success).toBe(false);
  });

  it('rejects an extra top-level field (.strict())', () => {
    const r = blockWorkflowBodySchema.safeParse({
      kind: 'customComfy',
      recipe: REGISTERED_RECIPE_IDS[0],
      params: {},
      sneaky: 1,
    });
    expect(r.success).toBe(false);
  });

  it('still parses an existing textToImage body (union widened, not replaced)', () => {
    const r = blockWorkflowBodySchema.safeParse({
      kind: 'textToImage',
      modelId: 1,
      modelVersionId: 2,
      params: { prompt: 'hi' },
    });
    expect(r.success).toBe(true);
  });
});

describe('buildCustomComfyWorkflowInput (translator)', () => {
  const recipe = getRecipe('seamless-pano-360')!;

  it('applies the recipe param schema then runs its pure builder', () => {
    const input = buildCustomComfyWorkflowInput(recipe, { prompt: 'a lake', seed: 1, engine: 'zimage-turbo' });
    expect(input.trace).toBe('binary');
    expect(input.resources[0]).toContain('z_image_turbo');
    expect(input.workflow['1'].class_type).toBe('UNETLoader');
    // seed threaded into the KSampler leaf
    expect(input.workflow['9'].inputs).toMatchObject({ seed: 1 });
  });

  it('throws (fail-closed) on an out-of-bounds param the coarse wire schema let through', () => {
    // `params: Record<string,unknown>` would accept these; the recipe schema rejects them.
    expect(() => buildCustomComfyWorkflowInput(recipe, { prompt: 'x'.repeat(2000) })).toThrow();
    expect(() => buildCustomComfyWorkflowInput(recipe, { prompt: 'x', engine: 'sdxl' })).toThrow();
    expect(() => buildCustomComfyWorkflowInput(recipe, { prompt: 'x', checkpoint: {} })).toThrow();
  });
});

describe('createBlockCustomComfyStep (step wrapper)', () => {
  const recipe = getRecipe('seamless-pano-360')!;

  it('wraps the input as a customComfy step and stamps the resolved per-engine timeout (HH:MM:SS)', () => {
    const input = buildCustomComfyWorkflowInput(recipe, { prompt: 'a lake', seed: 1 });
    // v1.1: the caller resolves the timeout from the params' budget and threads it.
    const { stepTimeoutSeconds } = recipe.budgetFor({ prompt: 'a lake', engine: 'qwen-image' });
    const step = createBlockCustomComfyStep(input, stepTimeoutSeconds);
    expect(step.$type).toBe('customComfy');
    expect(step.name).toBe(BLOCK_CUSTOM_COMFY_STEP_NAME);
    // qwen 180s ceiling → 00:03:00 (NOT the reference's loose 01:00:00).
    expect(step.timeout).toBe('00:03:00');
    expect(step.input).toBe(input);
  });

  it('formats the timeout per engine: zimage 90s → 00:01:30, flux2 150s → 00:02:30', () => {
    const input = buildCustomComfyWorkflowInput(recipe, { prompt: 'a lake', seed: 1 });
    expect(
      createBlockCustomComfyStep(input, recipe.budgetFor({ prompt: 'a lake', engine: 'zimage-turbo' }).stepTimeoutSeconds)
        .timeout
    ).toBe('00:01:30');
    expect(
      createBlockCustomComfyStep(input, recipe.budgetFor({ prompt: 'a lake', engine: 'flux2-klein' }).stepTimeoutSeconds)
        .timeout
    ).toBe('00:02:30');
  });
});

describe('snapshotFromWorkflow: customComfy blobs', () => {
  it('surfaces available blob urls from a customComfy step (output.blobs, not .images)', () => {
    const wf = fakeWorkflow({
      status: 'succeeded',
      steps: [
        {
          $type: 'customComfy',
          name: 'block-custom-comfy',
          status: 'succeeded',
          metadata: {},
          output: {
            blobs: [
              { id: 'p1', type: 'image', url: 'https://cdn/pano.png', available: true },
              { id: 'p2', type: 'image', url: 'https://pending/', available: false },
            ],
          },
        },
      ],
    });
    const snap = snapshotFromWorkflow(wf as never);
    expect(snap.imageUrls).toEqual(['https://cdn/pano.png']);
  });
});

describe('projectAppWorkflow: customComfy blobs', () => {
  it('projects blobs to images (null width/height, nsfwLevel mapped from rating)', () => {
    const wf = fakeWorkflow({
      id: 'wf_cc',
      createdAt: '2026-07-17T00:00:00.000Z',
      status: 'succeeded',
      cost: { total: 47 },
      steps: [
        {
          $type: 'customComfy',
          name: 'block-custom-comfy',
          status: 'succeeded',
          metadata: {},
          output: {
            blobs: [
              { id: 'p1', type: 'image', url: 'https://cdn/pano.png', available: true, nsfwLevel: 'pg' },
              { id: 'p2', type: 'image', url: 'https://blocked/', available: false },
            ],
          },
        },
      ],
    });
    expect(projectAppWorkflow(wf as never)).toEqual({
      workflowId: 'wf_cc',
      status: 'succeeded',
      images: [{ url: 'https://cdn/pano.png', width: null, height: null, nsfwLevel: 1 }],
      cost: 47,
      createdAt: '2026-07-17T00:00:00.000Z',
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 🔴 FIX 1 — REGISTERED STEP OUTPUT must be reachable on BOTH read surfaces.
//
// Both extractors used to `continue` on any `$type` outside
// `customComfy | textToImage | imageGen | comfy`, and `convertImage`'s output is
// `{ blob }` — SINGULAR, not `images` and not `blobs`. So they were blind to a
// registered step in TWO independent ways: the `$type` AND the key. The lived
// consequence: an app submits, is charged Buzz, polls to `succeeded`, and
// `snapshot.imageUrls` is absent on every poll while `queryAppWorkflows` returns
// `images: []`. It paid for a result it can never retrieve.
//
// These tests run over the REAL REGISTRY population, so a step registered
// tomorrow whose output is unreachable fails here — the property a fourth
// hardcoded `if ($type === 'convertImage')` branch could never have.
// ─────────────────────────────────────────────────────────────────────────────
describe('🔴 registered step output — surfaced on the snapshot AND the projection', () => {
  /**
   * Build a fake completed workflow carrying the registry entry's OWN canonical
   * completed-step object, which is itself copied from a real captured
   * orchestrator response. Nothing here re-describes the output shape — a test
   * that invented its own would only prove the test agrees with the test.
   */
  function workflowWithRegisteredStep(step: AnyBlockStep, variant: string) {
    return fakeWorkflow({
      id: 'wf_step',
      createdAt: '2026-08-02T00:00:00.000Z',
      status: 'succeeded',
      cost: { total: 1 },
      steps: [step.canonicalOutputFor(variant)],
    });
  }

  it('EVERY registered step surfaces its output on snapshotFromWorkflow.imageUrls', () => {
    for (const [id, step] of listRegisteredSteps()) {
      for (const variant of step.variants) {
        const expected = step.extractOutput(step.canonicalOutputFor(variant)).map((m) => m.url);
        expect(expected.length, `step '${id}' produced no expected urls`).toBeGreaterThan(0);
        const snap = snapshotFromWorkflow(workflowWithRegisteredStep(step, variant) as never);
        expect(
          snap.imageUrls,
          `step '${id}' variant '${variant}': the caller is CHARGED for this step and its ` +
            'result is absent from every poll'
        ).toEqual(expected);
      }
    }
  });

  it('EVERY registered step surfaces its output on projectAppWorkflow.images', () => {
    for (const [id, step] of listRegisteredSteps()) {
      for (const variant of step.variants) {
        const expected = step.extractOutput(step.canonicalOutputFor(variant));
        const projected = projectAppWorkflow(workflowWithRegisteredStep(step, variant) as never);
        expect(
          projected.images.map((i) => i.url),
          `step '${id}' variant '${variant}': queryAppWorkflows returns images: [] for a ` +
            'generation the app paid for'
        ).toEqual(expected.map((m) => m.url));
        expect(projected.images.map((i) => [i.width, i.height])).toEqual(
          expected.map((m) => [m.width, m.height])
        );
      }
    }
  });

  // The concrete shape, pinned literally rather than derived from the extractor
  // — so this fails if `convertImage`'s output key or availability rule changes.
  it('convert-image: the SINGULAR output.blob reaches both surfaces', () => {
    const wf = fakeWorkflow({
      id: 'wf_conv',
      createdAt: '2026-08-02T00:00:00.000Z',
      status: 'succeeded',
      cost: { total: 1 },
      steps: [
        {
          $type: 'convertImage',
          name: 'block-step',
          status: 'succeeded',
          metadata: {},
          output: {
            blob: {
              id: 'b1',
              url: 'https://orchestration/blobs/out.webp',
              available: true,
              width: 797,
              height: 1024,
              nsfwLevel: 'pg13',
            },
          },
        },
      ],
    });
    expect(snapshotFromWorkflow(wf as never).imageUrls).toEqual([
      'https://orchestration/blobs/out.webp',
    ]);
    expect(projectAppWorkflow(wf as never).images).toEqual([
      {
        url: 'https://orchestration/blobs/out.webp',
        width: 797,
        height: 1024,
        // Mapped through the SAME canonical helper the native branches use — the
        // registry hands over the raw rating string, never a bitflag.
        nsfwLevel: nsfwLevelFromContentRating('pg13'),
      },
    ]);
  });

  it('convert-image: a NOT-YET-AVAILABLE blob is dropped, not surfaced as a dead link', () => {
    // The real orchestrator returns `available: false` at submit time and flips
    // it to true when the blob lands (observed live 2026-08-02).
    const wf = fakeWorkflow({
      id: 'wf_conv_pending',
      createdAt: '2026-08-02T00:00:00.000Z',
      status: 'processing',
      steps: [
        {
          $type: 'convertImage',
          name: 'block-step',
          status: 'processing',
          metadata: {},
          output: {
            blob: { id: 'b1', url: 'https://orchestration/blobs/out.webp', available: false },
          },
        },
      ],
    });
    expect(snapshotFromWorkflow(wf as never).imageUrls).toBeUndefined();
    expect(projectAppWorkflow(wf as never).images).toEqual([]);
  });

  // 🔴 NO-REGRESSION. The registry branch is evaluated BEFORE the native `$type`
  // filter, so this pins that it cannot shadow the pre-existing kinds. The
  // structural guarantee is the load-time invariant forbidding a registered
  // entry from claiming a natively-extracted `$type`; this is the behavioural
  // half of the same claim.
  it('does NOT change extraction for the natively-handled $types', () => {
    for (const nativeType of NATIVELY_EXTRACTED_STEP_TYPES) {
      expect(getStepByOrchestratorType(nativeType)).toBeUndefined();
    }
    const wf = fakeWorkflow({
      id: 'wf_native',
      createdAt: '2026-08-02T00:00:00.000Z',
      status: 'succeeded',
      cost: { total: 5 },
      steps: [
        {
          $type: 'textToImage',
          name: 'txt2img',
          status: 'succeeded',
          metadata: {},
          output: {
            images: [
              {
                id: 'i1',
                url: 'https://cdn/a.png',
                available: true,
                width: 8,
                height: 9,
                nsfwLevel: 'pg',
              },
              { id: 'i2', url: 'https://cdn/b.png', available: false },
            ],
          },
        },
      ],
    });
    expect(snapshotFromWorkflow(wf as never).imageUrls).toEqual(['https://cdn/a.png']);
    expect(projectAppWorkflow(wf as never).images).toEqual([
      {
        url: 'https://cdn/a.png',
        width: 8,
        height: 9,
        nsfwLevel: nsfwLevelFromContentRating('pg'),
      },
    ]);
  });

  // An UNREGISTERED, non-native `$type` must still be skipped — the branch is
  // additive for registered steps only, not a wildcard that starts reading
  // arbitrary step outputs.
  it('still skips an unregistered, non-native $type', () => {
    const wf = fakeWorkflow({
      id: 'wf_other',
      createdAt: '2026-08-02T00:00:00.000Z',
      status: 'succeeded',
      steps: [
        {
          $type: 'imageBackgroundRemoval',
          name: 'x',
          status: 'succeeded',
          metadata: {},
          output: { blob: { id: 'b', url: 'https://cdn/nope.png', available: true } },
        },
      ],
    });
    expect(snapshotFromWorkflow(wf as never).imageUrls).toBeUndefined();
    expect(projectAppWorkflow(wf as never).images).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Multi-image conditioning: sourceImages[] + PER-ECOSYSTEM cap
// ─────────────────────────────────────────────────────────────────────────────
//
// The graph layer has always accepted N reference images (`imagesNode({min,max})`);
// the block bridge could only express one. The cap is NOT a constant — it is
// declared per ecosystem in the graph files and the real spread is 1 / 3 / 4 /
// 5 / 7. These tests read the same real config the guard does, and pin the
// ecosystem-specific behaviour rather than a flat number.
describe('sourceImages[] — normalization + per-ecosystem cap', () => {
  const IMG = (n = 0) => ({
    url: `https://image.civitai.com/abc/${n}.jpeg`,
    width: 1024,
    height: 1024,
  });
  const body = (over: Record<string, unknown> = {}) => ({
    kind: 'textToImage' as const,
    modelId: 7,
    modelVersionId: 99,
    params: { prompt: 'edit the cat', quantity: 1 },
    ...over,
  });
  const resolved = (checkpointBaseModel: string) => ({
    baseModel: checkpointBaseModel,
    modelType: 'Checkpoint',
    checkpointVersionId: 99,
    checkpointBaseModel,
  });
  const images = (n: number) => Array.from({ length: n }, (_, i) => IMG(i));
  function catchError(fn: () => unknown): unknown {
    try {
      fn();
    } catch (e) {
      return e;
    }
    return undefined;
  }

  // ── normalization ──────────────────────────────────────────────────────────
  it('normalizes the deprecated singular sourceImage to a 1-element array', () => {
    expect(normalizeBlockSourceImages(body({ sourceImage: IMG(1) }) as never)).toEqual([IMG(1)]);
  });

  it('passes an array through unchanged', () => {
    expect(normalizeBlockSourceImages(body({ sourceImages: images(3) }) as never)).toEqual(
      images(3)
    );
  });

  it('returns an empty array when the body carries neither (txt2img)', () => {
    expect(normalizeBlockSourceImages(body() as never)).toEqual([]);
  });

  // ── the emitted graph input ────────────────────────────────────────────────
  it('emits EVERY array element into the graph images[] (order preserved)', () => {
    const out = buildImageWorkflowInput(body({ sourceImages: images(3) }) as never, resolved('Qwen'));
    expect(out.workflow).toBe('img2img:edit');
    expect(out.images).toEqual([
      { url: 'https://image.civitai.com/abc/0.jpeg', width: 1024, height: 1024 },
      { url: 'https://image.civitai.com/abc/1.jpeg', width: 1024, height: 1024 },
      { url: 'https://image.civitai.com/abc/2.jpeg', width: 1024, height: 1024 },
    ]);
  });

  it('produces an IDENTICAL graph input for the singular alias and a 1-element array', () => {
    const singular = buildImageWorkflowInput(
      body({ sourceImage: IMG(0) }) as never,
      resolved('Qwen')
    );
    const array = buildImageWorkflowInput(
      body({ sourceImages: [IMG(0)] }) as never,
      resolved('Qwen')
    );
    expect(array).toEqual(singular);
  });

  it('routes an array on an SD-family checkpoint to plain img2img', () => {
    const out = buildImageWorkflowInput(
      body({ sourceImages: [IMG(0)] }) as never,
      resolved('SDXL 1.0')
    );
    expect(out.workflow).toBe('img2img');
    expect(out.images).toHaveLength(1);
  });

  // ── PER-ECOSYSTEM CAP ──────────────────────────────────────────────────────
  // Caps read from each ecosystem's own imagesNode config. A flat constant would
  // over-allow Boogu (1) and under-allow Flux.2 (7).
  it.each([
    ['Qwen', 'Qwen', 3],
    ['Flux.2 D', 'Flux2', 7],
    ['Boogu', 'Boogu', 1],
    ['OpenAI', 'OpenAI', 7],
    ['SDXL 1.0', 'SDXL', 1],
    ['HiDream-O1', 'HiDream-O1', 4],
  ])('accepts exactly the cap for %s (%s = %i)', (baseModel, _ecoKey, cap) => {
    const out = buildImageWorkflowInput(
      body({ sourceImages: images(cap) }) as never,
      resolved(baseModel)
    );
    expect(out.images).toHaveLength(cap);
  });

  it.each([
    ['Qwen', 4, 3],
    ['Flux.2 D', 8, 7],
    ['Boogu', 2, 1],
    ['SDXL 1.0', 2, 1],
  ])('REJECTS over-cap for %s (%i sent, cap %i)', (baseModel, count, cap) => {
    const caught = catchError(() =>
      buildImageWorkflowInput(body({ sourceImages: images(count) }) as never, resolved(baseModel))
    ) as TRPCError;
    expect(caught).toBeInstanceOf(TRPCError);
    expect(caught).toMatchObject({ code: 'BAD_REQUEST' });
    // The error names the limit AND the ecosystem, not a generic "too many".
    expect(caught.message).toContain(String(cap));
    expect(caught.message).toContain(String(count));
    expect(caught.message).toMatch(/ecosystem/);
  });

  // The cap really is per-ecosystem: the SAME count is accepted on one and
  // rejected on another. A flat constant cannot satisfy both of these.
  it('accepts 3 images on Qwen but rejects 3 on Boogu (cap is per-ecosystem)', () => {
    expect(
      buildImageWorkflowInput(body({ sourceImages: images(3) }) as never, resolved('Qwen')).images
    ).toHaveLength(3);
    expect(
      catchError(() =>
        buildImageWorkflowInput(body({ sourceImages: images(3) }) as never, resolved('Boogu'))
      )
    ).toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('accepts 7 images on Flux.2 but rejects 7 on Qwen', () => {
    expect(
      buildImageWorkflowInput(body({ sourceImages: images(7) }) as never, resolved('Flux.2 D'))
        .images
    ).toHaveLength(7);
    expect(
      catchError(() =>
        buildImageWorkflowInput(body({ sourceImages: images(7) }) as never, resolved('Qwen'))
      )
    ).toMatchObject({ code: 'BAD_REQUEST' });
  });

  // ── the over-cap behaviour we are preventing ───────────────────────────────
  it('documents that the graph SILENTLY TRUNCATES an over-cap images array', () => {
    // imagesNode's input transform does `arr.slice(0, effectiveMax)`. Without
    // the guard, an over-cap block body would be billed for a generation
    // conditioned on fewer images than it sent, with nothing saying so.
    const externalCtx: GenerationCtx = {
      limits: { maxQuantity: 4, maxResources: 10, vidQuantity: 1 },
      user: { isMember: false, tier: 'free' },
      flags: {},
      selfHostedDisabledEcosystems: [],
      selfHostedMode: 'enabled',
      gateRules: [],
    };
    const result = generationGraph.safeParse(
      {
        workflow: 'img2img:edit',
        ecosystem: 'Qwen',
        model: { id: 2558804 },
        resources: [],
        prompt: 'edit the cat',
        sampler: 'Euler',
        steps: 25,
        quantity: 1,
        priority: 'low',
        images: images(6),
      },
      externalCtx
    );
    expect(result.success).toBe(true);
    // 6 sent, 3 kept — silently.
    expect((result.data as { images: unknown[] }).images).toHaveLength(3);
  });

  // ── fail-closed when the cap cannot be determined ──────────────────────────
  //
  // Unreachable through buildImageWorkflowInput today — the ecosystem/variant
  // guard rejects a checkpoint whose ecosystem doesn't support the variant
  // before we get here, and the population test below proves every supported
  // pair HAS a readable cap. Exercised directly so the branch is not shipped
  // untested: if the two guards ever drift apart, this must reject rather than
  // hand the graph an images[] it has no node for.
  it('REJECTS fail-closed when the (ecosystem, workflow) pair has no images node', () => {
    // Flux1 is txt2img-only — no img2img node, so no derivable limit.
    const caught = catchError(() =>
      assertSourceImageCount({ ecosystem: 'Flux1', workflow: 'img2img', count: 1 })
    ) as TRPCError;
    expect(caught).toBeInstanceOf(TRPCError);
    expect(caught).toMatchObject({ code: 'BAD_REQUEST' });
    expect(caught.message).toMatch(/does not accept source images/);
  });

  it('REJECTS fail-closed for a pair the graph would re-route (unknown ecosystem)', () => {
    expect(
      catchError(() =>
        assertSourceImageCount({ ecosystem: 'NotAnEcosystem', workflow: 'img2img:edit', count: 1 })
      )
    ).toMatchObject({ code: 'BAD_REQUEST' });
  });

  // ── every edit-capable ecosystem has a READABLE cap ────────────────────────
  //
  // Audit the POPULATION, not a handful: enumerate every ecosystem the real
  // config marks as supporting an img2img variant and assert the bridge can
  // read a cap for it. If a new ecosystem ships whose limit is not derivable,
  // this fails instead of that ecosystem silently falling into the fail-closed
  // "does not accept source images" branch.
  it('derives a cap for EVERY ecosystem supporting an img2img variant', () => {
    const missing: string[] = [];
    let checked = 0;
    for (const workflow of ['img2img', 'img2img:edit'] as const) {
      for (const eco of ecosystems) {
        if (!isWorkflowAvailable(workflow, eco.id)) continue;
        checked += 1;
        const limit = getImagesLimit(eco.key, workflow);
        if (!limit || !(limit.max >= 1) || !(limit.min >= 0)) {
          missing.push(`${eco.key}/${workflow}`);
        }
      }
    }
    expect(missing).toEqual([]);
    // Guard the guard: if the enumeration ever silently matches nothing, an
    // empty `missing` would look like a pass.
    expect(checked).toBeGreaterThan(15);
  });
});
