import { beforeEach, describe, expect, it } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { getModel3DsInfinite } from '~/server/services/model3d.service';
import { Model3DStatus } from '~/shared/utils/prisma/enums';
import type { SessionUser } from '~/types/session';

const findMany = dbMock.dbRead.model3D.findMany;

type Input = Parameters<typeof getModel3DsInfinite>[0];

const owner = { id: 42, username: 'maker', isModerator: false } as SessionUser;
const stranger = { id: 7, username: 'someone', isModerator: false } as SessionUser;
const moderator = { id: 1, username: 'mod', isModerator: true } as SessionUser;

// The status clause the feed query was built with; the rest of the where is not under test.
async function statusClause(input: Partial<Input>) {
  findMany.mockResolvedValue([]);
  await getModel3DsInfinite({ limit: 20, browsingLevel: 1, ...input } as Input);
  expect(findMany).toHaveBeenCalledTimes(1);
  const AND = findMany.mock.calls[0][0].where.AND as Record<string, unknown>[];
  const clauses = AND.filter((c) => 'status' in c);
  expect(clauses).toHaveLength(1);
  return clauses[0].status;
}

const nonPublished = [Model3DStatus.Draft, Model3DStatus.Unpublished];

beforeEach(() => {
  findMany.mockReset();
});

describe('getModel3DsInfinite status scope', () => {
  it('lists published models for an anonymous caller asking for other statuses', async () => {
    expect(await statusClause({ statuses: nonPublished })).toBe(Model3DStatus.Published);
    findMany.mockReset();
    expect(await statusClause({ status: Model3DStatus.Draft })).toBe(Model3DStatus.Published);
  });

  it('lists published models for a signed-in non-owner asking for other statuses', async () => {
    expect(await statusClause({ statuses: nonPublished, user: stranger })).toBe(
      Model3DStatus.Published
    );
    findMany.mockReset();
    expect(
      await statusClause({ statuses: nonPublished, username: owner.username, user: stranger })
    ).toBe(Model3DStatus.Published);
  });

  it('honours requested statuses for a moderator', async () => {
    expect(await statusClause({ statuses: nonPublished, user: moderator })).toEqual({
      in: nonPublished,
    });
  });

  it('honours requested statuses for the owner on their own scope', async () => {
    expect(
      await statusClause({ statuses: nonPublished, username: owner.username, user: owner })
    ).toEqual({ in: nonPublished });
    findMany.mockReset();
    expect(
      await statusClause({ status: Model3DStatus.Draft, userId: owner.id, user: owner })
    ).toEqual({ in: [Model3DStatus.Draft] });
  });

  it('keeps the owner drafts toggle and the published default', async () => {
    expect(
      await statusClause({ includeDrafts: true, username: owner.username, user: owner })
    ).toEqual({ in: nonPublished });
    findMany.mockReset();
    expect(await statusClause({ includeDrafts: true, user: stranger })).toBe(
      Model3DStatus.Published
    );
  });
});
