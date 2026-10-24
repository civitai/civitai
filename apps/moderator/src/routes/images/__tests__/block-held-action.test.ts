import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ImageModeration from '$lib/server/image-moderation.service';

/**
 * A removal held for a second moderator (the image's approved appeal overturned the same reason)
 * leaves the image up, so its reports must stay open and the moderator must be told why.
 */

const { blockImage, setReportStatus, imageReports } = vi.hoisted(() => ({
  blockImage: vi.fn(),
  setReportStatus: vi.fn(),
  imageReports: { rows: [] as { imageId: number; reportId: number }[] },
}));

const chain = {
  select: () => chain,
  where: () => chain,
  execute: async () => imageReports.rows,
};
vi.mock('$lib/server/db', () => ({ dbRead: { selectFrom: () => chain }, dbWrite: {} }));
// Pulls in `$app/server`, which only resolves inside a SvelteKit build.
vi.mock('$lib/server/user-actions.service', () => ({ setImageFlag: vi.fn() }));
vi.mock('$lib/server/reports.service', () => ({ setReportStatus }));
vi.mock('$lib/server/image-moderation.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageModeration>()),
  blockImage,
}));

const { actions } = await import('../[slug]/+page.server');

const event = (fields: Record<string, string>, grants: Record<string, boolean> = {}) =>
  ({
    request: {
      formData: async () => {
        const form = new FormData();
        for (const [k, v] of Object.entries(fields)) form.set(k, v);
        return form;
      },
      headers: new Headers(),
    },
    locals: { user: { id: 7 }, grants },
    params: { slug: 'reported' },
    getClientAddress: () => '1.2.3.4',
  } as never);

const HELD = 52;
const REMOVED = 53;
const held = (imageId: number) => ({
  imageId,
  confirmationId: 1,
  created: true,
  appeal: { approvedAt: new Date('2026-10-14T16:59:45Z'), approvedByUsername: 'appr' },
});

beforeEach(() => {
  vi.resetAllMocks();
  imageReports.rows = [
    { imageId: HELD, reportId: 90 },
    { imageId: REMOVED, reportId: 91 },
  ];
  blockImage.mockImplementation(async ({ imageId }: { imageId: number }) =>
    imageId === HELD ? { held: held(imageId) } : {}
  );
  setReportStatus.mockResolvedValue({ ok: true, changed: true });
});

describe('block', () => {
  it('leaves the report open and says the removal was held', async () => {
    const result = await actions.block(event({ imageId: String(HELD), reportId: '90' }));

    expect(result).toMatchObject({
      success: true,
      imageId: HELD,
      held: expect.stringContaining('second moderator must confirm'),
    });
    expect(blockImage).toHaveBeenCalledWith(
      expect.objectContaining({ imageId: HELD, reportIds: [90], skipAppealCheck: false })
    );
    expect(setReportStatus).not.toHaveBeenCalled();
  });

  it('skips the hold for a moderator who may confirm re-removals', async () => {
    await actions.block(
      event({ imageId: String(REMOVED), reportId: '91' }, { 'image.removal.confirm': true })
    );
    expect(blockImage).toHaveBeenCalledWith(expect.objectContaining({ skipAppealCheck: true }));
    expect(setReportStatus).toHaveBeenCalledWith(expect.objectContaining({ id: 91 }));
  });
});

describe('bulkBlock', () => {
  it("actions only the removed images' reports and names the held ones", async () => {
    const result = await actions.bulkBlock(
      event({ imageIds: `${HELD},${REMOVED}`, reportIds: '90,91' })
    );

    expect(result).toMatchObject({ success: true, heldImageIds: [HELD] });
    expect(blockImage).toHaveBeenCalledWith(
      expect.objectContaining({ imageId: HELD, reportIds: [90] })
    );
    expect(setReportStatus.mock.calls.map(([a]) => (a as { id: number }).id)).toEqual([91]);
  });
});
