import { beforeEach, describe, expect, it } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { getFileWithPermission } from '~/server/services/file.service';

const OWNER = 10;
const STRANGER = 20;
const MOD = 30;
const FILE = { url: 'u', name: 'n', metadata: {}, entityId: 7, entityType: 'Article' };

type Viewer = { userId?: number; isModerator?: boolean };
const read = (viewer: Viewer) => getFileWithPermission({ fileId: 1, ...viewer });
const article = (row: { availability: string; userId: number } | null) =>
  dbMock.dbRead.article.findUnique.mockResolvedValue(row as never);

beforeEach(() => {
  dbMock.dbRead.file.findUnique.mockResolvedValue(FILE as never);
});

describe('getFileWithPermission for an article', () => {
  it.each<[string, Viewer]>([
    ['signed out', {}],
    ['another viewer', { userId: STRANGER }],
  ])('case 1 %s', async (_, viewer) => {
    article({ availability: 'Private', userId: OWNER });
    expect(await read(viewer)).toBeNull();
  });

  it.each<[string, Viewer]>([
    ['the owner', { userId: OWNER }],
    ['a moderator', { userId: MOD, isModerator: true }],
  ])('case 2 %s', async (_, viewer) => {
    article({ availability: 'Private', userId: OWNER });
    expect(await read(viewer)).toEqual(FILE);
  });

  it('case 3', async () => {
    article({ availability: 'Public', userId: OWNER });
    expect(await read({})).toEqual(FILE);
  });

  it('case 4', async () => {
    article(null);
    expect(await read({ userId: STRANGER })).toBeNull();
    expect(await read({ userId: MOD, isModerator: true })).toEqual(FILE);
  });
});
