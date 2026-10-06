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

import { TRPCError } from '@trpc/server';
import {
  publishModelHandler,
  publishPrivateModelHandler,
} from '~/server/controllers/model.controller';
import {
  deleteModelById,
  publishPrivateModel,
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

/** Back every Model read/write in the mock with `row`. */
function bindRow() {
  const read = async () => ({ ...row, modelVersions: [], meta: row.meta && { ...row.meta } });
  for (const client of [dbMock.dbRead, dbMock.dbWrite]) {
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

const publish = () =>
  publishModelHandler({
    input: { id: MODEL_ID, versionIds: [] },
    ctx: {
      user: { id: OWNER_ID, isModerator: false },
      track: { modelEvent: vi.fn().mockResolvedValue(undefined) },
    },
  } as never);

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
  bindRow();
  dbMock.dbRead.modelVersion.findMany.mockResolvedValue([{ id: 43 }] as never);
  mockGetWorkflow.mockRejectedValue(new TRPCError({ code: 'NOT_FOUND', message: 'gone' }));
});

describe('earlier-publish evidence survives the paths that clear it', () => {
  it('"Set to Draft" (publishPrivateModel without versions), then publish', async () => {
    await publishPrivateModelHandler({
      input: { modelId: MODEL_ID, publishVersions: false },
      ctx: { user: { id: OWNER_ID, isModerator: false } },
    } as never);
    expect(row).toMatchObject({ status: 'Unpublished', publishedAt: null });

    await expect(publish()).resolves.toBeDefined();
  });

  // publishPrivateModel rewrites meta from its own (replica) read, so it must carry the evidence
  // itself: a marker the gate just wrote may not be in what it read. Called directly here, so no gate
  // has written anything first.
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
    // restoreModelById's SQL: publishedAt IS NULL -> Draft.
    row.status = row.publishedAt == null ? 'Draft' : 'Unpublished';

    await expect(publish()).resolves.toBeDefined();
  });

  it('control: an unstamped draft that was never published is still refused', async () => {
    row.status = 'Draft';
    await expect(publish()).rejects.toThrow(/can no longer be checked/);
  });
});
