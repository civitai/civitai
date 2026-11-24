import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FeatureFlagsService from '~/server/services/feature-flags.service';
import type * as OrchestrationNew from '~/server/services/orchestrator/orchestration-new.service';
import type * as ImageService from '~/server/services/image.service';
import type * as SignalClient from '~/utils/signal-client';
import type * as S3Utils from '~/utils/s3-utils';
import type * as StorageResolver from '~/server/services/storage-resolver';
import type * as Workflows from '~/server/services/orchestrator/workflows';

/**
 * The orchestrator can report a workflow succeeded before rating its outputs. Ready and saved
 * candidates are never re-checked, so these routes must wait for the rating.
 */

const mocks = vi.hoisted(() => ({
  getWorkflow: vi.fn(),
  updateWorkflow: vi.fn(async (..._a: unknown[]) => undefined),
  formatGenerationResponse2: vi.fn(),
  createImage: vi.fn(async (..._a: unknown[]) => ({ id: 900 })),
  createImageResources: vi.fn(async (..._a: unknown[]) => undefined),
  s3Send: vi.fn(async (..._a: unknown[]) => undefined),
}));

vi.mock('~/server/services/feature-flags.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsService>()),
  getFeatureFlags: () => ({ comicCreator: true }),
}));
vi.mock('~/server/orchestrator/get-orchestrator-token', () => ({
  getOrchestratorToken: async () => 'token',
}));
vi.mock('~/server/services/orchestrator/workflows', () => ({
  getWorkflow: mocks.getWorkflow,
  updateWorkflow: mocks.updateWorkflow,
}));
vi.mock('~/server/services/orchestrator/orchestration-new.service', async (importOriginal) => ({
  ...(await importOriginal<typeof OrchestrationNew>()),
  formatGenerationResponse2: mocks.formatGenerationResponse2,
}));
vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageService>()),
  createImage: mocks.createImage,
  createImageResources: mocks.createImageResources,
}));
vi.mock('~/utils/s3-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof S3Utils>()),
  getImageUploadBackend: async () => ({
    s3: { send: mocks.s3Send },
    bucket: 'bucket',
    backend: 'test',
  }),
}));
vi.mock('~/server/services/storage-resolver', async (importOriginal) => ({
  ...(await importOriginal<typeof StorageResolver>()),
  registerMediaLocation: vi.fn(),
}));
vi.mock('~/utils/signal-client', async (importOriginal) => ({
  ...(await importOriginal<typeof SignalClient>()),
  signalClient: { send: vi.fn(async () => undefined) },
}));

import { TRPCError } from '@trpc/server';
import { comicsRouter } from '../comics.router';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { OnboardingSteps } from '~/server/common/enums';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { NSFW_CAPPED, NSFW_CAPPED_MESSAGE } from '~/shared/orchestrator/workflow-data';

const USER_ID = 7;
const PANEL_ID = 21;

function fakeCtx() {
  return {
    user: {
      id: USER_ID,
      isModerator: false,
      onboarding: OnboardingSteps.Buzz,
      muted: false,
      showNsfw: true,
    },
    domain: 'red',
    acceptableOrigin: true,
    needsUpdate: false,
    tokenScope: TokenScope.Full,
    features: { comicCreator: true } as never,
    req: undefined,
    res: { setHeader: () => undefined } as never,
    cache: { edgeTTL: 0 },
    track: track as never,
    ip: '127.0.0.1',
    fingerprint: 'test' as never,
  };
}

const caller = () => comicsRouter.createCaller(fakeCtx() as never);

// The request's tracker: a stored output key is logged through it, so the row keeps the caller's IP.
const track = { imageUploadRequest: vi.fn(async (_key: string, _userId?: number) => true) };

const output = (id: string, over: Record<string, unknown> = {}) => ({
  type: 'image',
  id,
  url: `https://orchestrator.test/${id}.jpeg`,
  available: true,
  ...over,
});

function givenWorkflow(
  outputs: Array<Record<string, unknown>>,
  normalized: Record<string, unknown> = {},
  { unlocked = false } = {}
) {
  // The raw read the unlock guard checks: locked (or not), with an output rated mature.
  mocks.getWorkflow.mockResolvedValue({
    id: 'wf-1',
    status: 'succeeded',
    allowMatureContent: unlocked,
    steps: [{ $type: 'comfy', name: '$0', output: { blobs: [output('b0', { nsfwLevel: 'x' })] } }],
  });
  mocks.formatGenerationResponse2.mockResolvedValue([
    {
      id: 'wf-1',
      status: 'succeeded',
      allowMatureContent: false,
      metadata: {},
      ...normalized,
      steps: [
        {
          $type: 'comfy',
          name: '$0',
          status: 'succeeded',
          metadata: {},
          output: outputs,
        },
      ],
    },
  ]);
}

function givenPanel(over: Record<string, unknown> = {}) {
  const panel = {
    id: PANEL_ID,
    projectId: 11,
    workflowId: 'wf-1',
    status: 'Generating',
    imageUrl: null,
    errorMessage: null,
    prompt: 'a panel',
    metadata: { quantity: 1 },
    chapter: { project: { userId: USER_ID } },
    ...over,
  };
  dbMock.dbWrite.comicPanel.findUnique.mockResolvedValue(panel);
  dbMock.dbRead.comicPanel.findUnique.mockResolvedValue(panel);
}

/** The panel writes in order, the poll's raw one read back as the `data` of an update. */
const writes = () => {
  const { update } = dbMock.dbWrite.comicPanel;
  const raw = dbMock.dbWrite.$executeRaw.mock;
  return [
    ...update.mock.calls.map((call: Array<{ data: Record<string, unknown> }>, i: number) => ({
      order: update.mock.invocationCallOrder[i],
      data: call[0].data,
    })),
    ...raw.calls.flatMap((call: unknown[], i: number) => {
      const strings = call[0] as string[];
      if (!strings.join('').includes('SET status')) return [];
      // Each value follows the template text that ends with its column.
      const valueAfter = (text: string) => {
        const at = strings.findIndex((s) => s.trimEnd().endsWith(text));
        if (at < 0) throw new Error(`The poll's write no longer has "${text}"`);
        return call[at + 1];
      };
      const data: Record<string, unknown> = {
        status: valueAfter('SET status ='),
        metadata: JSON.parse(valueAfter('metadata =') as string),
      };
      if (valueAfter('CASE WHEN')) data.errorMessage = valueAfter('THEN');
      return [{ order: raw.invocationCallOrder[i], data }];
    }),
  ]
    .sort((a, b) => a.order - b.order)
    .map((w) => w.data);
};

beforeEach(() => {
  // Only the generation procedures' account-restriction read gets a row.
  dbMock.dbWrite.user.findUnique.mockImplementation((async (args: {
    select?: Record<string, boolean>;
  }) =>
    Object.keys(args.select ?? {})
      .sort()
      .join() === 'bannedAt,muted'
      ? { muted: false, bannedAt: null }
      : undefined) as never);
  vi.clearAllMocks();
  dbMock.dbWrite.$queryRaw.mockResolvedValue([{ id: PANEL_ID }] as never);
  dbMock.dbWrite.comicPanel.findFirst.mockImplementation((async (args: any) =>
    args?.where?.workflowId === 'wf-1' ? { id: PANEL_ID } : null) as never);
  // The poll catches and logs any throw, then returns the panel unchanged: the same result as the
  // hold. Every case asserts nothing was logged, so a broken fixture cannot pass as a held output.
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }))
  );
  dbMock.dbWrite.comicPanel.update.mockImplementation(
    async ({ data }: { data: Record<string, unknown> }) => ({
      id: PANEL_ID,
      projectId: 11,
      imageUrl: null,
      errorMessage: null,
      ...data,
    })
  );
});

describe('comics.pollPanelStatus - an output that has not been rated yet', () => {
  it('leaves a single-image panel as it was', async () => {
    givenPanel();
    givenWorkflow([output('b1')]);

    const result = await caller().pollPanelStatus({ panelId: PANEL_ID });

    expect(result.status).toBe('Generating');
    expect(writes()).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.createImage).not.toHaveBeenCalled();
    expect(mocks.formatGenerationResponse2).toHaveBeenCalledTimes(1);
    expect(console.error).not.toHaveBeenCalled();
  });

  it('completes the same panel once the output is rated', async () => {
    givenPanel();
    givenWorkflow([output('b1', { nsfwLevel: 'pg' })]);

    const result = await caller().pollPanelStatus({ panelId: PANEL_ID });

    expect(result.status).toBe('Ready');
    expect(mocks.createImage).toHaveBeenCalledTimes(1);
  });

  it('saves no candidate of a multi-image panel while one output is unrated', async () => {
    givenPanel({ metadata: { quantity: 2 } });
    givenWorkflow([output('b1', { nsfwLevel: 'pg' }), output('b2')]);

    const result = await caller().pollPanelStatus({ panelId: PANEL_ID });

    expect(result.status).toBe('Generating');
    expect(writes()).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.formatGenerationResponse2).toHaveBeenCalledTimes(1);
    expect(console.error).not.toHaveBeenCalled();
  });

  it('saves the candidates once every output is rated', async () => {
    givenPanel({ metadata: { quantity: 2 } });
    givenWorkflow([output('b1', { nsfwLevel: 'pg' }), output('b2', { nsfwLevel: 'pg' })]);

    const result = await caller().pollPanelStatus({ panelId: PANEL_ID });

    expect(result.status).toBe('AwaitingSelection');
    const [data] = writes();
    expect((data.metadata as { candidateImages: unknown[] }).candidateImages).toHaveLength(2);
  });
});

describe('comics.pollPanelStatus - an output above the workflow cap', () => {
  it('marks a single-image panel capped, so the card offers no unlock', async () => {
    givenPanel();
    givenWorkflow([output('b1', { nsfwLevel: 'r' })], { nsfwCap: 'pg13' });

    const result = await caller().pollPanelStatus({ panelId: PANEL_ID });

    expect(result).toMatchObject({
      status: 'RequireUnlock',
      blockedReason: NSFW_CAPPED,
      errorMessage: NSFW_CAPPED_MESSAGE,
    });
    const [data] = writes();
    expect(data.metadata).toMatchObject({ blockedReason: NSFW_CAPPED });
    expect(console.error).not.toHaveBeenCalled();
  });
});

describe('comics.unlockPanelGeneration - an output that has not been rated yet', () => {
  it('sends a single-image panel back to the poll instead of keeping the output', async () => {
    givenPanel({ status: 'RequireUnlock', metadata: { quantity: 1, blockedReason: 'canUpgrade' } });
    givenWorkflow([output('b1')]);

    const result = await caller().unlockPanelGeneration({ panelId: PANEL_ID });

    expect(result.status).toBe('Generating');
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.createImage).not.toHaveBeenCalled();
    expect(mocks.updateWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ workflowId: 'wf-1', allowMatureContent: true, throwOnError: true })
    );
    const [data] = writes();
    expect(data.status).toBe('Generating');
    expect(data.metadata).not.toHaveProperty('blockedReason');
  });

  it('completes a single-image panel when the unlocked output is rated', async () => {
    givenPanel({ status: 'RequireUnlock', metadata: { quantity: 1, blockedReason: 'canUpgrade' } });
    givenWorkflow([output('b1', { nsfwLevel: 'pg' })]);

    const result = await caller().unlockPanelGeneration({ panelId: PANEL_ID });

    expect(result.status).toBe('Ready');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(mocks.createImage).toHaveBeenCalledTimes(1);
  });

  it('refuses, charging nothing, when the workflow cap blocks every mature output', async () => {
    givenPanel({ status: 'RequireUnlock', metadata: { quantity: 1, blockedReason: 'canUpgrade' } });
    mocks.getWorkflow.mockResolvedValue({
      id: 'wf-1',
      status: 'succeeded',
      allowMatureContent: false,
      nsfwLevel: 'pg13',
      steps: [
        { $type: 'comfy', name: '$0', output: { blobs: [output('b1', { nsfwLevel: 'r' })] } },
      ],
    });

    await expect(caller().unlockPanelGeneration({ panelId: PANEL_ID })).rejects.toThrow(/PG-13/);
    expect(mocks.updateWorkflow).not.toHaveBeenCalled();
    expect(writes()).toEqual([]);
  });

  it('keeps an unrated candidate locked instead of saving it as clean', async () => {
    givenPanel({
      status: 'AwaitingSelection',
      metadata: {
        quantity: 2,
        candidateImages: [
          { requiresUnlock: true, blockedReason: 'canUpgrade' },
          { requiresUnlock: true, blockedReason: 'canUpgrade' },
        ],
      },
    });
    givenWorkflow([output('b1', { nsfwLevel: 'pg' }), output('b2')]);

    await caller().unlockPanelGeneration({ panelId: PANEL_ID });

    const [data] = writes();
    const candidates = (data.metadata as { candidateImages: Array<Record<string, unknown>> })
      .candidateImages;
    expect(candidates[0]).toHaveProperty('key');
    expect(candidates[1]).toMatchObject({ requiresUnlock: true });
    expect(candidates[1]).not.toHaveProperty('key');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(mocks.s3Send).toHaveBeenCalledTimes(1);
  });
});

describe('comics - a stored output key is recorded as issued to the user', () => {
  const storedKeys = () =>
    mocks.s3Send.mock.calls.map((c) => (c[0] as { input: { Key: string } }).input.Key);
  const recordedOwners = () =>
    vi
      .mocked(redisMock.redis.set)
      .mock.calls.filter((c) => String(c[0]).startsWith('system:upload-key-owner:'));
  beforeEach(() => track.imageUploadRequest.mockClear());

  const expectEachStoredKeyRecorded = async (count: number) => {
    expect(storedKeys()).toHaveLength(count);
    expect(recordedOwners()).toEqual(
      storedKeys().map((key) => [
        `system:upload-key-owner:${key}`,
        String(USER_ID),
        { EX: 30 * 24 * 60 * 60 },
      ])
    );
    await vi.waitFor(() =>
      expect(track.imageUploadRequest.mock.calls).toEqual(storedKeys().map((key) => [key, USER_ID]))
    );
  };

  it('by the poll of a single-image panel', async () => {
    givenPanel();
    givenWorkflow([output('b1', { nsfwLevel: 'pg' })]);

    await caller().pollPanelStatus({ panelId: PANEL_ID });

    await expectEachStoredKeyRecorded(1);
  });

  it('by the poll of a multi-image panel', async () => {
    givenPanel({ metadata: { quantity: 2 } });
    givenWorkflow([output('b1', { nsfwLevel: 'pg' }), output('b2', { nsfwLevel: 'pg' })]);

    await caller().pollPanelStatus({ panelId: PANEL_ID });

    await expectEachStoredKeyRecorded(2);
  });

  it('by the unlock of a single-image panel', async () => {
    givenPanel({ status: 'RequireUnlock', metadata: { quantity: 1, blockedReason: 'canUpgrade' } });
    givenWorkflow([output('b1', { nsfwLevel: 'pg' })]);

    await caller().unlockPanelGeneration({ panelId: PANEL_ID });

    await expectEachStoredKeyRecorded(1);
  });

  it('by the unlock of a multi-image panel', async () => {
    givenPanel({
      status: 'AwaitingSelection',
      metadata: {
        quantity: 2,
        candidateImages: [
          { requiresUnlock: true, blockedReason: 'canUpgrade' },
          { requiresUnlock: true, blockedReason: 'canUpgrade' },
        ],
      },
    });
    givenWorkflow([output('b1', { nsfwLevel: 'pg' }), output('b2', { nsfwLevel: 'pg' })]);

    await caller().unlockPanelGeneration({ panelId: PANEL_ID });

    await expectEachStoredKeyRecorded(2);
  });
});

/** Unlocking a multi-image panel the owner already picked from; the per-panel claim on PGlite. */
const pg = new PGlite();
beforeAll(async () => {
  await pg.exec(`
    CREATE DOMAIN "ComicPanelStatus" AS text;
    CREATE TABLE "ComicPanel" (
      id int PRIMARY KEY, metadata jsonb, status text, "errorMessage" text, "updatedAt" timestamptz,
      "projectId" int, "chapterPosition" int
    )`);
});
const storedClaim = async () =>
  (
    await pg.query<{ c: { token: string } | null }>(
      `SELECT metadata->'unlockClaim' AS c FROM "ComicPanel" WHERE id = $1`,
      [PANEL_ID]
    )
  ).rows[0]?.c ?? undefined;
const seedClaim = (token: string, age: string) =>
  pg.query(
    `UPDATE "ComicPanel" SET metadata = jsonb_build_object('unlockClaim',
      jsonb_build_object('token', $1::text, 'at', now() - $2::interval)) WHERE id = $3`,
    [token, age, PANEL_ID]
  );

/** The charge write's failure as the real client maps an orchestrator answer of `status`. */
const orchestratorFailure = async (status: number | undefined, detail: string) => {
  const { throwOrchestratorFailure } = await vi.importActual<typeof Workflows>(
    '~/server/services/orchestrator/workflows'
  );
  return throwOrchestratorFailure({
    error: { detail },
    response: status === undefined ? undefined : new Response(null, { status }),
    message: detail,
  });
};
/** A two-image panel the owner picked 'picked' from; slot 2 was mature and still locked. */
const selectedPanel = () =>
  givenPanel({
    status: 'Ready',
    imageUrl: 'picked',
    imageId: 5,
    metadata: {
      quantity: 2,
      candidateImages: [{ key: 'picked' }, { requiresUnlock: true, blockedReason: 'canUpgrade' }],
    },
  });
const bothRated = [output('b1', { nsfwLevel: 'pg' }), output('b2', { nsfwLevel: 'x' })];

describe('comics.unlockPanelGeneration - a multi-image panel with a selection', () => {
  beforeEach(async () => {
    await pg.exec(
      `DELETE FROM "ComicPanel"; INSERT INTO "ComicPanel" (id, metadata, "projectId", "chapterPosition") VALUES (${PANEL_ID}, '{}', 11, 0)`
    );
    const raw = pgliteRaw(pg);
    dbMock.dbWrite.$queryRaw.mockImplementation(raw.queryRaw as never);
    dbMock.dbWrite.$executeRaw.mockImplementation(raw.executeRaw as never);
    // The panel writes reach the stored row too, so what a write leaves of the claim is real.
    dbMock.dbWrite.comicPanel.update.mockImplementation((async ({ data }: { data: any }) => {
      if (data.metadata)
        await pg.query(`UPDATE "ComicPanel" SET metadata = $1 WHERE id = $2`, [
          JSON.stringify(data.metadata),
          PANEL_ID,
        ]);
      return { id: PANEL_ID, projectId: 11, imageUrl: null, errorMessage: null, ...data };
    }) as never);
  });

  it('drops the claim when the unlock succeeds', async () => {
    selectedPanel();
    givenWorkflow(bothRated, { allowMatureContent: true });

    await caller().unlockPanelGeneration({ panelId: PANEL_ID });

    expect(mocks.updateWorkflow).toHaveBeenCalledTimes(1);
    expect(await storedClaim()).toBeUndefined();
  });

  it('takes over a claim left more than 10 minutes ago, and refuses a fresh one', async () => {
    selectedPanel();
    givenWorkflow(bothRated, { allowMatureContent: true });
    await seedClaim('crashed', '11 minutes');
    await caller().unlockPanelGeneration({ panelId: PANEL_ID });
    expect(mocks.updateWorkflow).toHaveBeenCalledTimes(1);

    await seedClaim('live', '1 minute');
    await expect(caller().unlockPanelGeneration({ panelId: PANEL_ID })).rejects.toThrow(
      /already being unlocked/
    );
    expect(mocks.updateWorkflow).toHaveBeenCalledTimes(1);
  });

  it('a failing unlock frees only its own claim, not one taken over since', async () => {
    selectedPanel();
    givenWorkflow(bothRated, { allowMatureContent: true });
    mocks.updateWorkflow.mockImplementationOnce(async () => {
      // Its claim went stale and another request took the panel over.
      await seedClaim('other', '0 minutes');
      return orchestratorFailure(403, 'You need more yellow Buzz.');
    });

    await expect(caller().unlockPanelGeneration({ panelId: PANEL_ID })).rejects.toThrow(/Buzz/);

    expect(await storedClaim()).toMatchObject({ token: 'other' });
  });

  it('collects a single-image unlock already paid for, without charging again', async () => {
    givenPanel({ status: 'RequireUnlock', metadata: { quantity: 1, blockedReason: 'canUpgrade' } });
    givenWorkflow(
      [output('b1', { nsfwLevel: 'x' })],
      { allowMatureContent: true },
      { unlocked: true }
    );

    const result = await caller().unlockPanelGeneration({ panelId: PANEL_ID });

    expect(mocks.updateWorkflow).not.toHaveBeenCalled();
    expect(result.status).toBe('Ready');
    expect(mocks.createImage).toHaveBeenCalledTimes(1);
  });

  /** A multi-image panel still choosing; `metadata` is the copy the poll read. */
  const choosingPanel = (metadata: Record<string, unknown> = {}) =>
    givenPanel({
      status: 'AwaitingSelection',
      metadata: {
        quantity: 2,
        candidateImages: [{ key: 'a' }, { requiresUnlock: true, blockedReason: 'canUpgrade' }],
        ...metadata,
      },
    });

  it("the poll's candidate write keeps a claim an unlock took meanwhile", async () => {
    choosingPanel();
    givenWorkflow(bothRated, { allowMatureContent: true });
    await seedClaim('live', '0 minutes');

    await caller().pollPanelStatus({ panelId: PANEL_ID });

    expect(writes()).toHaveLength(1);
    expect(await storedClaim()).toMatchObject({ token: 'live' });
  });

  it("the poll's blocked-output write keeps a claim an unlock took meanwhile", async () => {
    givenPanel();
    givenWorkflow([output('b1', { nsfwLevel: 'r' })], { nsfwCap: 'pg13' });
    await seedClaim('live', '0 minutes');

    await caller().pollPanelStatus({ panelId: PANEL_ID });

    expect(writes()).toEqual([expect.objectContaining({ status: 'RequireUnlock' })]);
    expect(await storedClaim()).toMatchObject({ token: 'live' });
  });

  it('the poll does not write back a claim released since it read the panel', async () => {
    choosingPanel({ unlockClaim: { token: 'released', at: new Date().toISOString() } });
    givenWorkflow(bothRated, { allowMatureContent: true });

    await caller().pollPanelStatus({ panelId: PANEL_ID });

    expect(writes()).toHaveLength(1);
    expect(await storedClaim()).toBeUndefined();
  });

  it('keeps the selection and unlocks the paid slot', async () => {
    selectedPanel();
    givenWorkflow(bothRated, { allowMatureContent: true });

    const result = await caller().unlockPanelGeneration({ panelId: PANEL_ID });

    expect(mocks.updateWorkflow).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('Ready');
    const [data] = writes();
    expect(data).not.toHaveProperty('imageUrl');
    expect(data).not.toHaveProperty('imageId');
    expect(data.status).toBe('Ready');
    const slots = (data.metadata as { candidateImages: Array<Record<string, unknown>> })
      .candidateImages;
    expect(slots[0]).toMatchObject({ key: 'picked' });
    expect(slots[1]).toEqual({ key: expect.any(String), nsfwLevel: expect.any(Number) });
    expect(mocks.createImage).not.toHaveBeenCalled();
  });

  it('collects the slots of an unlock already paid for, without charging again', async () => {
    selectedPanel();
    givenWorkflow(bothRated, { allowMatureContent: true }, { unlocked: true });

    await caller().unlockPanelGeneration({ panelId: PANEL_ID });

    expect(mocks.updateWorkflow).not.toHaveBeenCalled();
    const [data] = writes();
    const slots = (data.metadata as { candidateImages: Array<Record<string, unknown>> })
      .candidateImages;
    expect(slots[1]).toHaveProperty('key');
  });

  it('charges once when two unlocks of one panel overlap', async () => {
    selectedPanel();
    givenWorkflow(bothRated, { allowMatureContent: true });
    const lockedRead = await mocks.getWorkflow();
    let charged = false;
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    mocks.updateWorkflow.mockImplementationOnce(async () => {
      await held;
      charged = true;
    });
    // The workflow reads unlocked once the first charge lands. The second request's second read is
    // slow: it returns the locked state it saw before the first unlock finished and dropped its claim.
    // Checked before claiming, that stale read would let the second request claim and charge too.
    let secondReads: number | undefined;
    mocks.getWorkflow.mockImplementation(async () => {
      if (secondReads !== undefined && !charged && ++secondReads === 2) {
        release();
        await first.catch(() => undefined);
        return lockedRead;
      }
      return { ...lockedRead, allowMatureContent: charged };
    });

    const first = caller().unlockPanelGeneration({ panelId: PANEL_ID });
    await vi.waitFor(() => expect(mocks.updateWorkflow).toHaveBeenCalledTimes(1));
    secondReads = 0;
    const second = caller().unlockPanelGeneration({ panelId: PANEL_ID });
    await expect(second).rejects.toThrow(/already being unlocked/);
    // Refused after its first read: a second read before the claim would get the stale answer.
    expect(secondReads).toBe(1);
    release();
    await first;

    expect(mocks.updateWorkflow).toHaveBeenCalledTimes(1);
  });

  it('a failure after the charge, such as the download, frees the claim', async () => {
    givenPanel({ status: 'RequireUnlock', metadata: { quantity: 1, blockedReason: 'canUpgrade' } });
    givenWorkflow([output('b1', { nsfwLevel: 'pg' })]);
    let heldDuringCharge: unknown;
    mocks.updateWorkflow.mockImplementationOnce(async () => {
      heldDuringCharge = await storedClaim();
    });
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 500 }));

    await expect(caller().unlockPanelGeneration({ panelId: PANEL_ID })).rejects.toThrow(
      /download failed/
    );

    expect(heldDuringCharge).toMatchObject({ token: expect.any(String) });
    expect(await storedClaim()).toBeUndefined();
  });

  it('a charge cut off by its time bound keeps the claim until it expires', async () => {
    selectedPanel();
    givenWorkflow(bothRated, { allowMatureContent: true });
    mocks.updateWorkflow.mockImplementationOnce(
      ({ signal }: any) =>
        new Promise((_, reject) =>
          signal.addEventListener('abort', () => reject(new Error('aborted')))
        )
    );
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const unlock = caller().unlockPanelGeneration({ panelId: PANEL_ID });
      const refused = expect(unlock).rejects.toThrow(/not confirmed yet/);
      while (!mocks.updateWorkflow.mock.calls.length) await new Promise((r) => setImmediate(r));
      // Well inside the claim's 10 minutes.
      await vi.advanceTimersByTimeAsync(3 * 60_000);
      await refused;
    } finally {
      vi.useRealTimers();
    }

    expect(await storedClaim()).toMatchObject({ token: expect.any(String) });
  });

  it('a charge write answered by a gateway error keeps the claim until it expires', async () => {
    selectedPanel();
    givenWorkflow(bothRated, { allowMatureContent: true });
    mocks.updateWorkflow.mockImplementationOnce(() => orchestratorFailure(504, 'Gateway Timeout'));

    await expect(caller().unlockPanelGeneration({ panelId: PANEL_ID })).rejects.toThrow(
      /not confirmed yet/
    );

    expect(await storedClaim()).toMatchObject({ token: expect.any(String) });
  });

  it.each([
    ['no response', () => orchestratorFailure(undefined, 'fetch failed')],
    [
      'an unmapped answer',
      async () => {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR' });
      },
    ],
    [
      'a failure the client did not map',
      async () => {
        throw new Error('socket hang up');
      },
    ],
  ])('a charge write with %s keeps the claim until it expires', async (_, failure) => {
    selectedPanel();
    givenWorkflow(bothRated, { allowMatureContent: true });
    mocks.updateWorkflow.mockImplementationOnce(failure);

    await expect(caller().unlockPanelGeneration({ panelId: PANEL_ID })).rejects.toThrow(
      /not confirmed yet/
    );

    expect(await storedClaim()).toMatchObject({ token: expect.any(String) });
  });

  describe('a delete while an unlock is still finishing', () => {
    const stored = async () =>
      (await pg.query(`SELECT 1 FROM "ComicPanel" WHERE id = $1`, [PANEL_ID])).rows.length > 0;
    const deletes = {
      panel: {
        run: () => caller().deletePanel({ panelId: PANEL_ID }),
        deleted: async () => !(await stored()),
      },
      chapter: {
        run: () => caller().deleteChapter({ projectId: 11, chapterPosition: 0 }),
        deleted: async () => dbMock.dbWrite.comicChapter.delete.mock.calls.length > 0,
      },
      project: {
        run: () => caller().deleteProject({ id: 11 }),
        deleted: async () => dbMock.dbWrite.comicProject.update.mock.calls.length > 0,
      },
    };
    beforeEach(() => {
      givenPanel();
      dbMock.dbRead.comicChapter.findUnique.mockResolvedValue({
        project: { userId: USER_ID },
      } as never);
      dbMock.dbRead.comicProject.findUnique.mockResolvedValue({ userId: USER_ID } as never);
    });

    it.each(Object.keys(deletes) as Array<keyof typeof deletes>)(
      'refuses the %s delete while a panel claim is live',
      async (scope) => {
        await seedClaim('live', '1 minute');

        await expect(deletes[scope].run()).rejects.toThrow(/still finishing/);

        expect(await deletes[scope].deleted()).toBe(false);
      }
    );

    it.each(Object.keys(deletes) as Array<keyof typeof deletes>)(
      'CONTROL: deletes the %s once the claim has expired',
      async (scope) => {
        await seedClaim('crashed', '11 minutes');

        await deletes[scope].run().catch(() => undefined);

        expect(await deletes[scope].deleted()).toBe(true);
      }
    );

    // A single connection cannot interleave two transactions, so no test here can watch the lock
    // work. This pins that the chapter's check holds its panels' row locks until the delete: drop
    // FOR UPDATE and an unlock can claim a panel between the check and the cascade.
    it('the chapter delete checks its panels under a row lock (FOR UPDATE)', async () => {
      await deletes.chapter.run().catch(() => undefined);

      const checks = dbMock.dbWrite.$queryRaw.mock.calls
        .map((call: unknown[]) =>
          Array.isArray(call[0]) ? call[0].join('?') : String((call[0] as { sql?: string }).sql)
        )
        .filter((sql: string) => sql.includes('AS live'));
      expect(checks).toHaveLength(1);
      expect(checks[0]).toMatch(/FOR UPDATE\s*$/);
    });
  });

  describe('a copied panel does not carry the unlock claim', () => {
    const source = {
      id: PANEL_ID,
      projectId: 11,
      chapterPosition: 0,
      position: 0,
      prompt: 'a panel',
      status: 'Ready',
      imageUrl: 'picked',
      metadata: { quantity: 1, unlockClaim: { token: 'live', at: new Date().toISOString() } },
      references: [],
      chapter: { project: { userId: USER_ID } },
    };
    const copiedMetadata = () =>
      dbMock.dbWrite.comicPanel.create.mock.calls.map(
        (c: Array<{ data: { metadata?: Record<string, unknown> } }>) => c[0].data.metadata
      );
    beforeEach(() => {
      dbMock.dbWrite.comicPanel.create.mockResolvedValue({ id: 99, status: 'Ready' } as never);
    });

    it('by duplicatePanel', async () => {
      dbMock.dbRead.comicPanel.findUnique.mockResolvedValue(source as never);

      await caller()
        .duplicatePanel({ panelId: PANEL_ID })
        .catch(() => undefined);

      expect(copiedMetadata()).toEqual([{ quantity: 1 }]);
    });

    it('by duplicateChapter', async () => {
      dbMock.dbRead.comicChapter.findUnique.mockResolvedValue({
        name: 'one',
        project: { userId: USER_ID },
        panels: [source],
      } as never);
      dbMock.dbWrite.comicChapter.findMany.mockResolvedValue([] as never);
      dbMock.dbWrite.comicChapter.create.mockResolvedValue({ position: 1 } as never);

      await caller()
        .duplicateChapter({ projectId: 11, chapterPosition: 0 })
        .catch(() => undefined);

      expect(copiedMetadata()).toEqual([{ quantity: 1 }]);
    });
  });

  it('CONTROL: a refused charge releases the claim, so the next unlock can pay', async () => {
    selectedPanel();
    givenWorkflow(bothRated, { allowMatureContent: true });
    mocks.updateWorkflow.mockImplementationOnce(() =>
      orchestratorFailure(403, 'You need more yellow Buzz.')
    );

    await expect(caller().unlockPanelGeneration({ panelId: PANEL_ID })).rejects.toThrow(/Buzz/);
    await caller().unlockPanelGeneration({ panelId: PANEL_ID });

    expect(mocks.updateWorkflow).toHaveBeenCalledTimes(2);
  });

  it('CONTROL: a panel still choosing goes to AwaitingSelection as before', async () => {
    givenPanel({
      status: 'AwaitingSelection',
      metadata: {
        quantity: 2,
        candidateImages: [{ key: 'a' }, { requiresUnlock: true, blockedReason: 'canUpgrade' }],
      },
    });
    givenWorkflow(bothRated, { allowMatureContent: true });

    const result = await caller().unlockPanelGeneration({ panelId: PANEL_ID });

    expect(result.status).toBe('AwaitingSelection');
  });

  it('CONTROL: a single-image panel still takes the single-image path', async () => {
    givenPanel({ status: 'RequireUnlock', metadata: { quantity: 1, blockedReason: 'canUpgrade' } });
    givenWorkflow([output('b1', { nsfwLevel: 'pg' })]);

    const result = await caller().unlockPanelGeneration({ panelId: PANEL_ID });

    expect(result.status).toBe('Ready');
    expect(mocks.createImage).toHaveBeenCalledTimes(1);
  });

  it('CONTROL: an already-unlocked generation with nothing locked is still refused', async () => {
    givenPanel({
      status: 'Ready',
      imageUrl: 'a',
      metadata: { quantity: 2, candidateImages: [{ key: 'a' }, { key: 'b' }] },
    });
    givenWorkflow(bothRated, { allowMatureContent: true }, { unlocked: true });

    await expect(caller().unlockPanelGeneration({ panelId: PANEL_ID })).rejects.toThrow(
      /already unlocked/
    );
    expect(mocks.updateWorkflow).not.toHaveBeenCalled();
  });
});
