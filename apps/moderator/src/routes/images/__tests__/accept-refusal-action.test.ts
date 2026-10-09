import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ImageModeration from '$lib/server/image-moderation.service';

/**
 * An accept refused for an image removed with only its review flag left must reach the moderator as a
 * refusal, and must not move the report it was posted with: the report would read as reviewed and
 * cleared while the image never changed.
 */

const { acceptImage, setReportStatus } = vi.hoisted(() => ({
  acceptImage: vi.fn(),
  setReportStatus: vi.fn(),
}));

vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
// Pulls in `$app/server`, which only resolves inside a SvelteKit build.
vi.mock('$lib/server/user-actions.service', () => ({ setImageFlag: vi.fn() }));
vi.mock('$lib/server/reports.service', () => ({ setReportStatus }));
vi.mock('$lib/server/image-moderation.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageModeration>()),
  acceptImage,
  sendBulkAppealEmails: vi.fn(async () => undefined),
}));

const { FlagOnlyRemovedError } = await import('$lib/server/image-moderation.service');
const { actions } = await import('../[slug]/+page.server');

const request = (fields: Record<string, string>) =>
  ({
    formData: async () => {
      const form = new FormData();
      for (const [k, v] of Object.entries(fields)) form.set(k, v);
      return form;
    },
  } as never);

const event = (fields: Record<string, string>) =>
  ({
    request: request(fields),
    locals: { user: { id: 7 } },
    params: { slug: 'reported' },
  } as never);

const REFUSED = 52;
const ACCEPTABLE = 53;

beforeEach(() => {
  vi.resetAllMocks();
  acceptImage.mockImplementation(async ({ imageId }: { imageId: number }) => {
    if (imageId === REFUSED) throw new FlagOnlyRemovedError(imageId);
    return undefined;
  });
});

describe('accept', () => {
  it('refuses, and leaves the posted report alone', async () => {
    const result = await actions.accept(event({ imageId: String(REFUSED), reportId: '9' }));

    expect(result).toMatchObject({ status: 409 });
    expect(setReportStatus).not.toHaveBeenCalled();
  });

  it('still moves the report for an image it accepts', async () => {
    const result = await actions.accept(event({ imageId: String(ACCEPTABLE), reportId: '9' }));

    expect(result).toEqual({ success: true, imageId: ACCEPTABLE });
    expect(setReportStatus).toHaveBeenCalledTimes(1);
  });
});

describe('accept', () => {
  it('lets any other failure through rather than reporting it as a refusal', async () => {
    acceptImage.mockRejectedValue(new Error('connection lost'));

    await expect(actions.accept(event({ imageId: String(ACCEPTABLE) }))).rejects.toThrow(
      'connection lost'
    );
  });
});

describe('bulkAccept', () => {
  it('accepts a batch with nothing refused and moves every posted report', async () => {
    const result = await actions.bulkAccept(
      event({ imageIds: `${ACCEPTABLE}`, reportIds: '9,10' })
    );

    expect(result).toEqual({ success: true });
    expect(setReportStatus).toHaveBeenCalledTimes(2);
  });

  it('lets any other failure through rather than reporting it as a refusal', async () => {
    acceptImage.mockRejectedValue(new Error('connection lost'));

    await expect(
      actions.bulkAccept(event({ imageIds: `${ACCEPTABLE}`, reportIds: '' }))
    ).rejects.toThrow('connection lost');
  });

  it('names the refused images, accepts the rest, and moves no report', async () => {
    const result = await actions.bulkAccept(
      event({ imageIds: `${ACCEPTABLE},${REFUSED}`, reportIds: '9,10' })
    );

    expect(result).toMatchObject({ status: 409 });
    expect(JSON.stringify(result)).toContain(`): ${REFUSED}.`);
    expect(JSON.stringify(result)).toContain('No report was moved.');
    expect(acceptImage).toHaveBeenCalledTimes(2);
    expect(setReportStatus).not.toHaveBeenCalled();
  });
});
