import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { NsfwLevel } from '~/server/common/enums';

const { applyImageCaptionTextScan } = await import(
  '~/server/services/text-scan/actions/image-caption'
);
const { imageCaptionTextScanSubject } = await import(
  '~/server/services/text-scan/profiles/image-caption.profile'
);
const { textScanTextHash } = await import('~/server/services/text-scan/prompt');
const { getModerationAdapter } = await import('~/server/services/moderation-adapters');

const w = dbMock.dbWrite;
const ID = 21;
const CAPTION = { userId: 3, content: 'A robot learns to talk.', nsfwLevel: 0 };
const HASH = textScanTextHash(imageCaptionTextScanSubject(CAPTION));

type Verdict = { nsfw?: number; poi?: boolean; minor?: boolean };
const args = (v: Verdict, textHash = HASH) => ({
  entityId: ID,
  workflowId: 'wf-1',
  textHash,
  subject: { fields: [], declared: {} },
  outcome: {
    triggeredLabels: [],
    nsfwLevel: v.nsfw ?? null,
    ...(v.nsfw !== undefined && {
      nsfw: { detectedLevel: v.nsfw, declaredLevel: 0, raised: v.nsfw > 1, reason: 'r' },
    }),
    ...(v.poi !== undefined && {
      poi: { detected: v.poi, declared: false, newlyDetected: v.poi, names: [], reason: 'r' },
    }),
    ...(v.minor !== undefined && {
      minor: { detected: v.minor, declared: false, newlyDetected: v.minor, reason: 'r' },
    }),
  },
});

const writes = () => w.imageCaption.updateMany.mock.calls.map(([call]) => call);
const refusal = () => writes().find((call) => 'refused' in (call?.data ?? {}));

describe('applyImageCaptionTextScan', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    w.imageCaption.findUnique.mockResolvedValue(CAPTION as never);
    w.imageCaption.updateMany.mockResolvedValue({ count: 1 } as never);
  });

  it('is the adapter registered for ImageCaption verdicts', () => {
    expect(getModerationAdapter('ImageCaption')?.applyTextScan).toBe(applyImageCaptionTextScan);
  });

  it.each([
    ['a real person', { nsfw: NsfwLevel.PG, poi: true, minor: false }],
    ['a minor in R text', { nsfw: NsfwLevel.R, poi: false, minor: true }],
    ['a minor with no rating answered', { poi: false, minor: true }],
  ])('refuses %s', async (_, verdict) => {
    await applyImageCaptionTextScan(args(verdict) as never);
    expect(refusal()).toEqual({ where: { imageId: ID, refused: false }, data: { refused: true } });
  });

  it('refuses on a stale verdict too: restricting needs no current text', async () => {
    await applyImageCaptionTextScan(args({ poi: true, minor: false }, 'old-hash') as never);
    expect(refusal()?.data).toEqual({ refused: true });
  });

  it('leaves a minor in PG13 text shown', async () => {
    await applyImageCaptionTextScan(
      args({ nsfw: NsfwLevel.PG13, poi: false, minor: true }) as never
    );
    expect(refusal()?.data).not.toEqual({ refused: true });
  });

  it('lets a refused caption back on a clean verdict of its current text only', async () => {
    await applyImageCaptionTextScan(
      args({ nsfw: NsfwLevel.PG, poi: false, minor: false }) as never
    );
    expect(refusal()).toEqual({
      where: { imageId: ID, content: CAPTION.content, refused: true },
      data: { refused: false },
    });

    w.imageCaption.updateMany.mockClear();
    await applyImageCaptionTextScan(
      args({ nsfw: NsfwLevel.PG, poi: false, minor: false }, 'old-hash') as never
    );
    expect(refusal()).toBeUndefined();
  });

  it.each([
    ['the minor label', { nsfw: NsfwLevel.PG, poi: false }],
    ['the person label', { nsfw: NsfwLevel.PG, minor: false }],
  ])('keeps a caption refused when %s went unanswered', async (_, verdict) => {
    await applyImageCaptionTextScan(args(verdict) as never);
    expect(refusal()).toBeUndefined();
  });

  it('records the rating, and a stale verdict may only raise it', async () => {
    await applyImageCaptionTextScan(args({ nsfw: NsfwLevel.R }) as never);
    expect(writes()).toContainEqual({
      where: { imageId: ID, nsfwLevel: { lt: NsfwLevel.R } },
      data: { nsfwLevel: NsfwLevel.R },
    });

    w.imageCaption.updateMany.mockClear();
    w.imageCaption.findUnique.mockResolvedValue({ ...CAPTION, nsfwLevel: NsfwLevel.R } as never);
    await applyImageCaptionTextScan(args({ nsfw: NsfwLevel.PG }, 'old-hash') as never);
    expect(writes()).toEqual([]);
  });

  it('does nothing once the caption is gone', async () => {
    w.imageCaption.findUnique.mockResolvedValue(null as never);
    await applyImageCaptionTextScan(args({ poi: true }) as never);
    expect(w.imageCaption.updateMany).not.toHaveBeenCalled();
  });
});
