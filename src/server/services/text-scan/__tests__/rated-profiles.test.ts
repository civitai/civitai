import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { NsfwLevel } from '~/server/common/enums';

await import('~/server/services/text-scan/profiles/index');
const { getTextScanProfile } = await import('~/server/services/text-scan/profiles');

const load = async (entityType: string, id = 1) => {
  const subject = (await getTextScanProfile(entityType)!.load([id])).get(id);
  return {
    ...subject!,
    text: Object.fromEntries(subject!.fields.map((f) => [f.heading, f.text])),
  };
};

beforeEach(() => vi.clearAllMocks());

describe('rated-entity profiles', () => {
  it('registers all six with the spec labels, and no Collection', () => {
    expect(getTextScanProfile('Model')?.labels).toEqual(['nsfw', 'poi', 'minor']);
    expect(getTextScanProfile('Bounty')?.labels).toEqual(['nsfw', 'poi']);
    for (const t of ['Article', 'Post', 'BountyEntry', 'Challenge'])
      expect(getTextScanProfile(t)?.labels).toEqual(['nsfw']);
    expect(getTextScanProfile('Collection')).toBeUndefined();
  });

  it('Model: every version, tags stripped, boolean nsfw declared as a level', async () => {
    dbMock.dbWrite.model.findMany.mockResolvedValue([
      {
        id: 1,
        userId: 9,
        name: 'LoRA',
        description: '<p>Hello</p>',
        nsfw: false,
        poi: true,
        minor: false,
        modelVersions: [{ name: 'v1', description: '<b>notes</b>', trainedWords: ['a', 'b'] }],
      },
    ]);
    const subject = await load('Model');
    expect(subject.userId).toBe(9);
    expect(subject.declared).toEqual({ nsfwLevel: NsfwLevel.PG13, poi: true, minor: false });
    expect(subject.text).toMatchObject({
      Name: 'LoRA',
      Description: 'Hello',
      'Version name': 'v1',
      'Version description': 'notes',
      'Trained words': 'a, b',
    });
    expect(dbMock.dbWrite.model.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: [1] }, deletedAt: null } })
    );
  });

  it('Model: an nsfw model is declared at the top level', async () => {
    dbMock.dbWrite.model.findMany.mockResolvedValue([
      {
        id: 1,
        userId: 9,
        name: 'x',
        description: null,
        nsfw: true,
        poi: false,
        minor: false,
        modelVersions: [],
      },
    ]);
    expect((await load('Model')).declared.nsfwLevel).toBe(NsfwLevel.XXX);
  });

  it('Article: declared is the author level, not the derived one', async () => {
    dbMock.dbWrite.article.findMany.mockResolvedValue([
      { id: 1, userId: 9, title: 'T', content: '<p>Body</p>', userNsfwLevel: 2 },
    ]);
    const subject = await load('Article');
    expect(subject.declared).toEqual({ nsfwLevel: 2 });
    expect(subject.text).toEqual({ Title: 'T', Content: 'Body' });
  });

  it('Post, BountyEntry: declared is the stored level', async () => {
    dbMock.dbWrite.post.findMany.mockResolvedValue([
      { id: 1, userId: 9, title: 'T', detail: '<p>D</p>', nsfwLevel: 5 },
    ]);
    expect(await load('Post')).toMatchObject({
      declared: { nsfwLevel: 5 },
      text: { Title: 'T', Detail: 'D' },
    });
    dbMock.dbWrite.bountyEntry.findMany.mockResolvedValue([
      { id: 1, userId: 9, description: '<p>E</p>', nsfwLevel: 1 },
    ]);
    expect(await load('BountyEntry')).toMatchObject({
      declared: { nsfwLevel: 1 },
      text: { Description: 'E' },
    });
  });

  it('Bounty: nsfw bounties declare the top level, and poi is declared', async () => {
    dbMock.dbWrite.bounty.findMany.mockResolvedValue([
      { id: 1, userId: 9, name: 'N', description: '<p>D</p>', nsfw: true, nsfwLevel: 1, poi: true },
    ]);
    expect((await load('Bounty')).declared).toEqual({ nsfwLevel: NsfwLevel.XXX, poi: true });
  });

  it('Challenge: theme elements come from metadata, owner is the creator', async () => {
    dbMock.dbWrite.challenge.findMany.mockResolvedValue([
      {
        id: 1,
        createdById: 9,
        title: 'T',
        theme: 'Neon',
        description: '<p>D</p>',
        invitation: 'Come',
        metadata: { themeElements: ['rain', 'city'] },
        nsfwLevel: 1,
      },
    ]);
    const subject = await load('Challenge');
    expect(subject.userId).toBe(9);
    expect(subject.text).toMatchObject({ 'Theme elements': 'rain, city', Description: 'D' });
  });

  it('reads the primary, so a scan right after a save sees the new text', async () => {
    dbMock.dbWrite.post.findMany.mockResolvedValue([]);
    await getTextScanProfile('Post')!.load([1]);
    expect(dbMock.dbRead.post.findMany).not.toHaveBeenCalled();
  });
});
