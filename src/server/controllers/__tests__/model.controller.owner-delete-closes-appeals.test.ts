import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ModelService from '~/server/services/model.service';
import type * as ReportService from '~/server/services/report.service';
import type * as Caches from '~/server/redis/caches';

// The delete itself closes the owner's appeal; the sweep only reviews what the owner did not delete.

const { deleteModelByIdMock, permaDeleteModelByIdMock, closeMock, closeQuietMock } = vi.hoisted(
  () => ({
    deleteModelByIdMock: vi.fn(),
    permaDeleteModelByIdMock: vi.fn(),
    closeMock: vi.fn(),
    closeQuietMock: vi.fn(),
  })
);

vi.mock('~/server/services/model.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelService>()),
  deleteModelById: deleteModelByIdMock,
  permaDeleteModelById: permaDeleteModelByIdMock,
}));
vi.mock('~/server/services/report.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ReportService>()),
  closeAppealsDeletedByOwner: closeMock,
  closeAppealsOnDeletedModel: closeQuietMock,
}));
vi.mock('~/server/redis/caches', async (importOriginal) => ({
  ...(await importOriginal<typeof Caches>()),
  dataForModelsCache: { refresh: vi.fn() },
}));
vi.mock('~/server/events', () => ({
  eventEngine: { processEngagement: vi.fn() },
}));

import { deleteModelHandler } from '~/server/controllers/model.controller';

const MODEL_ID = 42;
const OWNER_ID = 7;
const MODERATOR_ID = 1;

const OTHER_ID = 9;

const remove = (userId: number, isModerator: boolean, permanently = false) =>
  deleteModelHandler({
    input: { id: MODEL_ID, permanently },
    ctx: { user: { id: userId, isModerator }, track: { modelEvent: vi.fn() } },
  } as never);

beforeEach(() => {
  vi.clearAllMocks();
  closeMock.mockResolvedValue(undefined);
  closeQuietMock.mockResolvedValue(undefined);
  // The row as the delete left it: `deletedBy` is whoever deleted first.
  deleteModelByIdMock.mockImplementation(async ({ userId }: { userId: number }) => ({
    id: MODEL_ID,
    userId: OWNER_ID,
    nsfwLevel: 1,
    deletedBy: userId,
  }));
  permaDeleteModelByIdMock.mockResolvedValue({ id: MODEL_ID, userId: OWNER_ID, nsfwLevel: 1 });
});

describe('deleteModelHandler', () => {
  it("closes the owner's pending appeals on the model they deleted", async () => {
    await remove(OWNER_ID, false);

    expect(closeMock).toHaveBeenCalledTimes(1);
    expect(closeMock).toHaveBeenCalledWith({
      entityType: 'Model',
      entityIds: [MODEL_ID],
      ownerId: OWNER_ID,
    });
  });

  it("does not close the owner's appeal with the owner notice when a moderator deleted the model", async () => {
    await remove(MODERATOR_ID, true);

    expect(deleteModelByIdMock).toHaveBeenCalled();
    expect(closeMock).not.toHaveBeenCalled();
  });

  it("closes the appeal quietly when a moderator deletes someone else's model", async () => {
    await remove(MODERATOR_ID, true);

    expect(closeQuietMock).toHaveBeenCalledWith({ modelId: MODEL_ID });
  });

  it("closes the appeal quietly when a moderator permanently deletes someone else's model", async () => {
    await remove(MODERATOR_ID, true, true);

    expect(permaDeleteModelByIdMock).toHaveBeenCalled();
    expect(closeMock).not.toHaveBeenCalled();
    expect(closeQuietMock).toHaveBeenCalledWith({ modelId: MODEL_ID });
  });

  it('does not close quietly when the owner deletes their own model', async () => {
    await remove(OWNER_ID, false);

    expect(closeQuietMock).not.toHaveBeenCalled();
  });

  it('closes the appeal when a moderator deletes their own model', async () => {
    deleteModelByIdMock.mockResolvedValue({
      id: MODEL_ID,
      userId: MODERATOR_ID,
      nsfwLevel: 1,
      deletedBy: MODERATOR_ID,
    });

    await remove(MODERATOR_ID, true);

    expect(closeMock).toHaveBeenCalledWith({
      entityType: 'Model',
      entityIds: [MODEL_ID],
      ownerId: MODERATOR_ID,
    });
  });

  it('sends no owner notice for a caller who does not own the model', async () => {
    await remove(OTHER_ID, false);

    expect(closeMock).not.toHaveBeenCalled();
  });

  it('closes quietly, not with the owner notice, when the owner re-deletes a model a moderator already deleted', async () => {
    deleteModelByIdMock.mockResolvedValue({
      id: MODEL_ID,
      userId: OWNER_ID,
      nsfwLevel: 1,
      deletedBy: MODERATOR_ID,
    });

    await remove(OWNER_ID, false);

    expect(closeMock).not.toHaveBeenCalled();
    expect(closeQuietMock).toHaveBeenCalledWith({ modelId: MODEL_ID });
  });

  it('closes nothing when the model was not found', async () => {
    deleteModelByIdMock.mockResolvedValue(null);

    await expect(remove(OWNER_ID, false)).rejects.toThrow();

    expect(closeMock).not.toHaveBeenCalled();
    expect(closeQuietMock).not.toHaveBeenCalled();
  });
});
