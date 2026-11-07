import sharp from 'sharp';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as BlockImageUpload from '~/server/services/blocks/block-image-upload.service';
import type * as InputUrls from '~/server/services/generation-input-urls';
import type * as ImageUploadAction from '~/server/services/image-upload-action.service';
import type * as OrchestrationNew from '~/server/services/orchestrator/orchestration-new.service';
import type * as Workflows from '~/server/services/orchestrator/workflows';

const h = vi.hoisted(() => ({
  generateFromGraph: vi.fn(async () => ({ id: 'wf-1', cost: { total: 40 } })),
  whatIfFromGraph: vi.fn(async () => ({ cost: { total: 40 }, ready: true })),
  workflow: undefined as unknown,
  takeBytes: Buffer.alloc(0) as Buffer,
}));

vi.mock('~/server/services/orchestrator/orchestration-new.service', async (importOriginal) => ({
  ...(await importOriginal<typeof OrchestrationNew>()),
  buildGenerationContext: vi.fn(async () => ({ externalCtx: {}, status: {} })),
  generateFromGraph: h.generateFromGraph,
  whatIfFromGraph: h.whatIfFromGraph,
  bustQueriedWorkflowsCache: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/orchestrator/workflows', async (importOriginal) => ({
  ...(await importOriginal<typeof Workflows>()),
  getWorkflow: vi.fn(async () => h.workflow),
}));
vi.mock('~/server/services/image-upload-action.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageUploadAction>()),
  recordMintedUploadKey: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/generation-input-urls', async (importOriginal) => ({
  ...(await importOriginal<typeof InputUrls>()),
  assertGenerationInputsUsable: vi.fn(async () => undefined),
}));
// The fetch and the store upload are the network; the transform and the measuring are real.
vi.mock('~/server/services/blocks/block-image-upload.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BlockImageUpload>()),
  stageGenerationOutputImage: vi.fn(
    async ({ transform }: { transform?: (bytes: Buffer) => Promise<Buffer> }) => {
      const bytes = transform ? await transform(h.takeBytes) : h.takeBytes;
      const { width, height } = await sharp(bytes).metadata();
      return { url: '00000000-0000-4000-8000-000000000000', mimeType: 'image/png', width, height };
    }
  ),
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import {
  keepArticleReframe,
  quoteArticleReframe,
  submitArticleReframe,
} from '~/server/services/article-reframe.service';
import { stageGenerationOutputImage } from '~/server/services/blocks/block-image-upload.service';
import { recordMintedUploadKey } from '~/server/services/image-upload-action.service';
import { getWorkflow } from '~/server/services/orchestrator/workflows';
import type { RemixAppCaller } from '~/server/services/remix-app.service';
import {
  centreCropBox,
  getReframeRefusal,
  MATURE_BANNER_REFUSAL,
  UNRATED_BANNER_REFUSAL,
} from '~/shared/utils/article-reframe';
import { REMIX_ENGINES } from '~/shared/constants/remix.constants';

const USER_ID = 7;
const caller = {
  user: { id: USER_ID, showNsfw: false, tier: 'free' },
  token: 'token',
  features: {},
  isGreenDomain: false,
  isApiCaller: false,
} as unknown as RemixAppCaller;

const source = {
  id: 11,
  url: 'c0ffee00-0000-4000-8000-000000000000',
  type: 'image',
  nsfwLevel: 1,
  width: 850,
  height: 400,
  ingestion: 'Scanned',
  blockedFor: null,
  minor: false,
  poi: false,
};

const png = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: '#336699' } })
    .png()
    .toBuffer();

const succeeded = (
  tag: string,
  { nsfwLevel = 'pG' as string | null, status = 'succeeded' } = {}
) => ({
  id: 'wf-1',
  status,
  tags: ['article-reframe', tag],
  steps: [
    {
      $type: 'imageGen',
      output: {
        images: [{ id: 'b1', url: 'https://orchestration.civitai.com/b1', nsfwLevel }],
      },
    },
  ],
});

/** Every write the article and its images could take before the author saves. */
function attachWrites() {
  return [
    dbMock.dbWrite.image.create,
    dbMock.dbWrite.image.createMany,
    dbMock.dbWrite.image.update,
    dbMock.dbWrite.article.update,
    dbMock.dbWrite.article.upsert,
    dbMock.dbWrite.$executeRaw,
    dbMock.dbWrite.$executeRawUnsafe,
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.image.findFirst.mockResolvedValue(source as never);
});

describe('centreCropBox', () => {
  it('trims a 21:9 take to a centred 4:1 banner that clears 2400x600', () => {
    expect(centreCropBox(2520, 1080, 4)).toEqual({ left: 0, top: 225, width: 2520, height: 630 });
  });

  it('trims the sides of a take wider than the cover shape', () => {
    expect(centreCropBox(3000, 1000, 850 / 400)).toEqual({
      left: 437,
      top: 0,
      width: 2125,
      height: 1000,
    });
  });
});

describe('keepArticleReframe', () => {
  it('stores the take cropped to 4:1 for a banner', async () => {
    h.takeBytes = await png(2520, 1080);
    h.workflow = succeeded('article-reframe:banner');
    const kept = await keepArticleReframe({ workflowId: 'wf-1', target: 'banner', caller });
    expect({ width: kept.width, height: kept.height }).toEqual({ width: 2520, height: 630 });
  });

  it('records the stored key as issued to the author, so the article save accepts it', async () => {
    h.takeBytes = await png(2520, 1080);
    h.workflow = succeeded('article-reframe:banner');
    const kept = await keepArticleReframe({ workflowId: 'wf-1', target: 'banner', caller });
    expect(vi.mocked(recordMintedUploadKey)).toHaveBeenCalledWith(
      kept.url,
      caller.user.id,
      undefined
    );
  });

  it("reads the take with the author's own orchestrator token", async () => {
    h.takeBytes = await png(2520, 1080);
    h.workflow = succeeded('article-reframe:banner');
    await keepArticleReframe({ workflowId: 'wf-1', target: 'banner', caller });
    expect(vi.mocked(getWorkflow)).toHaveBeenCalledWith(
      expect.objectContaining({ token: caller.token, path: { workflowId: 'wf-1' } })
    );
  });

  it('refuses a workflow that is not a take for this target', async () => {
    h.workflow = succeeded('article-reframe:cover');
    await expect(
      keepArticleReframe({ workflowId: 'wf-1', target: 'banner', caller })
    ).rejects.toThrow('Take not found');
  });
});

describe('nothing is attached before Keep', () => {
  it('a paid take writes no image and touches no article', async () => {
    const { workflowId } = await submitArticleReframe({
      imageId: source.id,
      target: 'banner',
      quote: 40,
      nonce: 'nonce-0001',
      caller,
    });
    expect(workflowId).toBe('wf-1');
    expect(h.generateFromGraph).toHaveBeenCalledOnce();
    for (const write of attachWrites()) expect(write).not.toHaveBeenCalled();
  });

  it('Keep returns an upload-shaped image with no row, for the article save to create and scan', async () => {
    h.takeBytes = await png(1920, 1080);
    h.workflow = succeeded('article-reframe:cover');
    const kept = await keepArticleReframe({ workflowId: 'wf-1', target: 'cover', caller });
    expect(kept).not.toHaveProperty('id');
    // 1920x1080 trimmed top and bottom to 850:400.
    expect(kept).toMatchObject({ url: expect.any(String), width: 1920, height: 904 });
    for (const write of attachWrites()) expect(write).not.toHaveBeenCalled();
  });

  it('refuses a take that now costs more than the author was shown, before it charges', async () => {
    await expect(
      submitArticleReframe({
        imageId: source.id,
        target: 'banner',
        quote: 39,
        nonce: 'nonce-0002',
        caller,
      })
    ).rejects.toThrow('price changed');
    expect(h.generateFromGraph).not.toHaveBeenCalled();
  });
});

const engineOf = (call: unknown[] | undefined) =>
  (call?.[0] as { input: { model: { id: number } } }).input.model.id;

describe('mature sources', () => {
  const mature = { ...source, nsfwLevel: 8 };
  const shownMature = { ...caller, user: { ...caller.user, showNsfw: true } } as RemixAppCaller;

  it('refuses a banner before it prices or charges', async () => {
    dbMock.dbWrite.image.findFirst.mockResolvedValue(mature as never);
    await expect(
      submitArticleReframe({
        imageId: 11,
        target: 'banner',
        quote: 40,
        nonce: 'nonce-0003',
        caller: shownMature,
      })
    ).rejects.toThrow(MATURE_BANNER_REFUSAL);
    expect(h.whatIfFromGraph).not.toHaveBeenCalled();
    expect(h.generateFromGraph).not.toHaveBeenCalled();
  });

  it('still makes a cover, on the mature engine', async () => {
    dbMock.dbWrite.image.findFirst.mockResolvedValue(mature as never);
    await submitArticleReframe({
      imageId: 11,
      target: 'cover',
      quote: 40,
      nonce: 'nonce-0004',
      caller: shownMature,
    });
    expect(engineOf(h.generateFromGraph.mock.calls[0])).toBe(
      REMIX_ENGINES.edit.mature.modelVersionId
    );
  });

  it('a safe source makes its cover on the safe engine', async () => {
    await submitArticleReframe({
      imageId: 11,
      target: 'cover',
      quote: 40,
      nonce: 'nonce-0005',
      caller,
    });
    expect(engineOf(h.generateFromGraph.mock.calls[0])).toBe(
      REMIX_ENGINES.edit.safe.modelVersionId
    );
  });
});

describe('Keep fails closed on the take', () => {
  const stage = () => vi.mocked(stageGenerationOutputImage);
  const asViewer = (user: { showNsfw: boolean }, isGreenDomain = false) =>
    ({ ...caller, isGreenDomain, user: { ...caller.user, ...user } } as RemixAppCaller);

  beforeEach(async () => {
    h.takeBytes = await png(2520, 1080);
  });

  it('refuses a take not rated yet', async () => {
    h.workflow = succeeded('article-reframe:banner', { nsfwLevel: null });
    await expect(
      keepArticleReframe({ workflowId: 'wf-1', target: 'banner', caller })
    ).rejects.toThrow('still being checked');
    expect(stage()).not.toHaveBeenCalled();
  });

  it('refuses a mature take to a viewer with mature content off', async () => {
    h.workflow = succeeded('article-reframe:cover', { nsfwLevel: 'x' });
    await expect(
      keepArticleReframe({
        workflowId: 'wf-1',
        target: 'cover',
        caller: asViewer({ showNsfw: false }),
      })
    ).rejects.toThrow('cannot be used here');
    expect(stage()).not.toHaveBeenCalled();
  });

  it('refuses a mature take on the green domain, even to a viewer shown mature content', async () => {
    h.workflow = succeeded('article-reframe:cover', { nsfwLevel: 'x' });
    await expect(
      keepArticleReframe({
        workflowId: 'wf-1',
        target: 'cover',
        caller: asViewer({ showNsfw: true }, true),
      })
    ).rejects.toThrow('cannot be used here');
    expect(stage()).not.toHaveBeenCalled();
  });

  it('keeps a mature take for a viewer shown mature content', async () => {
    h.workflow = succeeded('article-reframe:cover', { nsfwLevel: 'x' });
    await keepArticleReframe({
      workflowId: 'wf-1',
      target: 'cover',
      caller: asViewer({ showNsfw: true }),
    });
    expect(stage()).toHaveBeenCalledOnce();
  });

  it('refuses a take still processing', async () => {
    h.workflow = succeeded('article-reframe:banner', { status: 'processing' });
    await expect(
      keepArticleReframe({ workflowId: 'wf-1', target: 'banner', caller })
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(stage()).not.toHaveBeenCalled();
  });
});

describe("the source must be the author's own image", () => {
  it("looks the image up by id and the caller's own user id", async () => {
    await submitArticleReframe({
      imageId: source.id,
      target: 'cover',
      quote: 40,
      nonce: 'nonce-0006',
      caller,
    });
    expect(dbMock.dbWrite.image.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: source.id, userId: USER_ID } })
    );
  });

  it("refuses an image that is not the author's before it prices or charges", async () => {
    dbMock.dbWrite.image.findFirst.mockResolvedValue(null as never);
    await expect(
      submitArticleReframe({ imageId: 99, target: 'cover', quote: 40, nonce: 'nonce-0007', caller })
    ).rejects.toThrow('Image not found');
    await expect(quoteArticleReframe({ imageId: 99, target: 'cover', caller })).rejects.toThrow(
      'Image not found'
    );
    expect(h.whatIfFromGraph).not.toHaveBeenCalled();
    expect(h.generateFromGraph).not.toHaveBeenCalled();
  });
});

describe('Keep never takes an output the take did not deliver', () => {
  const withOutput = (image: Record<string, unknown>) => ({
    ...succeeded('article-reframe:banner'),
    steps: [{ $type: 'imageGen', output: { images: [image] } }],
  });

  it.each([
    ['a blocked output', { blockedReason: 'Moderated' }],
    ['an output no longer available', { available: false }],
  ])('refuses %s', async (_label, extra) => {
    h.workflow = withOutput({
      id: 'b1',
      url: 'https://orchestration.civitai.com/b1',
      nsfwLevel: 'pG',
      ...extra,
    });
    await expect(
      keepArticleReframe({ workflowId: 'wf-1', target: 'banner', caller })
    ).rejects.toThrow('no image to keep');
    expect(vi.mocked(stageGenerationOutputImage)).not.toHaveBeenCalled();
  });
});

describe('getReframeRefusal', () => {
  it('does not offer a banner from an image with no rating yet', () => {
    expect(getReframeRefusal('banner', { nsfwLevel: undefined })).toBe(UNRATED_BANNER_REFUSAL);
    expect(getReframeRefusal('banner', { nsfwLevel: 1 })).toBeUndefined();
    expect(getReframeRefusal('cover', { nsfwLevel: undefined })).toBeUndefined();
  });
});
