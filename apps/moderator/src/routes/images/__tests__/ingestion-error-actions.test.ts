import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MISSING_MEDIA_PUBLISH_MESSAGE, MissingMediaError } from '@civitai/shared';

/**
 * The two page actions behind the ingestion-error split.
 *
 * The refusal message is USER-FACING: the guard throws it deep in the service, and the only thing
 * that makes a moderator ever see it is this action turning the error into `fail(400, { error })`.
 * A guard whose message never reaches the screen leaves the moderator staring at a generic failure
 * and re-clicking, which is how the original defect stayed invisible.
 */

const resolveIngestionError = vi.fn();
const getIngestionErrorImages = vi.fn(async () => ({ items: [] }));
const getMissingMediaImages = vi.fn(async () => ({ items: [] }));
const deleteImagesByIds = vi.fn();

vi.mock('$lib/server/ingestion.service', () => ({
  resolveIngestionError,
  getIngestionErrorImages,
  getMissingMediaImages,
}));
vi.mock('$lib/server/image-deletion', () => ({ deleteImagesByIds }));

const { actions: errorActions } = await import('../ingestion-errors/+page.server');
const { actions: missingActions } = await import('../missing-media/+page.server');

const request = (fields: Record<string, string>) =>
  ({
    formData: async () => {
      const form = new FormData();
      for (const [k, v] of Object.entries(fields)) form.set(k, v);
      return form;
    },
  } as never);

const locals = { user: { id: 7 } } as never;

beforeEach(() => vi.clearAllMocks());

describe('ingestion-errors resolve action', () => {
  it('renders the missing-media refusal to the moderator as a 400 carrying the message', async () => {
    resolveIngestionError.mockRejectedValue(new MissingMediaError());

    const result = (await errorActions.resolve({
      request: request({ id: '4242', nsfwLevel: '1' }),
      locals,
    } as never)) as { status: number; data: { error: string } };

    expect(result.status).toBe(400);
    expect(result.data.error).toBe(MISSING_MEDIA_PUBLISH_MESSAGE);
  });

  it('still reports success for an image the guard allowed', async () => {
    resolveIngestionError.mockResolvedValue(undefined);

    const result = await errorActions.resolve({
      request: request({ id: '4242', nsfwLevel: '1' }),
      locals,
    } as never);

    expect(result).toEqual({ success: true, id: 4242, nsfwLevel: 1 });
  });
});

describe('missing-media delete action', () => {
  it('deletes exactly the image it was given', async () => {
    deleteImagesByIds.mockResolvedValue(undefined);

    const result = await missingActions.delete({
      request: request({ id: '4242' }),
      locals,
    } as never);

    expect(deleteImagesByIds).toHaveBeenCalledWith([4242]);
    expect(result).toEqual({ success: true, id: 4242 });
  });

  it('offers no way to publish — resolve is not an action on this page', () => {
    // The whole reason the view exists. A `resolve` action here would put the rating buttons back
    // in front of images that can never be rated.
    expect(Object.keys(missingActions)).toEqual(['delete']);
  });

  it('rejects a request with no image id', async () => {
    const result = (await missingActions.delete({
      request: request({}),
      locals,
    } as never)) as { status: number; data: { error: string } };

    expect(result.status).toBe(400);
    expect(result.data.error).toBe('Missing image id');
    expect(deleteImagesByIds).not.toHaveBeenCalled();
  });
});
