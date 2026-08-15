import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFeedbackSchema } from '~/server/schema/feedback.schema';

const { mocks } = vi.hoisted(() => ({
  mocks: {
    feedbackCreate: vi.fn(),
    isFlipt: vi.fn(),
  },
}));

vi.mock('~/server/db/client', () => ({
  dbRead: {},
  dbWrite: { feedback: { create: mocks.feedbackCreate } },
}));

vi.mock('~/server/flipt/client', () => ({ isFlipt: mocks.isFlipt }));

const { createFeedback, isFeedbackAreaEnabled } = await import('../feedback.service');

beforeEach(() => {
  vi.clearAllMocks();
  mocks.feedbackCreate.mockResolvedValue({ id: 1 });
  mocks.isFlipt.mockResolvedValue(true);
});

/** What the write layer was actually handed, read off the real call. */
const writtenContext = () => mocks.feedbackCreate.mock.calls[0][0].data.context;

/**
 * `createFeedback` persistence for the extended context.
 *
 * The point of asserting on `dbWrite.feedback.create`'s argument rather than on the
 * function's return value: the return is `{ id }` and says nothing about what was
 * stored. A context field can be accepted by the schema, typed in the DTO, and still
 * never reach the column — that is the failure this file exists to catch, and it is
 * invisible from the outside.
 */
describe('createFeedback — extended context', () => {
  const args = {
    userId: 7,
    area: 'bitdex-image-feed' as const,
    message: 'the feed repeated itself',
  };

  it('writes attached image ids into the stored context', async () => {
    await createFeedback({ ...args, context: { images: ['cf-1', 'cf-2'] } });
    expect(writtenContext()).toEqual({ images: ['cf-1', 'cf-2'] });
  });

  it('writes the screenshot id into the stored context', async () => {
    await createFeedback({ ...args, context: { screenshotId: 'cf-shot' } });
    expect(writtenContext()).toEqual({ screenshotId: 'cf-shot' });
  });

  it('writes the Faro session id into the stored context', async () => {
    await createFeedback({ ...args, context: { sessionId: 'faro-abc' } });
    expect(writtenContext()).toEqual({ sessionId: 'faro-abc' });
  });

  it('writes all three alongside the pre-existing fields', async () => {
    await createFeedback({
      ...args,
      context: {
        path: '/images',
        reportedSource: 'bitdex',
        images: ['cf-1'],
        screenshotId: 'cf-shot',
        sessionId: 'faro-abc',
      },
    });
    expect(writtenContext()).toEqual({
      path: '/images',
      reportedSource: 'bitdex',
      images: ['cf-1'],
      screenshotId: 'cf-shot',
      sessionId: 'faro-abc',
    });
    expect(mocks.feedbackCreate.mock.calls[0][0].data.userId).toBe(7);
    expect(mocks.feedbackCreate.mock.calls[0][0].data.area).toBe('bitdex-image-feed');
  });

  /**
   * THE SEAM. The two halves above are each hermetic — the schema test proves the
   * boundary keeps the fields, this file proves the service writes whatever it is
   * handed — and both would stay green if the schema stripped a field the service
   * happily forwards. Parsing first is what makes them meet.
   */
  it('persists what the BOUNDARY SCHEMA produced, not what the caller typed', async () => {
    const parsed = createFeedbackSchema.parse({
      area: 'bitdex-image-feed',
      message: 'the feed repeated itself',
      context: {
        path: '/images',
        images: ['cf-1', 'cf-2'],
        screenshotId: 'cf-shot',
        sessionId: 'faro-abc',
      },
    });
    await createFeedback({ ...parsed, userId: 7 });
    expect(writtenContext()).toEqual({
      path: '/images',
      images: ['cf-1', 'cf-2'],
      screenshotId: 'cf-shot',
      sessionId: 'faro-abc',
    });
  });

  // Faro absent (dev/test/preview, or a blocked SDK) is the ordinary case: the
  // submission must be written with no sessionId rather than failing.
  it('writes a submission that carries no sessionId', async () => {
    await createFeedback({ ...args, context: { images: ['cf-1'] } });
    expect(writtenContext()).not.toHaveProperty('sessionId');
    expect(writtenContext()).toEqual({ images: ['cf-1'] });
  });

  it('writes an empty object when there is no context at all (invariant guard)', async () => {
    await createFeedback(args);
    expect(writtenContext()).toEqual({});
  });
});

describe('isFeedbackAreaEnabled (invariant guard — unchanged by this work)', () => {
  it('asks Flipt for the area flag keyed on the user id', async () => {
    await isFeedbackAreaEnabled({ area: 'bitdex-image-feed', userId: 7 });
    expect(mocks.isFlipt).toHaveBeenCalledWith('feedback-area-bitdex-image-feed', '7');
  });

  it('falls back to the anonymous entity id', async () => {
    await isFeedbackAreaEnabled({ area: 'bitdex-image-feed' });
    expect(mocks.isFlipt).toHaveBeenCalledWith('feedback-area-bitdex-image-feed', 'anonymous');
  });
});
