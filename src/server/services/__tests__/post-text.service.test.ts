import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { NsfwLevel } from '~/server/common/enums';
import type * as BlocklistService from '~/server/services/blocklist.service';
import type * as NsfwLevels from '~/server/services/nsfwLevels.service';
import type * as Submit from '~/server/services/text-scan/submit';

vi.mock('~/server/services/blocklist.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BlocklistService>()),
  throwOnBlockedUserContent: vi.fn(),
}));
vi.mock('~/server/services/text-scan/submit', async (importOriginal) => ({
  ...(await importOriginal<typeof Submit>()),
  scanEntityInBackground: vi.fn(),
}));
vi.mock('~/server/services/nsfwLevels.service', async (importOriginal) => ({
  ...(await importOriginal<typeof NsfwLevels>()),
  updatePostNsfwLevels: vi.fn(async () => []),
}));

const { addPostText, setPostText, deletePostText, getPostTextsForViewer, getStorylineTextStubs } =
  await import('~/server/services/post-text.service');
const { throwOnBlockedUserContent } = await import('~/server/services/blocklist.service');
const { setStorylineTextSchema } = await import('~/server/schema/storyline.schema');
const { OWNER_CONTENT_KEPT } = await import('~/server/services/legal-hold.service');
const { scanEntityInBackground } = await import('~/server/services/text-scan/submit');
const { updatePostNsfwLevels } = await import('~/server/services/nsfwLevels.service');
const { postTextTextScanSubject } = await import(
  '~/server/services/text-scan/profiles/post-text.profile'
);
const { scannableTextForms } = await import('~/server/services/blocklist.service');

const w = dbMock.dbWrite;
const r = dbMock.dbRead;
const AUTHOR = 7;
const POST = 5;
const TEXT = 31;

/** The one content write, as the hold-checked UPDATE it is. */
const written = () => {
  expect(w.$executeRaw).toHaveBeenCalledTimes(1);
  const [sql] = w.$executeRaw.mock.calls[0] as unknown as [Prisma.Sql];
  expect(sql.sql).toContain('NOT post_text_held(');
  return { resetLevel: sql.sql.includes('"nsfwLevel" = 0'), values: sql.values };
};

const stored = (content = '<p>old</p>', csamHeld = false) =>
  w.postText.findUnique.mockResolvedValue({
    id: TEXT,
    postId: POST,
    content,
    csamHeld,
    post: { userId: AUTHOR },
  } as never);

beforeEach(() => {
  vi.clearAllMocks();
  w.$queryRaw.mockResolvedValue([] as never);
  w.$executeRaw.mockResolvedValue(1 as never);
  w.post.findUnique.mockResolvedValue({ userId: AUTHOR } as never);
  w.storylineChapter.findFirst.mockResolvedValue({ id: 9 } as never);
  w.storylinePendingChapter.findUnique.mockResolvedValue(null as never);
  w.postText.count.mockResolvedValue(0 as never);
  w.postText.create.mockResolvedValue({ id: TEXT } as never);
  stored();
});

describe('addPostText', () => {
  it("adds an empty text at the index it is given, on the author's chapter post", async () => {
    await addPostText({ postId: POST, index: 3, userId: AUTHOR });
    expect(w.postText.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: { postId: POST, userId: AUTHOR, index: 3, content: '' } })
    );
  });

  it('refuses anyone but the author, a post that is no chapter, and a 21st text', async () => {
    await expect(addPostText({ postId: POST, index: 3, userId: 99 })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    w.storylineChapter.findFirst.mockResolvedValueOnce(null as never);
    await expect(addPostText({ postId: POST, index: 3, userId: AUTHOR })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    w.postText.count.mockResolvedValueOnce(20 as never);
    await expect(addPostText({ postId: POST, index: 3, userId: AUTHOR })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(w.postText.create).not.toHaveBeenCalled();
  });
});

describe('setPostText', () => {
  it('refuses to change held text', async () => {
    w.$queryRaw.mockResolvedValue([{ postId: POST }] as never);
    await expect(setPostText({ id: TEXT, content: '', userId: AUTHOR })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: OWNER_CONTENT_KEPT,
    });
    expect(w.$executeRaw).not.toHaveBeenCalled();
  });

  it('refuses the edit when a hold lands after the check, writing nothing over it', async () => {
    w.$executeRaw.mockResolvedValue(0 as never);
    await expect(
      setPostText({ id: TEXT, content: '<p>new</p>', userId: AUTHOR })
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: OWNER_CONTENT_KEPT });
    expect(scanEntityInBackground).not.toHaveBeenCalled();
    expect(updatePostNsfwLevels).not.toHaveBeenCalled();
  });

  it('keeps text only: media and embeds are stripped on the way in', () => {
    const { content } = setStorylineTextSchema.parse({
      id: 1,
      content:
        '<p><strong>a</strong> <img src="https://x/y.png"><iframe src="https://www.youtube.com/embed/z"></iframe></p>',
    });
    expect(content).toBe('<p><strong>a</strong> </p>');
  });

  it('keeps headings and lists, without attributes', () => {
    const { content } = setStorylineTextSchema.parse({
      id: 1,
      content:
        '<h2 style="color:red" class="x">Title</h2><h3>Sub</h3><ul><li>one</li></ul><ol><li>two</li></ol><h1>big</h1>',
    });
    expect(content).toBe('<h2>Title</h2><h3>Sub</h3><ul><li>one</li></ul><ol><li>two</li></ol>big');
  });

  it('scans and blocklist-checks list items and headings as separate words', () => {
    const content = '<h2>sea</h2>side<ul><li>fire</li><li>arm</li></ul>';
    expect(postTextTextScanSubject({ userId: AUTHOR, content }).fields[0].text).toBe(
      'sea side fire arm'
    );
    expect(scannableTextForms(content)).toContain('sea side fire arm');
  });

  it('resets the rating to 0 in the same write, scans the new text and recomputes the post', async () => {
    await setPostText({ id: TEXT, content: '<p>new</p>', userId: AUTHOR });
    expect(written()).toEqual({ resetLevel: true, values: ['<p>new</p>', TEXT] });
    expect(scanEntityInBackground).toHaveBeenCalledWith({ entityType: 'PostText', entityId: TEXT });
    expect(updatePostNsfwLevels).toHaveBeenCalledWith([POST]);
  });

  it('writes and bills nothing for unchanged text', async () => {
    await setPostText({ id: TEXT, content: '<p>old</p>', userId: AUTHOR });
    expect(w.$executeRaw).not.toHaveBeenCalled();
    expect(scanEntityInBackground).not.toHaveBeenCalled();
  });

  it('refuses text over 5,000 characters without its tags, and what the blocklist rejects', async () => {
    const long = `<p>${'a'.repeat(5001)}</p>`;
    await expect(setPostText({ id: TEXT, content: long, userId: AUTHOR })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    // The control: 5,000 characters of text pass though the markup makes it longer.
    await setPostText({ id: TEXT, content: `<p>${'a'.repeat(5000)}</p>`, userId: AUTHOR });
    expect(w.$executeRaw).toHaveBeenCalledTimes(1);

    vi.mocked(throwOnBlockedUserContent).mockRejectedValueOnce(new Error('blocked'));
    await expect(setPostText({ id: TEXT, content: '<p>bad</p>', userId: AUTHOR })).rejects.toThrow(
      'blocked'
    );
    expect(w.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it('keeps the rating of a markup-only edit, which the scan would skip as unchanged', async () => {
    await setPostText({ id: TEXT, content: '<p><strong>old</strong></p>', userId: AUTHOR });
    expect(written()).toEqual({ resetLevel: false, values: ['<p><strong>old</strong></p>', TEXT] });
    expect(scanEntityInBackground).not.toHaveBeenCalled();
  });

  it('runs the blocklist over a markup-only edit, which is where a link lives', async () => {
    vi.mocked(throwOnBlockedUserContent).mockRejectedValueOnce(new Error('blocked'));
    await expect(
      setPostText({ id: TEXT, content: '<p><a href="https://x.test">old</a></p>', userId: AUTHOR })
    ).rejects.toThrow('blocked');
    expect(w.$executeRaw).not.toHaveBeenCalled();
  });

  it('runs the blocklist over a markup-only edit into a list', async () => {
    stored('<p>old new</p>');
    vi.mocked(throwOnBlockedUserContent).mockRejectedValueOnce(new Error('blocked'));
    await expect(
      setPostText({ id: TEXT, content: '<ul><li>old</li><li>new</li></ul>', userId: AUTHOR })
    ).rejects.toThrow('blocked');
    expect(throwOnBlockedUserContent).toHaveBeenCalledWith(
      '<ul><li>old</li><li>new</li></ul>',
      expect.anything()
    );
    expect(w.$executeRaw).not.toHaveBeenCalled();
  });

  it("refuses someone else's text, a moderator's included", async () => {
    await expect(setPostText({ id: TEXT, content: '<p>x</p>', userId: 99 })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    await expect(
      setPostText({ id: TEXT, content: '<p>x</p>', userId: 99, isModerator: true })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(w.$executeRaw).not.toHaveBeenCalled();
  });
});

describe('deletePostText', () => {
  it("deletes the author's text and recomputes the post without it", async () => {
    await deletePostText({ id: TEXT, userId: AUTHOR });
    expect(w.postText.delete).toHaveBeenCalledWith({ where: { id: TEXT } });
    expect(updatePostNsfwLevels).toHaveBeenCalledWith([POST]);
  });

  it("refuses someone else's text; a moderator may delete it", async () => {
    await expect(deletePostText({ id: TEXT, userId: 99 })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(w.postText.delete).not.toHaveBeenCalled();
    await deletePostText({ id: TEXT, userId: 99, isModerator: true });
    expect(w.postText.delete).toHaveBeenCalledTimes(1);
  });

  it('keeps held text from deletion by its author and by a moderator alike', async () => {
    w.$queryRaw.mockResolvedValue([{ postId: POST }] as never);
    // The owner is never told why; a moderator is.
    await expect(deletePostText({ id: TEXT, userId: AUTHOR })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: OWNER_CONTENT_KEPT,
    });
    await expect(deletePostText({ id: TEXT, userId: 99, isModerator: true })).rejects.toMatchObject(
      { code: 'FORBIDDEN', message: expect.stringMatching(/held for review/) }
    );
    expect(w.postText.delete).not.toHaveBeenCalled();
    // The hold is the database's own `post_text_held`, asked of this text.
    const [strings, ...values] = w.$queryRaw.mock.calls[0] as unknown as [
      TemplateStringsArray,
      ...never[]
    ];
    const sql = Prisma.sql(strings, ...values);
    expect(sql.sql).toContain('post_text_held');
    expect(sql.values).toContain(TEXT);
  });
});

describe('what readers are shown', () => {
  const rows = [
    { id: 1, postId: POST, index: 0, content: 'pg', nsfwLevel: NsfwLevel.PG, refused: false },
    { id: 2, postId: POST, index: 1, content: 'xxx', nsfwLevel: NsfwLevel.XXX, refused: false },
  ];

  it('asks only for scanned, unrefused, unheld rows, then holds them to the level', async () => {
    r.postText.findMany.mockResolvedValue(rows as never);
    const texts = await getPostTextsForViewer({
      postId: POST,
      browsingLevel: NsfwLevel.PG | NsfwLevel.PG13,
      seesAll: false,
    });
    expect(r.postText.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { postId: POST, refused: false, csamHeld: false, nsfwLevel: { not: 0 } },
      })
    );
    expect(texts.map((t) => t.id)).toEqual([1]);
  });

  it('gives the author every level and their unscanned text, but never a refused or held text', async () => {
    r.postText.findMany.mockResolvedValue([
      ...rows,
      { id: 3, postId: POST, index: 2, content: 'draft', nsfwLevel: 0, refused: false },
      { id: 4, postId: POST, index: 3, content: 'refused words', nsfwLevel: 1, refused: true },
      {
        id: 5,
        postId: POST,
        index: 4,
        content: 'held words',
        nsfwLevel: 1,
        refused: false,
        csamHeld: true,
      },
    ] as never);
    const texts = await getPostTextsForViewer({
      postId: POST,
      browsingLevel: NsfwLevel.PG,
      seesAll: true,
    });
    expect(r.postText.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { postId: POST, refused: false, csamHeld: false } })
    );
    expect(texts.map((t) => t.id)).toEqual([1, 2, 3]);
    expect(JSON.stringify(texts)).not.toMatch(/refused words|held words/);
  });

  it("holds the path's stubs to the storyline ceiling, with no content", async () => {
    r.postText.findMany.mockResolvedValue(rows as never);
    const stubs = await getStorylineTextStubs({
      postIds: [POST],
      browsingLevel: NsfwLevel.PG | NsfwLevel.XXX,
      maxNsfwLevel: NsfwLevel.R,
    });
    expect(stubs).toEqual([{ id: 1, postId: POST, index: 0, nsfwLevel: NsfwLevel.PG }]);
    expect(r.postText.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { postId: { in: [POST] }, refused: false, csamHeld: false, nsfwLevel: { not: 0 } },
      })
    );
  });
});
