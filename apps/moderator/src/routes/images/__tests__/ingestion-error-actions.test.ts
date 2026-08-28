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
const isMissingMediaImage = vi.fn(async () => true);
const imageRowExists = vi.fn(async () => false);
const recordModActivity = vi.fn();

vi.mock('$lib/server/ingestion.service', () => ({
  resolveIngestionError,
  getIngestionErrorImages,
  getMissingMediaImages,
  isMissingMediaImage,
  imageRowExists,
}));
vi.mock('$lib/server/image-deletion', () => ({ deleteImagesByIds }));
vi.mock('$lib/server/mod-activity', () => ({ recordModActivity }));

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

beforeEach(() => {
  vi.clearAllMocks();
  // 🔴 `clearAllMocks` clears CALLS, not IMPLEMENTATIONS. Every mock whose implementation any test
  // changes must be restored here or it leaks into whatever runs next — the defect class that
  // already made one suite in this PR pass for the wrong reason. Listing all three, not just the
  // one that bit us: `deleteImagesByIds` carries both a resolve and a reject below, and was benign
  // only by accident of test order.
  isMissingMediaImage.mockResolvedValue(true);
  imageRowExists.mockResolvedValue(false);
  deleteImagesByIds.mockResolvedValue(undefined);
});

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

describe('missing-media delete action — scoping', () => {
  it('refuses an id that is not in the missing-media queue, and deletes nothing', async () => {
    // The action takes an id off a form and `deleteImagesByIds` is permanent and cascading. Without
    // this re-selection the page is an arbitrary delete-any-image-by-id endpoint.
    isMissingMediaImage.mockResolvedValue(false);

    const result = (await missingActions.delete({
      request: request({ id: '4242' }),
      locals,
    } as never)) as { status: number; data: { error: string } };

    expect(result.status).toBe(400);
    expect(result.data.error).toBe('That image is not in the missing-media queue.');
    expect(deleteImagesByIds).not.toHaveBeenCalled();
    expect(recordModActivity).not.toHaveBeenCalled();
  });

  it('attributes the delete to the moderator who performed it', async () => {
    deleteImagesByIds.mockResolvedValue(undefined);
    await missingActions.delete({ request: request({ id: '4242' }), locals } as never);
    expect(recordModActivity).toHaveBeenCalledWith({
      userId: 7,
      entityType: 'image',
      entityId: 4242,
      activity: 'deleteMissingMedia',
    });
  });

  it('records nothing when the delete SILENTLY failed and the row survived', async () => {
    /**
     * 🔴 The reachable shape, and the one that shipped broken. `deleteImagesByIds` wraps every
     * per-image body in a try/catch that logs and continues, so a failed DB or storage step
     * RESOLVES. An earlier revision of this test used `mockRejectedValue` — a state the real
     * function cannot reach — so it read as coverage while providing none, and the action happily
     * reported success and wrote an audit row for an image still on the site.
     */
    deleteImagesByIds.mockResolvedValue(undefined); // resolves, exactly as the real one does
    imageRowExists.mockResolvedValue(true); // ...but the row is still there

    const result = (await missingActions.delete({
      request: request({ id: '4242' }),
      locals,
    } as never)) as { status: number; data: { error: string } };

    expect(result.status).toBe(400);
    expect(result.data.error).toBe(
      'The delete did not complete — the image is still present. Nothing was recorded.'
    );
    // The whole point: no audit row attesting a delete that did not happen.
    expect(recordModActivity).not.toHaveBeenCalled();
  });

  it('confirms the row is gone before attributing, not merely that the call resolved', async () => {
    deleteImagesByIds.mockResolvedValue(undefined);
    imageRowExists.mockResolvedValue(false);

    const result = await missingActions.delete({
      request: request({ id: '4242' }),
      locals,
    } as never);

    expect(imageRowExists).toHaveBeenCalledWith(4242);
    expect(result).toEqual({ success: true, id: 4242 });
    expect(recordModActivity).toHaveBeenCalledTimes(1);
  });
});
