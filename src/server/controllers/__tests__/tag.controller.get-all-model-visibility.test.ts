import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * `tag.getAll` with a `modelId` lists that model's tags. A model the viewer may not open (a draft
 * or `poi` model that isn't theirs, or one whose owner blocked them) must answer as a model with
 * no tags, and its tags must not be read. `getTags` is stubbed; the model rule runs for real over
 * the model row.
 */
const { getTags, amIBlocked } = vi.hoisted(() => ({
  getTags: vi.fn(),
  amIBlocked: vi.fn(),
}));

vi.mock('~/server/services/tag.service', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getTags,
}));
vi.mock('~/server/services/user.service', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  amIBlockedByUser: amIBlocked,
}));

const { getAllTagsHandler } = await import('~/server/controllers/tag.controller');

type HandlerCtx = Parameters<typeof getAllTagsHandler>[0]['ctx'];

const MODEL_ID = 31;
const OWNER = 5;
const STRANGER = { id: 77, isModerator: false };
const MOD = { id: 88, isModerator: true };
const TAGS = [{ id: 1, name: 'anime' }];

const ctx = (user: unknown) => ({ user, features: { adminTags: false } } as unknown as HandlerCtx);
const call = (user: unknown, modelId: number | null = MODEL_ID) =>
  getAllTagsHandler({
    input: { ...(modelId !== null && { modelId }), limit: 20 } as never,
    ctx: ctx(user),
  });
const modelIs = (model: Record<string, unknown> | null) =>
  dbMock.dbRead.model.findUnique.mockResolvedValue(
    (model && { status: 'Published', userId: OWNER, poi: false, ...model }) as never
  );

beforeEach(() => {
  vi.clearAllMocks();
  amIBlocked.mockResolvedValue(false);
  // An unknown model id matches no TagsOnModels rows.
  getTags.mockImplementation(async ({ modelId }: { modelId?: number }) => ({
    items: modelId === MODEL_ID ? TAGS : [],
  }));
});

describe('getAllTagsHandler with a modelId', () => {
  it('answers a draft model of someone else exactly as a model with no tags', async () => {
    modelIs({ status: 'Draft' });
    const hidden = await call(STRANGER);
    getTags.mockClear();

    modelIs({});
    const noTags = await call(STRANGER, 999);

    expect(hidden.items).toEqual([]);
    expect(hidden).toEqual(noTags);
  });

  it.each([
    ['a draft model, signed out', { status: 'Draft' }, null],
    ['a poi model, to a stranger', { poi: true }, STRANGER],
  ])('does not read the tags of %s', async (_, model, user) => {
    modelIs(model);
    expect((await call(user)).items).toEqual([]);
    expect(getTags).not.toHaveBeenCalled();
  });

  it('answers a published model as having no tags to a viewer its owner blocked', async () => {
    modelIs({});
    amIBlocked.mockResolvedValue(true);
    expect((await call(STRANGER)).items).toEqual([]);
    expect(getTags).not.toHaveBeenCalled();
  });

  it('serves a model to a moderator its owner blocked, without a block lookup', async () => {
    modelIs({ status: 'Draft' });
    amIBlocked.mockResolvedValue(true);
    expect((await call(MOD)).items).toEqual(TAGS);
    expect(amIBlocked).not.toHaveBeenCalled();
  });

  it('serves a draft model to its owner and to a moderator', async () => {
    for (const user of [{ id: OWNER }, MOD]) {
      modelIs({ status: 'Draft' });
      expect((await call(user)).items).toEqual(TAGS);
    }
  });

  it('control: serves a published model to anyone', async () => {
    for (const user of [null, STRANGER]) {
      modelIs({});
      expect((await call(user)).items).toEqual(TAGS);
    }
  });

  it('control: without a modelId, reads no model', async () => {
    await call(STRANGER, null);
    expect(dbMock.dbRead.model.findUnique).not.toHaveBeenCalled();
    expect(getTags).toHaveBeenCalledTimes(1);
  });
});
