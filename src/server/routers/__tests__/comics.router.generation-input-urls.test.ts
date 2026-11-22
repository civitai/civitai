import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FeatureFlagsService from '~/server/services/feature-flags.service';

/** Each comics route that sends client urls to a generation checks them before it writes or generates. */

const mocks = vi.hoisted(() => ({
  assertUsable: vi.fn(),
  assertInputs: vi.fn(),
  assertStoredUnblocked: vi.fn(),
  getOrchestratorToken: vi.fn(async () => 'token'),
  submit: vi.fn(),
  whatIf: vi.fn(async (_input: { images: { url: string }[] | null }) => {
    throw new Error('stop');
  }),
}));

vi.mock('~/server/services/feature-flags.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsService>()),
  getFeatureFlags: () => ({ comicCreator: true }),
}));
vi.mock('~/utils/signal-client', () => ({ signalClient: { send: async () => undefined } }));
vi.mock('~/server/orchestrator/get-orchestrator-token', () => ({
  getOrchestratorToken: mocks.getOrchestratorToken,
}));
vi.mock('~/server/services/orchestrator/queue-limits', () => ({
  assertCanGenerate: async () => undefined,
  getUserQueueStatus: async () => ({}),
}));
vi.mock('~/server/services/orchestrator/preset-image-gen.service', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  submitPresetImageGen: mocks.submit,
  whatIfPresetImageGen: mocks.whatIf,
}));
vi.mock('~/server/services/generation-input-urls', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  assertGenerationInputUrlsUsable: mocks.assertUsable,
  assertGenerationInputsUsable: mocks.assertInputs,
  assertStoredImageUrlsUnblocked: mocks.assertStoredUnblocked,
}));

import { comicsRouter } from '../comics.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { OnboardingSteps } from '~/server/common/enums';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { LAYOUT_OPTIONS } from '~/components/Comics/LayoutPicker';

const USER_ID = 7;
const SOURCE = 'ab12cd34-ef56-4a7b-8c9d-0e1f2a3b4c5d';
const REF = 'cd34ab12-ef56-4a7b-8c9d-0e1f2a3b4c5d';

const caller = () =>
  comicsRouter.createCaller({
    user: { id: USER_ID, isModerator: false, onboarding: OnboardingSteps.Buzz, muted: false },
    domain: 'red',
    acceptableOrigin: true,
    needsUpdate: false,
    tokenScope: TokenScope.Full,
    features: { comicCreator: true },
    req: undefined,
    res: { setHeader: () => undefined },
    cache: { edgeTTL: 0 },
    track: {},
    ip: '127.0.0.1',
    fingerprint: 'test',
  } as never);

const refused = new TRPCError({ code: 'BAD_REQUEST', message: 'unavailable' });

beforeEach(() => {
  // Only the generation procedures' account-restriction read gets a row.
  dbMock.dbWrite.user.findUnique.mockImplementation((async (args: {
    select?: Record<string, boolean>;
  }) =>
    Object.keys(args.select ?? {})
      .sort()
      .join() === 'bannedAt,muted'
      ? { muted: false, bannedAt: null }
      : undefined) as never);
  vi.clearAllMocks();
  mocks.assertUsable.mockRejectedValue(refused);
  mocks.assertInputs.mockRejectedValue(refused);
  const project = { id: 11, userId: USER_ID, baseModel: null };
  dbMock.dbRead.comicProject.findUnique.mockResolvedValue(project);
  dbMock.dbRead.comicChapter.findUnique.mockResolvedValue({ project });
});

/** Nothing written and nothing sent to generation. */
const expectNothingStarted = () => {
  expect(mocks.getOrchestratorToken).not.toHaveBeenCalled();
  expect(dbMock.dbWrite.comicPanel.updateMany).not.toHaveBeenCalled();
  expect(dbMock.dbWrite.comicPanel.findFirst).not.toHaveBeenCalled();
  expect(dbMock.dbWrite.comicPanel.create).not.toHaveBeenCalled();
};

/** The urls of each check, each made for the signed-in user. */
const checkedUrls = () =>
  mocks.assertUsable.mock.calls.map((c) => {
    const { urls, userId } = c[0] as { urls: unknown; userId: number };
    expect(userId).toBe(USER_ID);
    return urls;
  });

describe('comics generation inputs', () => {
  it('getGenerationCostEstimate checks its source and reference urls before pricing', async () => {
    const cdnRef = `https://image.civitai.com/x/${REF}/original=true`;
    await expect(
      caller().getGenerationCostEstimate({
        sourceImage: { url: SOURCE, width: 512, height: 512 },
        userReferenceImages: [{ url: cdnRef, width: 512, height: 512 }],
      })
    ).rejects.toBe(refused);
    expect(mocks.assertInputs).toHaveBeenCalledTimes(1);
    expect(mocks.assertInputs.mock.calls[0][0]).toEqual({
      urls: [SOURCE, cdnRef],
      userId: USER_ID,
      entry: 'comicsCostEstimate',
      isApiCaller: false,
    });
    expect(mocks.getOrchestratorToken).not.toHaveBeenCalled();
  });

  it('iterateGenerate checks its source and reference urls', async () => {
    await expect(
      caller().iterateGenerate({
        projectId: 11,
        chapterPosition: 0,
        prompt: 'p',
        sourceImageUrl: SOURCE,
        sourceImageWidth: 512,
        sourceImageHeight: 512,
        userReferenceImages: [{ url: REF, width: 512, height: 512 }],
      })
    ).rejects.toBe(refused);
    expect(checkedUrls()).toEqual([[SOURCE, REF]]);
    expectNothingStarted();
  });

  it('generateComicImage checks its reference urls', async () => {
    await expect(
      caller().generateComicImage({
        prompt: 'p',
        userReferenceImages: [{ url: REF, width: 512, height: 512 }],
      })
    ).rejects.toBe(refused);
    expect(checkedUrls()).toEqual([[REF]]);
    expectNothingStarted();
  });

  it.each([
    ['a prompt', { prompt: 'make it a comic' }],
    ['forced generation', { forceGenerate: true }],
  ])('enhancePanel checks its source url when given %s', async (_, over) => {
    await expect(
      caller().enhancePanel({
        projectId: 11,
        chapterPosition: 0,
        sourceImageUrl: SOURCE,
        sourceImageWidth: 512,
        sourceImageHeight: 512,
        ...over,
      })
    ).rejects.toBe(refused);
    expect(checkedUrls()).toEqual([[SOURCE]]);
    expectNothingStarted();
  });

  it.each([
    ['no prompt', {}],
    ['a blank prompt', { prompt: '   ' }],
  ])('enhancePanel leaves a source saved with %s to the save checks', async (_, over) => {
    dbMock.dbWrite.comicPanel.findFirst.mockResolvedValue(null);
    await caller()
      .enhancePanel({
        projectId: 11,
        chapterPosition: 0,
        sourceImageUrl: SOURCE,
        sourceImageWidth: 512,
        sourceImageHeight: 512,
        ...over,
      })
      .catch(() => undefined);
    // Reached the save path, so the route did not stop before the check for another reason.
    expect(dbMock.dbWrite.comicPanel.findFirst).toHaveBeenCalled();
    expect(mocks.assertUsable).not.toHaveBeenCalled();
  });

  it('createPanel takes only a bundled layout image path', async () => {
    const input = { projectId: 11, chapterPosition: 0, prompt: 'p' };
    for (const layoutImagePath of ['@evil.example/x.png', '/../x.png', '//evil.example/x.png'])
      await expect(caller().createPanel({ ...input, layoutImagePath })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: expect.stringContaining('layoutImagePath'),
      });
    for (const { imagePath } of LAYOUT_OPTIONS)
      await expect(
        caller().createPanel({ ...input, layoutImagePath: imagePath })
      ).rejects.not.toMatchObject({ message: expect.stringContaining('layoutImagePath') });
  });

  it('bulkCreatePanels checks the source url of every panel it generates, and only those', async () => {
    await expect(
      caller().bulkCreatePanels({
        projectId: 11,
        chapterPosition: 0,
        panels: [
          { prompt: 'p', sourceImageUrl: SOURCE, sourceImageWidth: 512, sourceImageHeight: 512 },
          { sourceImageUrl: REF, sourceImageWidth: 512, sourceImageHeight: 512 },
          { prompt: '  ', sourceImageUrl: REF, sourceImageWidth: 512, sourceImageHeight: 512 },
          { prompt: 'text only' },
        ],
      })
    ).rejects.toBe(refused);
    expect(checkedUrls()).toEqual([[SOURCE]]);
    expectNothingStarted();
  });
});

describe('comics generation inputs the server loads', () => {
  beforeEach(() => {
    mocks.assertUsable.mockResolvedValue(undefined);
    dbMock.dbRead.comicPanel.findFirst.mockResolvedValue({ imageUrl: REF });
  });

  it.each([
    [
      'createPanel',
      () =>
        caller().createPanel({
          projectId: 11,
          chapterPosition: 0,
          prompt: 'p',
          referencePanelId: 3,
        }),
    ],
    [
      'enhancePanel',
      () =>
        caller().enhancePanel({
          projectId: 11,
          chapterPosition: 0,
          sourceImageUrl: SOURCE,
          sourceImageWidth: 512,
          sourceImageHeight: 512,
          prompt: 'p',
          referencePanelId: 3,
        }),
    ],
  ])('%s checks its reference panel image before it starts', async (_, run) => {
    mocks.assertStoredUnblocked.mockRejectedValueOnce(refused);
    await expect(run()).rejects.toBe(refused);
    expect(mocks.assertStoredUnblocked).toHaveBeenCalledExactlyOnceWith([REF]);
    // Only a panel in the caller's project is looked up.
    expect(dbMock.dbRead.comicPanel.findFirst).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ where: { id: 3, chapter: { projectId: 11 } } })
    );
    expectNothingStarted();
  });

  it("sends a reference's unblocked images and leaves out a blocked one", async () => {
    dbMock.dbRead.comicReference.findMany.mockResolvedValue([{ id: 5, name: 'A' }]);
    dbMock.dbRead.comicReference.findUnique.mockResolvedValue({
      name: 'A',
      images: [
        { image: { id: 1, url: REF, width: 512, height: 512, blockedFor: 'moderated' } },
        { image: { id: 2, url: SOURCE, width: 512, height: 512, blockedFor: null } },
      ],
    });
    mocks.submit.mockRejectedValue(new Error('stop'));
    await caller()
      .iterateGenerate({ projectId: 11, chapterPosition: 0, prompt: 'p', referenceIds: [5] })
      .catch(() => undefined);
    expect(mocks.submit).toHaveBeenCalledOnce();
    const sent = (mocks.submit.mock.calls[0][0] as { images: { url: string }[] }).images;
    expect(sent.map((i) => i.url)).toEqual([expect.stringContaining(SOURCE)]);
  });

  it.each([
    ['every image of one reference is blocked', 'moderated', true],
    ['CONTROL: the reference keeps an unblocked image', null, false],
  ] as const)('iterateGenerate tells the client when %s', async (_, blockedFor, skipped) => {
    dbMock.dbRead.comicReference.findMany.mockResolvedValue([
      { id: 5, name: 'A' },
      { id: 6, name: 'B' },
    ]);
    dbMock.dbRead.comicReference.findUnique.mockImplementation((async (args: {
      where: { id: number };
    }) =>
      args.where.id === 5
        ? { name: 'A', images: [{ image: { id: 1, url: REF, width: 1, height: 1, blockedFor } }] }
        : {
            name: 'B',
            images: [{ image: { id: 2, url: SOURCE, width: 1, height: 1, blockedFor: null } }],
          }) as never);
    mocks.submit.mockResolvedValue({ id: 'wf', cost: { total: 0 } });
    const result = await caller().iterateGenerate({
      projectId: 11,
      chapterPosition: 0,
      prompt: 'p',
      referenceIds: [5, 6],
    });
    expect(result.referenceImagesSkipped).toBe(skipped);
  });

  describe('the skipped-reference notice', () => {
    // Alpha's only image is blocked (or not, for the control); Beta always has a usable one.
    const givenRefs = (alphaBlocked: boolean) => {
      dbMock.dbRead.comicReference.findMany.mockResolvedValue([
        { id: 5, name: 'Alpha' },
        { id: 6, name: 'Beta' },
      ]);
      dbMock.dbRead.comicReference.findUnique.mockImplementation((async (args: {
        where: { id: number };
      }) => ({
        name: args.where.id === 5 ? 'Alpha' : 'Beta',
        images: [
          {
            image: {
              id: args.where.id,
              url: args.where.id === 5 ? REF : SOURCE,
              width: 1,
              height: 1,
              blockedFor: args.where.id === 5 && alphaBlocked ? 'moderated' : null,
            },
          },
        ],
      })) as never);
      mocks.assertUsable.mockResolvedValue(undefined);
      mocks.submit.mockResolvedValue({ id: 'wf', cost: { total: 0 } });
      dbMock.dbWrite.comicPanel.create.mockResolvedValue({ id: 1 } as never);
      dbMock.dbWrite.comicPanel.update.mockResolvedValue({ id: 1, status: 'Generating' } as never);
      dbMock.dbWrite.comicChapter.create.mockResolvedValue({ projectId: 11, position: 0 } as never);
      dbMock.dbRead.comicProjectReference.findMany.mockResolvedValue([
        { referenceId: 5 },
        { referenceId: 6 },
      ] as never);
    };
    const source = { sourceImageUrl: SOURCE, sourceImageWidth: 512, sourceImageHeight: 512 };
    const routes = [
      [
        'createPanel',
        (p: string) => caller().createPanel({ projectId: 11, chapterPosition: 0, prompt: p }),
      ],
      [
        'enhancePanel',
        (p: string) =>
          caller().enhancePanel({ projectId: 11, chapterPosition: 0, prompt: p, ...source }),
      ],
      [
        'smartCreateChapter',
        (p: string) =>
          caller().smartCreateChapter({
            projectId: 11,
            referenceIds: [5, 6],
            panels: [{ prompt: p }],
          }),
      ],
      [
        'bulkCreatePanels, prompt only',
        (p: string) =>
          caller().bulkCreatePanels({ projectId: 11, chapterPosition: 0, panels: [{ prompt: p }] }),
      ],
      [
        'bulkCreatePanels, source and prompt',
        (p: string) =>
          caller().bulkCreatePanels({
            projectId: 11,
            chapterPosition: 0,
            panels: [{ prompt: p, ...source }],
          }),
      ],
    ] as const;

    it.each(routes)('%s flags a mentioned reference with no usable image', async (_, run) => {
      givenRefs(true);
      expect((await run('@Alpha and @Beta')).referenceImagesSkipped).toBe(true);
    });

    it.each(routes)(
      'CONTROL: %s does not flag a usable or unmentioned reference',
      async (_, run) => {
        givenRefs(false);
        expect((await run('@Alpha and @Beta')).referenceImagesSkipped).toBe(false);
        givenRefs(true);
        expect((await run('@Beta only')).referenceImagesSkipped).toBe(false);
      }
    );
  });

  // The kill switch is applied inside `submitPresetImageGen` from the user it is handed: a free,
  // non-moderator caller must arrive as one, or a forced tier or moderator flag is a bypass.
  it('submits as the signed-in user, for the generation kill switch', async () => {
    dbMock.dbRead.comicReference.findMany.mockResolvedValue([]);
    mocks.submit.mockRejectedValue(new Error('stop'));
    await caller()
      .iterateGenerate({ projectId: 11, chapterPosition: 0, prompt: 'p' })
      .catch(() => undefined);
    expect(mocks.submit).toHaveBeenCalledOnce();
    const { user } = mocks.submit.mock.calls[0][0] as { user: { tier?: string } };
    expect(user).toMatchObject({ id: USER_ID, isModerator: false });
    expect(user.tier ?? 'free').toBe('free');
  });

  it("getGenerationCostEstimate reads only the caller's own references", async () => {
    mocks.assertInputs.mockResolvedValue(undefined);
    dbMock.dbRead.comicReference.findMany.mockResolvedValue([]);
    await caller()
      .getGenerationCostEstimate({ referenceIds: [5] })
      .catch(() => undefined);
    expect(dbMock.dbRead.comicReference.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: [5] }, userId: USER_ID } })
    );
    expect(dbMock.dbRead.comicReference.findUnique).not.toHaveBeenCalled();
  });
});

describe('stored reference images', () => {
  const REF_ID = 21;
  const refImage = (id: number, over: Record<string, unknown> = {}) => ({
    image: {
      id,
      url: `ref-${id}`,
      width: 512,
      height: 512,
      blockedFor: null,
      nsfwLevel: 1,
      ingestion: 'Scanned',
      ...over,
    },
  });
  const stored = (images: ReturnType<typeof refImage>[]) => {
    dbMock.dbRead.comicReference.findMany.mockResolvedValue([{ id: REF_ID, name: 'Ref' }] as never);
    dbMock.dbRead.comicReference.findUnique.mockResolvedValue({ name: 'Ref', images } as never);
  };
  const mixed = () => [
    refImage(1),
    refImage(2, { nsfwLevel: 32 }),
    refImage(3, { ingestion: 'Blocked' }),
    refImage(4, { blockedFor: 'moderated' }),
    // The owner gets no exception for their own marked image.
    refImage(5, { nsfwLevel: 32, userId: USER_ID }),
    refImage(6, { blockedFor: '' }),
    refImage(7, { blockedFor: 'AiNotVerified' }),
  ];

  const quotedRefIds = async () => {
    mocks.assertInputs.mockResolvedValue(undefined);
    await caller()
      .getGenerationCostEstimate({ referenceIds: [REF_ID] })
      .catch(() => undefined);
    const images = (mocks.whatIf.mock.calls[0][0] as { images: { url: string }[] | null }).images;
    return (images ?? []).map((i) => i.url);
  };

  const submittedRefUrls = async () => {
    mocks.assertInputs.mockResolvedValue(undefined);
    mocks.assertUsable.mockResolvedValue(undefined);
    dbMock.dbRead.comicChapter.findUnique.mockResolvedValue({
      project: { id: 11, userId: USER_ID, baseModel: null },
    } as never);
    dbMock.dbWrite.comicPanel.create.mockImplementation((async (args: { data: unknown }) => ({
      id: 1,
      ...(args.data as object),
    })) as never);
    await caller()
      .createPanel({ projectId: 11, chapterPosition: 0, prompt: 'p', referenceIds: [REF_ID] })
      .catch(() => undefined);
    const data = dbMock.dbWrite.comicPanel.create.mock.calls[0]?.[0] as
      | { data: { metadata: { referenceImages: { url: string }[] } } }
      | undefined;
    return (data?.data.metadata.referenceImages ?? []).map((i) => i.url);
  };

  it('quote and submit carry the same images', async () => {
    stored(mixed());
    const quoted = await quotedRefIds();
    const submitted = await submittedRefUrls();
    expect(quoted).toHaveLength(1);
    expect(quoted[0]).toContain('ref-1');
    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toContain('ref-1');
    // What reaches generation, not only what is stored.
    const sent = (mocks.submit.mock.calls[0]?.[0] as { images?: { url: string }[] })?.images;
    const refId = (url: string) => url.match(/ref-\d+/)?.[0];
    expect(sent?.map((i) => refId(i.url))).toEqual(quoted.map(refId));
  });

  it('quote and submit both refuse, before writing, when none are usable', async () => {
    stored(mixed().slice(1));
    mocks.assertInputs.mockResolvedValue(undefined);
    await expect(caller().getGenerationCostEstimate({ referenceIds: [REF_ID] })).rejects.toThrow(
      'References have no reference images'
    );
    expect(mocks.whatIf).not.toHaveBeenCalled();
    mocks.assertUsable.mockResolvedValue(undefined);
    await expect(
      caller().createPanel({
        projectId: 11,
        chapterPosition: 0,
        prompt: 'p',
        referenceIds: [REF_ID],
      })
    ).rejects.toThrow('References have no reference images');
    expect(dbMock.dbWrite.comicPanel.create).not.toHaveBeenCalled();
  });
});

describe('reference images a generation sends', () => {
  type Img = { id: number; marked?: boolean };
  const refs: Record<number, { name: string; images: Img[] }> = {
    5: { name: 'Alpha', images: [{ id: 51 }, { id: 52 }] },
    6: { name: 'Beta', images: [{ id: 61 }] },
  };
  const given = (marked: number[] = []) => {
    dbMock.dbRead.comicReference.findMany.mockResolvedValue(
      Object.entries(refs).map(([id, r]) => ({ id: Number(id), name: r.name })) as never
    );
    dbMock.dbRead.comicReference.findUnique.mockImplementation((async (args: {
      where: { id: number };
    }) => ({
      name: refs[args.where.id].name,
      images: refs[args.where.id].images.map(({ id }) => ({
        image: {
          id,
          url: `img-${id}`,
          width: 1,
          height: 1,
          blockedFor: marked.includes(id) ? 'moderated' : null,
          nsfwLevel: 1,
          ingestion: 'Scanned',
        },
      })),
    })) as never);
    dbMock.dbRead.comicProjectReference.findMany.mockResolvedValue([
      { referenceId: 5 },
      { referenceId: 6 },
    ] as never);
    mocks.assertUsable.mockResolvedValue(undefined);
    mocks.assertInputs.mockResolvedValue(undefined);
    mocks.submit.mockResolvedValue({ id: 'wf', cost: { total: 0 } });
    dbMock.dbWrite.comicPanel.create.mockResolvedValue({ id: 1 } as never);
    dbMock.dbWrite.comicPanel.update.mockResolvedValue({ id: 1, status: 'Generating' } as never);
    dbMock.dbWrite.comicChapter.create.mockResolvedValue({ projectId: 11, position: 0 } as never);
  };
  const source = { sourceImageUrl: SOURCE, sourceImageWidth: 512, sourceImageHeight: 512 };
  const ids = (images: { url: string }[] | null | undefined) =>
    (images ?? []).flatMap((i) => i.url.match(/img-(\d+)/)?.[1] ?? []).map(Number);
  const submittedIds = () =>
    ids((mocks.submit.mock.calls[0]?.[0] as { images?: { url: string }[] } | undefined)?.images);
  const quotedIds = () => ids(mocks.whatIf.mock.calls[0]?.[0].images);

  /** The four routes that take a reference selection, each returning the ids it sent. */
  const selecting = [
    [
      'getGenerationCostEstimate',
      async (selectedImageIds?: number[]) => {
        await caller()
          .getGenerationCostEstimate({ referenceIds: [5, 6], selectedImageIds })
          .catch(() => undefined);
        return quotedIds();
      },
    ],
    [
      'createPanel',
      async (selectedImageIds?: number[]) => {
        await caller()
          .createPanel({
            projectId: 11,
            chapterPosition: 0,
            prompt: 'p',
            referenceIds: [5, 6],
            selectedImageIds,
          })
          .catch(() => undefined);
        return submittedIds();
      },
    ],
    [
      'iterateGenerate',
      async (selectedImageIds?: number[]) => {
        await caller()
          .iterateGenerate({
            projectId: 11,
            chapterPosition: 0,
            prompt: 'p',
            referenceIds: [5, 6],
            selectedImageIds,
          })
          .catch(() => undefined);
        return submittedIds();
      },
    ],
    [
      'enhancePanel',
      async (selectedImageIds?: number[]) => {
        await caller()
          .enhancePanel({
            projectId: 11,
            chapterPosition: 0,
            prompt: 'p',
            referenceIds: [5, 6],
            selectedImageIds,
            ...source,
          })
          .catch(() => undefined);
        return submittedIds();
      },
    ],
  ] as const;

  it.each(selecting)('%s sends every image of every reference, in order', async (_, run) => {
    given();
    expect(await run()).toEqual([51, 52, 61]);
  });

  it.each(selecting)('%s sends the selected images in reference order', async (_, run) => {
    given();
    expect(await run([61, 51])).toEqual([51, 61]);
  });

  it.each(selecting)('%s leaves out a marked image and keeps the rest', async (_, run) => {
    given([52]);
    expect(await run()).toEqual([51, 61]);
  });

  it.each(selecting)(
    '%s refuses before any write or charge when no selected image is left',
    async (_, run) => {
      given([52]);
      expect(await run([52])).toEqual([]);
      expect(mocks.whatIf).not.toHaveBeenCalled();
      expect(mocks.submit).not.toHaveBeenCalled();
      expect(dbMock.dbWrite.comicPanel.updateMany).not.toHaveBeenCalled();
      expect(dbMock.dbWrite.comicPanel.create).not.toHaveBeenCalled();
    }
  );

  it('reads the fields the marker check needs', async () => {
    given();
    await selecting[1][1]();
    expect(dbMock.dbRead.comicReference.findUnique.mock.calls[0][0]).toMatchObject({
      select: {
        images: {
          include: { image: { select: { blockedFor: true, nsfwLevel: true, ingestion: true } } },
        },
      },
    });
  });

  it('refuses a regenerate at a position before shifting any panel', async () => {
    given([51, 52, 61]);
    await expect(
      caller().createPanel({
        projectId: 11,
        chapterPosition: 0,
        prompt: 'p',
        referenceIds: [5],
        position: 2,
      })
    ).rejects.toThrow('References have no reference images');
    await expect(
      caller().enhancePanel({
        projectId: 11,
        chapterPosition: 0,
        prompt: 'p',
        referenceIds: [5],
        position: 2,
        ...source,
      })
    ).rejects.toThrow('References have no reference images');
    expect(dbMock.dbWrite.comicPanel.updateMany).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.comicPanel.create).not.toHaveBeenCalled();
  });

  describe('the skipped notice, after selection', () => {
    const create = (selectedImageIds?: number[]) =>
      caller().createPanel({
        projectId: 11,
        chapterPosition: 0,
        prompt: 'p',
        referenceIds: [5, 6],
        selectedImageIds,
      });

    it('is raised when a selected image is left out', async () => {
      given([52]);
      expect((await create([51, 52])).referenceImagesSkipped).toBe(true);
    });

    it('is not raised when only unselected images are marked', async () => {
      given([52]);
      expect((await create([51])).referenceImagesSkipped).toBe(false);
    });

    it('is not raised for a partly marked reference with no selection', async () => {
      given([52]);
      expect((await create()).referenceImagesSkipped).toBe(false);
    });
  });

  describe('routes that send mentioned references', () => {
    const mentioning = [
      [
        'smartCreateChapter',
        () =>
          caller().smartCreateChapter({
            projectId: 11,
            referenceIds: [5, 6],
            panels: [{ prompt: '@Beta' }, { prompt: '@Alpha' }],
          }),
      ],
      [
        'bulkCreatePanels, prompt only',
        () =>
          caller().bulkCreatePanels({
            projectId: 11,
            chapterPosition: 0,
            panels: [{ prompt: '@Beta' }, { prompt: '@Alpha' }],
          }),
      ],
      [
        'bulkCreatePanels, source and prompt',
        () =>
          caller().bulkCreatePanels({
            projectId: 11,
            chapterPosition: 0,
            panels: [
              { prompt: '@Beta', ...source },
              { prompt: '@Alpha', ...source },
            ],
          }),
      ],
    ] as const;

    it.each(mentioning)(
      '%s refuses before writing anything when a panel has no mentioned image left',
      async (_, run) => {
        given([51, 52]);
        await expect(run()).rejects.toThrow('References have no reference images');
        expect(dbMock.dbWrite.comicChapter.create).not.toHaveBeenCalled();
        expect(dbMock.dbWrite.comicPanel.create).not.toHaveBeenCalled();
        expect(mocks.submit).not.toHaveBeenCalled();
      }
    );

    it.each(mentioning)('CONTROL: %s runs when every panel has an image left', async (_, run) => {
      given([52]);
      await run();
      expect(
        dbMock.dbWrite.comicChapter.create.mock.calls.length +
          dbMock.dbWrite.comicPanel.create.mock.calls.length
      ).toBeGreaterThan(0);
    });
  });
});
