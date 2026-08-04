import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as BuzzService from '~/server/services/buzz.service';

/**
 * `report.router.ts`'s `createAppeal` uses `guardedProcedure` with no ownership
 * middleware, so the switch in `createEntityAppealHandler` is the only thing
 * standing between a user and appealing someone else's model. The BAD_REQUEST
 * gate is also what keeps the ~13,700 legacy minor flags (no `minorFlagSnapshot`)
 * off this path.
 */

const { mockModelFindUnique } = vi.hoisted(() => ({ mockModelFindUnique: vi.fn() }));

vi.mock('~/server/db/client', () => ({
  dbRead: { model: { findUnique: mockModelFindUnique } },
  dbWrite: {},
}));
vi.mock('~/server/services/buzz.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BuzzService>()),
}));

import { createEntityAppealHandler } from '../report.controller';
import { EntityType } from '~/shared/utils/prisma/enums';

function ctxUser(id = 602767) {
  return { user: { id } } as never;
}

const baseInput = {
  entityId: 2186217,
  entityType: EntityType.Model,
  message: 'This is my own character design.',
} as const;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('createEntityAppealHandler — Model ownership + flag gates', () => {
  it('throws NOT_FOUND when the model does not exist', async () => {
    mockModelFindUnique.mockResolvedValue(null);

    await expect(
      createEntityAppealHandler({ input: baseInput, ctx: ctxUser() })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('throws UNAUTHORIZED when the caller does not own the model', async () => {
    mockModelFindUnique.mockResolvedValue({
      userId: 999,
      minor: true,
      meta: { minorFlagSnapshot: {} },
    });

    await expect(
      createEntityAppealHandler({ input: baseInput, ctx: ctxUser(602767) })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('throws BAD_REQUEST when the model is not flagged as minor', async () => {
    mockModelFindUnique.mockResolvedValue({
      userId: 602767,
      minor: false,
      meta: { minorFlagSnapshot: {} },
    });

    await expect(
      createEntityAppealHandler({ input: baseInput, ctx: ctxUser(602767) })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('throws BAD_REQUEST when minor but the meta carries no minorFlagSnapshot (legacy flag)', async () => {
    mockModelFindUnique.mockResolvedValue({ userId: 602767, minor: true, meta: {} });

    await expect(
      createEntityAppealHandler({ input: baseInput, ctx: ctxUser(602767) })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});
