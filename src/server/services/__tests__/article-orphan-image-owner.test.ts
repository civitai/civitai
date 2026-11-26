import type * as ContentDeletion from '@civitai/db-queries/content-deletion';
import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as BlocklistService from '~/server/services/blocklist.service';
import type * as BlurbMaterializeService from '~/server/services/blurb-materialize.service';
import type * as DbLagHelpers from '~/server/db/db-lag-helpers';
import type * as ImageService from '~/server/services/image.service';
import type * as TextModerationService from '~/server/services/text-moderation.service';
import type * as TextScanRoute from '~/server/services/text-scan/route';

// Which queued images are unused is the shared check's (queue-image-deletes.pglite.test.ts); these
// tests cover which images an article hands it, for whom, and when.
const { queueImageDeletes } = vi.hoisted(() => ({
  queueImageDeletes: vi.fn(async (..._args: unknown[]) => undefined),
}));

vi.mock('@civitai/db-queries/content-deletion', async (importOriginal) => ({
  ...(await importOriginal<typeof ContentDeletion>()),
  queueImageDeletes,
}));
// The Redis-backed post-commit helpers never settle without a live Redis, so they are stubbed.
vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageService>()),
  enqueueImageIngestion: vi.fn(),
}));
vi.mock('~/server/services/blocklist.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BlocklistService>()),
  throwOnBlockedUserContent: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/blurb-materialize.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BlurbMaterializeService>()),
  expandBlurbs: vi.fn(async ({ html }: { html: string }) => ({ evaluated: true, html, uses: [] })),
  getReferencedBlurbIds: vi.fn(async () => []),
  reconcileBlurbReferences: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/text-moderation.service', async (importOriginal) => ({
  ...(await importOriginal<typeof TextModerationService>()),
  submitTextModeration: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/text-scan/route', async (importOriginal) => ({
  ...(await importOriginal<typeof TextScanRoute>()),
  submitTextModerationOrScan: vi.fn(async () => undefined),
}));
vi.mock('~/server/db/db-lag-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof DbLagHelpers>()),
  preventReplicationLag: vi.fn(async () => undefined),
}));

import {
  applyArticleContentChange,
  deleteArticleById,
  linkArticleContentImages,
  upsertArticle,
} from '~/server/services/article.service';
import { articlesSearchIndex } from '~/server/search-index';
import { withheldMediaPlaceholders } from '~/server/utils/article-withheld-media';
import { expandBlurbs } from '~/server/services/blurb-materialize.service';

const ARTICLE_ID = 21;
const AUTHOR = 7;
const SOMEONE_ELSE = 8;
const MODERATOR = 99;

// The content images every edit or delete below unlinks from the article.
const UNLINKED = [1, 2, 3];
const COVER = 13;

/** Each queue call: the candidate ids, and whose images the shared check reads them as. */
const queued = () =>
  queueImageDeletes.mock.calls.map(([, ids, options]) => ({
    ids: [...new Set(ids as number[])].sort((x, y) => x - y),
    ...(options as object),
  }));
const queuedIds = () => queued().flatMap((call) => call.ids);

const storedArticle = {
  id: ARTICLE_ID,
  userId: AUTHOR,
  title: 'A title',
  content: '<p>had images</p>',
  coverId: null,
  status: 'Draft',
  scheduledAt: null,
  publishedAt: null,
  nsfwLevel: 1,
  userNsfwLevel: 1,
  lockedProperties: [],
  metadata: {},
};

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.$queryRaw.mockResolvedValue([] as never);
  // Each row answers both reads: the orphan check's imageId and the save's connected image.
  dbMock.dbWrite.imageConnection.findMany.mockResolvedValue(
    UNLINKED.map((imageId) => ({
      imageId,
      image: { id: imageId, url: `uuid-${imageId}` },
    })) as never
  );
  dbMock.dbWrite.image.findMany.mockResolvedValue([] as never);
  dbMock.dbWrite.article.findUnique.mockResolvedValue(storedArticle as never);
  dbMock.dbRead.article.findUnique.mockResolvedValue(storedArticle as never);
  dbMock.dbWrite.article.update.mockResolvedValue(storedArticle as never);
  dbMock.dbWrite.article.delete.mockResolvedValue({ coverId: null } as never);
});

describe('an owner save that leaves out an image held for review', () => {
  const HELD = { id: 30, needsReview: 'csam' };
  const PLAIN = { id: 31, needsReview: null };

  beforeEach(() => {
    // The article's connections, filtered as Prisma would: a dropped filter widens the result.
    dbMock.dbWrite.imageConnection.findMany.mockImplementation((async ({ where }: any) => {
      const { entityType: _type, entityId: _id, imageId, NOT, ...rest } = where;
      if (Object.keys(rest).length) throw new Error(`unexpected filter ${Object.keys(rest)}`);
      return [HELD, PLAIN]
        .filter((image) => !imageId.notIn.includes(image.id))
        .filter((image) => !NOT || image.needsReview !== NOT.image.needsReview)
        .map((image) => ({ imageId: image.id }));
    }) as never);
  });

  const save = () =>
    linkArticleContentImages({
      articleId: ARTICLE_ID,
      content: '',
      userId: AUTHOR,
      ownerId: AUTHOR,
      cleanupOnly: true,
    });
  const deletedConnections = () =>
    dbMock.dbWrite.imageConnection.deleteMany.mock.calls.flatMap(
      ([args]: any) => args.where.imageId.in
    );

  it('🔴 keeps the held image connected to the article and unqueued, and takes the plain one', async () => {
    await save();

    expect(deletedConnections()).toEqual([PLAIN.id]);
    expect(queuedIds()).toEqual([PLAIN.id]);
  });
});

describe('applyArticleContentChange', () => {
  it.each([
    ['the author', AUTHOR],
    ['a moderator', MODERATOR],
  ])("queues every image the edit unlinks as the author's when %s edits", async (_, userId) => {
    await applyArticleContentChange({
      id: ARTICLE_ID,
      userId,
      content: '<p>no images left</p>',
      scanContent: false,
      context: {
        ownerId: AUTHOR,
        title: 'A title',
        previousContent: '<p>had images</p>',
        coverId: null,
        bannerId: null,
        publication: { status: 'Draft' as never, scheduledAt: null },
      },
    });

    expect(queued()).toEqual([{ ids: UNLINKED, ownerId: AUTHOR }]);
  });
});

describe('deleteArticleById', () => {
  const steps: string[] = [];
  beforeEach(() => {
    steps.length = 0;
    dbMock.dbWrite.article.findUnique.mockResolvedValue({
      ...storedArticle,
      coverId: COVER,
    } as never);
    dbMock.dbWrite.article.delete.mockImplementation((async () => {
      steps.push('article');
      return { coverId: COVER };
    }) as never);
    dbMock.dbWrite.$queryRaw.mockImplementation((async (strings: TemplateStringsArray) => {
      if (Array.from(strings).join('?').includes('FOR NO KEY UPDATE')) steps.push('lock');
      return [];
    }) as never);
    queueImageDeletes.mockImplementation(async () => {
      steps.push('queue');
    });
  });

  it.each([
    ['the author', AUTHOR, false, false],
    ['a moderator', MODERATOR, true, true],
    ['a moderator who wrote it', AUTHOR, true, false],
  ])(
    "queues the cover and content images as the author's when %s deletes it",
    async (_, userId, isModerator, moderatorDelete) => {
      await deleteArticleById({ id: ARTICLE_ID, userId, isModerator });

      expect(queued()).toEqual([{ ids: [...UNLINKED, COVER], ownerId: AUTHOR, moderatorDelete }]);
    }
  );

  // Unlocked, two articles deleted together each see the other's uncommitted connections and both
  // skip a shared image. Before the article's own delete, or it deadlocks against an image delete,
  // which takes the image and then the article (the banner foreign key).
  it('locks the images, then deletes the article, then queues them', async () => {
    await deleteArticleById({ id: ARTICLE_ID, userId: AUTHOR });

    expect(steps).toEqual(['lock', 'article', 'queue']);
    const lock = dbMock.dbWrite.$queryRaw.mock.calls.find(([strings]) =>
      Array.from(strings as TemplateStringsArray)
        .join('?')
        .includes('FOR NO KEY UPDATE')
    );
    expect(lock?.[1]).toEqual(expect.arrayContaining([...UNLINKED, COVER]));
  });

  it('queues a cover or banner saved after it read the article', async () => {
    dbMock.dbWrite.article.findUnique.mockResolvedValue(storedArticle as never);
    dbMock.dbWrite.article.delete.mockResolvedValue({ coverId: COVER, bannerId: 40 } as never);

    await deleteArticleById({ id: ARTICLE_ID, userId: AUTHOR });

    expect(queuedIds()).toEqual(expect.arrayContaining([COVER, 40]));
  });

  it('keeps the article when its images cannot be queued', async () => {
    const queueUpdate = vi.spyOn(articlesSearchIndex, 'queueUpdate').mockResolvedValue(undefined);
    queueImageDeletes.mockRejectedValue(new Error('db down'));

    await expect(deleteArticleById({ id: ARTICLE_ID, userId: AUTHOR })).rejects.toThrow();
    expect(queueUpdate).not.toHaveBeenCalled();
  });
});

describe('the article cover and banner on save', () => {
  const OLD_COVER = 30;
  const OLD_BANNER = 31;
  const NEW_IMAGE = 32;
  const FOREIGN = 34;
  const owners: Record<number, number> = {
    [OLD_COVER]: AUTHOR,
    [OLD_BANNER]: AUTHOR,
    [NEW_IMAGE]: AUTHOR,
    [FOREIGN]: SOMEONE_ELSE,
  };

  /** The article row as the update left it. */
  let saved: { coverId: number | null; bannerId: number | null };
  const stored = { ...storedArticle, coverId: OLD_COVER, bannerId: OLD_BANNER };

  beforeEach(() => {
    saved = { coverId: OLD_COVER, bannerId: OLD_BANNER };
    dbMock.dbWrite.article.findUnique.mockResolvedValue(stored as never);
    dbMock.dbWrite.article.update.mockImplementation((async ({ data }: any) => {
      saved = {
        coverId: data.coverId === undefined ? stored.coverId : data.coverId,
        bannerId: data.bannerId === undefined ? stored.bannerId : data.bannerId,
      };
      return { ...stored, ...saved };
    }) as never);
    dbMock.dbRead.image.findUnique.mockImplementation((async ({ where }: any) => ({
      userId: owners[where.id],
    })) as never);
  });

  const save = (
    images: { coverImage?: number | null; bannerImage?: number | null },
    userId = AUTHOR,
    reportListedViewer?: { seesReportListed: boolean; ownerSeesReportListed?: boolean }
  ) =>
    upsertArticle({
      id: ARTICLE_ID,
      userId,
      isModerator: userId === MODERATOR,
      reportListedViewer,
      title: 'A title',
      content: '<p>had images</p>',
      status: 'Draft',
      ...(images.coverImage !== undefined
        ? { coverImage: images.coverImage && { id: images.coverImage, url: 'u' } }
        : {}),
      ...(images.bannerImage !== undefined
        ? { bannerImage: images.bannerImage && { id: images.bannerImage, url: 'u' } }
        : {}),
    } as never);

  it("refuses someone else's image as the banner", async () => {
    await expect(save({ coverImage: OLD_COVER, bannerImage: FOREIGN })).rejects.toThrow(
      'Invalid banner image'
    );
  });

  it('queues neither when the save does not mention them', async () => {
    await save({});

    expect(saved).toEqual({ coverId: OLD_COVER, bannerId: OLD_BANNER });
    expect(queuedIds()).toEqual([]);
  });

  it.each([
    ['cleared', null],
    ['replaced', NEW_IMAGE],
  ])("queues the banner as the author's when it is %s", async (_, banner) => {
    await save({ coverImage: OLD_COVER, bannerImage: banner });

    expect(saved.bannerId).toBe(banner);
    expect(queued()).toEqual([{ ids: [OLD_BANNER], ownerId: AUTHOR }]);
  });

  it("queues a cover a moderator replaces as the author's", async () => {
    await save({ coverImage: NEW_IMAGE }, MODERATOR);

    expect(queued()).toEqual([{ ids: [OLD_COVER], ownerId: AUTHOR }]);
  });

  // A moderator's form carries a restricted banner (getArticleById), so their null removes it.
  it("clears a restricted banner on a moderator's save", async () => {
    const base = dbMock.dbWrite.image.findMany.getMockImplementation();
    dbMock.dbWrite.image.findMany.mockImplementation((async (args: any) =>
      args.select?.modelRestricted
        ? args.where.id.in.map((id: number) => ({ id, nsfwLevel: 4, modelRestricted: true }))
        : base?.(args)) as never);

    await save({ coverImage: OLD_COVER, bannerImage: null }, MODERATOR);

    expect(saved.bannerId).toBeNull();
  });

  // getArticleById withholds a cover or banner whose block refuses the author the media, so the
  // author's form sends null for it.
  describe('a cover and banner blocked by a moderation action', () => {
    beforeEach(() => {
      const base = dbMock.dbWrite.image.findMany.getMockImplementation();
      dbMock.dbWrite.image.findMany.mockImplementation((async (args: any) =>
        args.select?.blockedFor
          ? args.where.id.in.map((id: number) => ({
              id,
              ingestion: 'Blocked',
              blockedFor: id === OLD_COVER ? 'tos' : 'moderated',
            }))
          : base?.(args)) as never);
    });

    it('keeps both when the author saves without them', async () => {
      await save({ coverImage: null, bannerImage: null });

      expect(saved).toEqual({ coverId: OLD_COVER, bannerId: OLD_BANNER });
      expect(queuedIds()).toEqual([]);
    });

    it('replaces the cover when the author saves a new image of theirs', async () => {
      await save({ coverImage: NEW_IMAGE, bannerImage: null });

      expect(saved).toEqual({ coverId: NEW_IMAGE, bannerId: OLD_BANNER });
    });

    it('still refuses an image the author does not own as the replacement', async () => {
      await expect(save({ coverImage: FOREIGN, bannerImage: null })).rejects.toThrow(
        'Invalid cover image'
      );
    });

    it("clears them on a moderator's save, whose form carried them", async () => {
      await save({ coverImage: null, bannerImage: null }, MODERATOR);

      expect(saved).toEqual({ coverId: null, bannerId: null });
    });
  });

  it('still applies the content change when queueing the replaced images fails', async () => {
    queueImageDeletes.mockRejectedValueOnce(new Error('db down'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(
      upsertArticle({
        id: ARTICLE_ID,
        userId: AUTHOR,
        title: 'A title',
        content: '<p>no images left</p>',
        status: 'Draft',
        coverImage: { id: OLD_COVER, url: 'u' },
        bannerImage: { id: NEW_IMAGE, url: 'u' },
      } as never)
    ).resolves.toBeTruthy();
  });

  describe('a save without a cover its model hides from the editor', () => {
    const saveWithoutCover = async (storedCover: number, withheld: boolean) => {
      dbMock.dbWrite.article.findUnique.mockResolvedValue({
        ...stored,
        coverId: storedCover,
      } as never);
      dbMock.dbWrite.$queryRaw.mockImplementation((async (strings: TemplateStringsArray) =>
        strings.join('?').includes('JOIN "Post" p ON p.id = i."postId"') && withheld
          ? [{ id: storedCover }]
          : []) as never);
      dbMock.dbWrite.image.findMany.mockImplementation((async (args: any) =>
        args.select?.userId
          ? args.where.id.in.map((id: number) => ({ id, userId: owners[id] }))
          : []) as never);
      await save({ coverImage: null, bannerImage: OLD_BANNER });
      // What the update wrote for the cover: undefined leaves the column alone.
      const [{ data }] = dbMock.dbWrite.article.update.mock.calls.at(-1) as [{ data: any }];
      return data.coverId;
    };

    it("🔴 keeps a withheld cover someone else uploaded, which the owner's form never had", async () => {
      expect(await saveWithoutCover(FOREIGN, true)).toBeUndefined();
    });

    it('clears it when its model does not withhold it', async () => {
      expect(await saveWithoutCover(FOREIGN, false)).toBeNull();
    });

    it("clears the owner's own withheld cover, which their form showed", async () => {
      expect(await saveWithoutCover(OLD_COVER, true)).toBeNull();
    });
  });

  // The edit form never had a banner the report-listed rule hides (getArticleById), so a save
  // without it keeps it, a moderator's included (#10489).
  describe('a save without a banner the report-listed rule hides from the editor', () => {
    const saveWithoutBanner = async (
      listed: boolean,
      reportListedViewer?: { seesReportListed: boolean }
    ) => {
      // Answers the report-listed lookup, whose CsamReport term arrives as a nested Prisma.Sql.
      dbMock.dbWrite.$queryRaw.mockImplementation((async (
        _strings: TemplateStringsArray,
        ...values: unknown[]
      ) =>
        listed && values.some((v) => (v as { sql?: string })?.sql?.includes('"CsamReport"'))
          ? [{ id: OLD_BANNER }]
          : []) as never);
      await save({ coverImage: OLD_COVER, bannerImage: null }, MODERATOR, reportListedViewer);
      const [{ data }] = dbMock.dbWrite.article.update.mock.calls.at(-1) as [{ data: any }];
      return data.bannerId;
    };

    it('🔴 keeps a listed banner on the save of a moderator without the grant', async () => {
      expect(await saveWithoutBanner(true)).toBeUndefined();
    });

    it('clears it for a viewer who sees report-listed images, whose form showed it', async () => {
      expect(await saveWithoutBanner(true, { seesReportListed: true })).toBeNull();
    });

    it('clears a banner that is not listed', async () => {
      expect(await saveWithoutBanner(false)).toBeNull();
    });
  });
});

describe('a save from the edit form with a body image listed on a report', () => {
  const LISTED = { id: 40, url: '44444444-aaaa-4bbb-8ccc-444444444444' };
  const SHOWN = { id: 41, url: '55555555-aaaa-4bbb-8ccc-555555555555' };
  const img = (url: string) =>
    // As the save sanitizer writes it, which is how a stored body holds it.
    `<img src="https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/${url}/w" />`;
  const body = `<p>a</p>${img(SHOWN.url)}<p>b ${img(LISTED.url)}</p>`;
  // As the edit form read sends it to an editor who may not see the listed image.
  const editForm = `<p>a</p>${img(
    SHOWN.url
  )}<p>b <span data-type="withheldMedia" data-id="1"></span></p>`;

  beforeEach(() => {
    queueImageDeletes.mockResolvedValue(undefined);
    dbMock.dbWrite.article.findUnique.mockResolvedValue({
      ...storedArticle,
      content: body,
    } as never);
    dbMock.dbWrite.imageConnection.findMany.mockImplementation((async (args: any) =>
      args.select?.image
        ? [{ image: LISTED }, { image: SHOWN }]
        : [LISTED, SHOWN]
            .filter((image) => !args.where.imageId?.notIn?.includes(image.id))
            .map((image) => ({ imageId: image.id }))) as never);
    // The report-listed lookup names the listed image; every other raw read finds nothing.
    dbMock.dbWrite.$queryRaw.mockImplementation((async (
      strings: TemplateStringsArray,
      ...values: unknown[]
    ) =>
      Prisma.sql(strings, ...(values as never[])).sql.includes('"CsamReport"')
        ? [{ id: LISTED.id }]
        : []) as never);
  });

  const upsert = (content: string | undefined, extra: Record<string, unknown> = {}) =>
    upsertArticle({
      id: ARTICLE_ID,
      userId: AUTHOR,
      reportListedViewer: { seesReportListed: false, ownerSeesReportListed: true },
      title: 'A title',
      content,
      status: 'Draft',
      ...extra,
    } as never);
  // The body as the article page's plain read gives it to an editor who may not see the image.
  const stripped = `<p>a</p>${img(SHOWN.url)}<p>b </p>`;
  const savedContent = () =>
    (dbMock.dbWrite.article.update.mock.calls.at(-1) as [{ data: { content?: string } }])[0].data
      .content;

  it('🔴 saves the stored body back unchanged when nothing was edited', async () => {
    await upsert(editForm);
    expect(savedContent()).toBe(body);
  });

  it('🔴 answers the save with the body as the form sent it, without the hidden image', async () => {
    dbMock.dbWrite.article.update.mockImplementation((async ({ data }: any) => ({
      ...storedArticle,
      ...data,
    })) as never);
    const saved = (await upsert(editForm)) as { content?: string };
    expect(saved.content).toBe(editForm);
    expect(JSON.stringify(saved)).not.toContain(LISTED.url);
  });

  it('🔴 refuses a placeholder that names an image the editor may see', async () => {
    const forged = `<p>a</p><span data-type="withheldMedia" data-id="0"></span>`;
    await expect(upsert(forged)).rejects.toThrow();
    expect(dbMock.dbWrite.article.update).not.toHaveBeenCalled();
  });

  it('🔴 keeps the stored body when a moderator without the grant publishes with no body', async () => {
    await upsert(undefined, { userId: MODERATOR, isModerator: true, status: 'Published' });
    expect(savedContent()).toBe(body);
  });

  describe('answering a save that sent no body', () => {
    beforeEach(() => {
      dbMock.dbWrite.article.update.mockImplementation((async ({ data }: any) => ({
        ...storedArticle,
        ...data,
      })) as never);
    });

    it.each([
      [
        'a moderator without the grant',
        { userId: MODERATOR, isModerator: true, reportListedViewer: { seesReportListed: false } },
      ],
      [
        "the owner, for someone else's listed upload",
        { reportListedViewer: { seesReportListed: false, ownerSeesReportListed: true } },
      ],
      ['the owner on a scoped key', { reportListedViewer: { seesReportListed: false } }],
    ])('🔴 gives %s no body back', async (_, extra) => {
      const saved = (await upsert(undefined, { ...extra, status: 'Published' })) as object;
      expect(savedContent()).toBe(body);
      expect(saved).not.toHaveProperty('content');
      expect(JSON.stringify(saved)).not.toContain(LISTED.url);
    });
  });

  it('🔴 keeps a link to the listed image when a moderator without the grant saves unchanged', async () => {
    const linked = `${body}<p><a href="https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/${LISTED.url}/original=true" target="_blank">see</a></p>`;
    dbMock.dbWrite.article.findUnique.mockResolvedValue({
      ...storedArticle,
      content: linked,
    } as never);
    // As the editor gives it back: the link mark renders an empty href beside the ref.
    const fromEditor = `${editForm}<p><a target="_blank" href="" data-withheld-href="0">see</a></p>`;
    await upsert(fromEditor, {
      userId: MODERATOR,
      isModerator: true,
      reportListedViewer: { seesReportListed: false },
      editForm: true,
    });
    expect(savedContent()).toContain(body);
    expect(savedContent()).toMatch(
      new RegExp(
        `<a [^>]*href="https://image.civitai.com/[^"]*/${LISTED.url}/original=true"[^>]*>see</a>`
      )
    );
    expect(savedContent()).not.toContain('data-withheld-href');
    // The restored link went through the save sanitizer.
    expect(savedContent()).toMatch(/<a [^>]*rel="ugc"[^>]*>see<\/a>/);
  });

  it('🔴 refuses a link ref that names no stored link, and writes nothing', async () => {
    const dangling = `${editForm}<p><a data-withheld-href="9">see</a></p>`;
    await expect(upsert(dangling, { editForm: true })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(dbMock.dbWrite.article.update).not.toHaveBeenCalled();
  });

  it('🔴 keeps the listed image when a save from outside the edit form leaves it out', async () => {
    const saved = (await upsert(stripped)) as { content?: string };
    expect(savedContent()).toContain(img(LISTED.url));
    expect(saved.content).toBe(stripped);
  });

  it('removes it when an edit-form save deletes its placeholder (control)', async () => {
    await upsert(stripped, { editForm: true });
    expect(savedContent()).toBe(stripped);
  });

  describe('when its placeholder is deleted', () => {
    const unlink = () =>
      linkArticleContentImages({
        articleId: ARTICLE_ID,
        content: '',
        userId: AUTHOR,
        ownerId: AUTHOR,
        cleanupOnly: true,
      });
    const deletedConnections = () =>
      dbMock.dbWrite.imageConnection.deleteMany.mock.calls.flatMap(
        ([args]: any) => args.where.imageId.in
      );

    it('🔴 unlinks the listed image but never queues it for cleanup', async () => {
      await unlink();
      expect(deletedConnections()).toEqual([LISTED.id, SHOWN.id]);
      expect(queuedIds()).toEqual([SHOWN.id]);
    });
  });
});

describe('a new article', () => {
  it('🔴 stores the body the server expanded, which is the one it checked', async () => {
    vi.mocked(expandBlurbs).mockResolvedValueOnce({
      evaluated: true,
      html: '<p>expanded</p>',
      uses: [],
    } as never);
    dbMock.dbWrite.article.create.mockResolvedValue({ ...storedArticle, id: 99 } as never);
    await upsertArticle({
      userId: AUTHOR,
      title: 'A title',
      content: '<p>as sent</p>',
      status: 'Draft',
    } as never).catch(() => undefined);
    expect(dbMock.dbWrite.article.create).toHaveBeenCalled();
    const [{ data }] = dbMock.dbWrite.article.create.mock.calls[0] as [
      { data: { content: string } }
    ];
    expect(data.content).toBe('<p>expanded</p>');
  });
});

// getArticleById withholds a body image whose block refuses its author the media, as a placeholder on
// the edit form; a save must put it back, so a lifted block or won appeal still has it.
describe("a body image blocked by a moderation action, on the author's save", () => {
  const TOS_BODY = {
    id: 40,
    url: 'tos-key',
    needsReview: null,
    ingestion: 'Blocked',
    blockedFor: 'tos',
  };
  const MOD_BODY = {
    id: 41,
    url: 'mod-key',
    needsReview: null,
    ingestion: 'Blocked',
    blockedFor: 'moderated',
  };
  const CLEAN_BODY = {
    id: 42,
    url: 'clean-key',
    needsReview: null,
    ingestion: 'Scanned',
    blockedFor: null,
  };
  // As the sanitizer stores a body.
  const STORED = `<p>text</p><img src="${TOS_BODY.url}" /><img src="${MOD_BODY.url}" /><img src="${CLEAN_BODY.url}" />`;
  let savedContent: string | undefined;

  beforeEach(() => {
    savedContent = undefined;
    const stored = { ...storedArticle, content: STORED };
    dbMock.dbWrite.article.findUnique.mockResolvedValue(stored as never);
    dbMock.dbRead.article.findUnique.mockResolvedValue(stored as never);
    dbMock.dbWrite.imageConnection.findMany.mockResolvedValue(
      [TOS_BODY, MOD_BODY, CLEAN_BODY].map((image) => ({ imageId: image.id, image })) as never
    );
    dbMock.dbWrite.article.update.mockImplementation((async ({ data }: any) => {
      savedContent = data.content;
      return { ...stored, ...data };
    }) as never);
  });

  const save = (content: string, opts: { editForm?: boolean; userId?: number } = {}) =>
    upsertArticle({
      id: ARTICLE_ID,
      userId: opts.userId ?? AUTHOR,
      isModerator: opts.userId === MODERATOR,
      editForm: opts.editForm ?? true,
      title: 'A new title',
      content,
      status: 'Draft',
    } as never);

  it('keeps both, byte-identical, through a title-only edit-form save', async () => {
    // What getArticleById({ edit: true }) hands the author's form.
    const form = withheldMediaPlaceholders(STORED, new Set([TOS_BODY.url, MOD_BODY.url]));
    expect(form).not.toContain(TOS_BODY.url);
    expect(form).not.toContain(MOD_BODY.url);

    await save(form);

    expect(savedContent).toBe(STORED);
  });

  it('keeps both when a save from outside the edit form leaves them out', async () => {
    await save(`<p>text</p><img src="${CLEAN_BODY.url}">`, { editForm: false });

    expect(savedContent).toContain(TOS_BODY.url);
    expect(savedContent).toContain(MOD_BODY.url);
  });

  it('refuses a placeholder that names a body image the author could see', async () => {
    // The clean image is the third medium: ref 2. A placeholder can only stand for a withheld one.
    const forged = withheldMediaPlaceholders(STORED, new Set([CLEAN_BODY.url]));

    await expect(save(forged)).rejects.toThrow('names an image it does not hold');
  });

  it("lets a moderator's save, whose form carried them, remove them", async () => {
    await save(`<p>text</p><img src="${CLEAN_BODY.url}">`, { userId: MODERATOR });

    expect(savedContent).not.toContain(TOS_BODY.url);
    expect(savedContent).not.toContain(MOD_BODY.url);
  });
});
