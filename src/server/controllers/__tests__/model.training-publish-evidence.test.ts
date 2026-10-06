import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as Workflows from '~/server/services/orchestrator/workflows';

/**
 * A model published before the approval stamp existed has no stamp. Once its training workflow is
 * gone, the check lets it through on evidence of that earlier publish — evidence that unpublish,
 * "Set to Draft" and delete-then-restore clear. These run each of those paths for real against one
 * in-memory Model row, then publish through the real handler: the publish must still succeed.
 * Faked: the DB (one row), the orchestrator read (NOT_FOUND), and side-effect services.
 */

const { mockGetWorkflow } = vi.hoisted(() => ({ mockGetWorkflow: vi.fn() }));

vi.mock('~/server/orchestrator/get-orchestrator-token', () => ({
  getOrchestratorToken: vi.fn().mockResolvedValue('owner-token'),
}));
vi.mock('~/server/services/orchestrator/workflows', async (importOriginal) => ({
  ...(await importOriginal<typeof Workflows>()),
  getWorkflow: mockGetWorkflow,
  updateWorkflow: vi.fn(),
}));
vi.mock('~/server/events', () => ({ eventEngine: { processEngagement: vi.fn() } }));
vi.mock('~/server/services/subscriptions.service', () => ({
  getHighestTierSubscription: vi
    .fn()
    .mockResolvedValue({ tier: 'gold', productMeta: { maxPrivateModels: 5 } }),
}));

import { TRPCError } from '@trpc/server';
import {
  privateModelFromTrainingHandler,
  publishModelHandler,
  publishPrivateModelHandler,
} from '~/server/controllers/model.controller';
import {
  deleteModelById,
  publishPrivateModel,
  restoreModelById,
  unpublishModelById,
} from '~/server/services/model.service';
import { dbMock } from '~/__tests__/mocks/db.mock';

const MODEL_ID = 42;
const OWNER_ID = 7;
const MODERATOR_ID = 999;

type Row = {
  id: number;
  userId: number;
  status: string;
  availability: string;
  publishedAt: Date | null;
  nsfw: boolean;
  meta: Record<string, unknown> | null;
};
let row: Row;

let replica: Row;
/** The replica catches up between requests, never within one. */
function syncReplica() {
  replica = { ...row, meta: row.meta && { ...row.meta } };
}

/** Back Model reads/writes with `row`: primary reads see it live, replica reads see `replica`. */
function bindRow() {
  const copy = (r: Row) => ({ ...r, modelVersions: [], meta: r.meta && { ...r.meta } });
  const primary = async () => copy(row);
  const stale = async () => copy(replica);
  for (const [client, read] of [
    [dbMock.dbRead, stale],
    [dbMock.dbWrite, primary],
  ] as const) {
    client.model.findUnique.mockImplementation(read as never);
    client.model.findFirst.mockImplementation(read as never);
    client.model.findUniqueOrThrow.mockImplementation(read as never);
  }
  dbMock.dbWrite.model.update.mockImplementation((async ({ data }: { data: Partial<Row> }) => {
    for (const key of ['status', 'availability', 'publishedAt', 'meta'] as const)
      if (data[key] !== undefined) (row as Record<string, unknown>)[key] = data[key];
    return { ...row, modelVersions: [{ id: 43 }] };
  }) as never);
  // The server-owned flag write: `jsonb_set(..., ARRAY[key]::text[], 'true')`.
  dbMock.dbWrite.$executeRaw.mockImplementation((async (
    sql: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const text = Array.isArray(sql) ? sql.join('?') : '';
    if (text.includes('jsonb_set') && text.includes('ARRAY[')) {
      row.meta = { ...(row.meta ?? {}), [values[0] as string]: true };
    }
    return 1;
  }) as never);
}

const publish = () => {
  syncReplica();
  return publishModelHandler({
    input: { id: MODEL_ID, versionIds: [] },
    ctx: {
      user: { id: OWNER_ID, isModerator: false },
      track: { modelEvent: vi.fn().mockResolvedValue(undefined) },
    },
  } as never);
};

beforeEach(() => {
  vi.clearAllMocks();
  // Privately published before the stamp existed: status Published, no model publishedAt.
  row = {
    id: MODEL_ID,
    userId: OWNER_ID,
    status: 'Published',
    availability: 'Private',
    publishedAt: null,
    nsfw: false,
    meta: { trainingStudioWorkflowId: 'wf-1' },
  };
  syncReplica();
  bindRow();
  dbMock.dbRead.modelVersion.findMany.mockResolvedValue([{ id: 43 }] as never);
  mockGetWorkflow.mockRejectedValue(new TRPCError({ code: 'NOT_FOUND', message: 'gone' }));
});

describe('earlier-publish evidence survives the paths that clear it', () => {
  it('"Set to Draft" (publishPrivateModel without versions), then publish', async () => {
    syncReplica();
    await publishPrivateModelHandler({
      input: { modelId: MODEL_ID, publishVersions: false },
      ctx: { user: { id: OWNER_ID, isModerator: false } },
    } as never);
    expect(row).toMatchObject({ status: 'Unpublished', publishedAt: null });

    await expect(publish()).resolves.toBeDefined();
  });

  // publishPrivateModel rewrites meta from its own read, so it must carry the evidence itself. Called
  // directly here, so no gate has written anything first.
  it('"Set to Draft" records the evidence itself, then publish', async () => {
    await publishPrivateModel({ modelId: MODEL_ID, publishVersions: false });
    expect(row).toMatchObject({ status: 'Unpublished', publishedAt: null });
    expect(row.meta).toMatchObject({ trainingStudioPublishedBeforeStamp: true });

    await expect(publish()).resolves.toBeDefined();
  });

  it('unpublish, then publish', async () => {
    await unpublishModelById({
      id: MODEL_ID,
      meta: row.meta ?? undefined,
      userId: MODERATOR_ID,
      isModerator: true,
    });
    expect(row).toMatchObject({ status: 'Unpublished', publishedAt: null });

    await expect(publish()).resolves.toBeDefined();
  });

  it('delete then restore, then publish', async () => {
    await deleteModelById({ id: MODEL_ID, userId: MODERATOR_ID, isModerator: true });
    expect(row.status).toBe('Deleted');
    // Run the real restore. Its status write is raw SQL, which the in-memory row cannot execute, so
    // this applies it only when the statement still has the shape it has today; if the SQL changes,
    // the row stays Deleted and the publish below fails rather than passing on a stale copy.
    dbMock.dbWrite.$queryRaw.mockImplementation((async (sql: TemplateStringsArray) => {
      const text = (Array.isArray(sql) ? sql.join('?') : '').replace(/\s+/g, ' ');
      if (
        text.includes('UPDATE "Model"') &&
        text.includes(`WHEN "publishedAt" IS NULL THEN 'Draft'::"ModelStatus"`) &&
        text.includes(`"status" = 'Deleted'::"ModelStatus"`) &&
        row.status === 'Deleted'
      ) {
        row.status =
          row.publishedAt == null
            ? 'Draft'
            : row.publishedAt > new Date()
            ? 'Scheduled'
            : 'Unpublished';
        return [{ userId: row.userId }];
      }
      return [];
    }) as never);
    await restoreModelById({ id: MODEL_ID });
    expect(row.status).toBe('Draft');

    await expect(publish()).resolves.toBeDefined();
  });

  it('control: an unstamped draft that was never published is still refused', async () => {
    row.status = 'Draft';
    await expect(publish()).rejects.toThrow(/can no longer be checked/);
  });
});

const approvedRun = {
  id: 'wf-1',
  steps: [
    {
      $type: 'training',
      output: {
        moderationStatus: 'approved',
        epochs: [{ epochNumber: 1, model: { url: 'https://blobs/e1', available: true } }],
      },
    },
  ],
};

// The flags the check writes must survive the meta write that the same request makes afterwards
// from a copy of meta it read earlier.
describe('flags written by the check survive the publish write that follows', () => {
  it('publish keeps the marker it earned on evidence', async () => {
    row.status = 'Unpublished';
    row.publishedAt = new Date('2026-09-10');
    await expect(publish()).resolves.toBeDefined();
    expect(row.meta).toMatchObject({ trainingStudioPublishedBeforeStamp: true });
  });

  it('publish keeps the approval stamp for a readable approved run', async () => {
    row.status = 'Draft';
    mockGetWorkflow.mockResolvedValue(approvedRun);
    await expect(publish()).resolves.toBeDefined();
    expect(row.meta).toMatchObject({ trainingStudioModerationApproved: true });
  });

  it('private publish from training keeps the approval stamp', async () => {
    row.status = 'Draft';
    row.availability = 'Public';
    mockGetWorkflow.mockResolvedValue(approvedRun);
    syncReplica();
    await privateModelFromTrainingHandler({
      input: { id: MODEL_ID, name: 'm', type: 'LORA', sfwOnly: true, meta: {} },
      ctx: { user: { id: OWNER_ID, isModerator: false }, track: { post: vi.fn() } },
    } as never);
    expect(row.meta).toMatchObject({ trainingStudioModerationApproved: true });
  });

  it('making a private model public keeps the approval stamp', async () => {
    mockGetWorkflow.mockResolvedValue(approvedRun);
    dbMock.dbWrite.post.findMany.mockResolvedValue([{ modelVersionId: 43 }] as never);
    dbMock.dbRead.modelVersion.findMany.mockResolvedValue([{ id: 43 }] as never);
    syncReplica();
    await publishPrivateModelHandler({
      input: { modelId: MODEL_ID, publishVersions: true },
      ctx: { user: { id: OWNER_ID, isModerator: false } },
    } as never);
    expect(row.meta).toMatchObject({ trainingStudioModerationApproved: true });
  });
});
