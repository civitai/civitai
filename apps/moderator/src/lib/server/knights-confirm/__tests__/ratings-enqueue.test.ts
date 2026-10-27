import { beforeEach, describe, expect, it, vi } from 'vitest';

const { updateImageNsfwLevel, enqueueConfirm, logAxiomError } = vi.hoisted(() => ({
  updateImageNsfwLevel: vi.fn(),
  enqueueConfirm: vi.fn(),
  logAxiomError: vi.fn(),
}));

vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('$lib/server/image-nsfw-level', () => ({ updateImageNsfwLevel }));
vi.mock('$lib/server/image-rating-review.service', () => ({ getImageRatingRequests: vi.fn() }));
vi.mock('$lib/server/axiom', () => ({ logAxiomError }));
vi.mock('../confirm.service', () => ({ enqueueConfirm, isConfirmLevel: (n: number) => n < 32 }));

const { actions } = await import('../../../../routes/images/ratings/+page.server');

const setLevel = (fields: Record<string, string>) =>
  actions.setLevel({
    request: {
      formData: async () => {
        const form = new FormData();
        for (const [k, v] of Object.entries(fields)) form.set(k, v);
        return form;
      },
    },
    locals: { user: { id: 7 } },
  } as never);

beforeEach(() => {
  vi.resetAllMocks();
  updateImageNsfwLevel.mockResolvedValue(undefined);
  enqueueConfirm.mockResolvedValue(true);
});

describe('setLevel', () => {
  it('queues a blind confirmation after the level is written', async () => {
    const result = await setLevel({ id: '52', nsfwLevel: '4' });

    expect(result).toEqual({ success: true, id: 52, nsfwLevel: 4 });
    expect(enqueueConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ imageId: 52, level: 4, modId: 7 })
    );
    expect(updateImageNsfwLevel.mock.invocationCallOrder[0]).toBeLessThan(
      enqueueConfirm.mock.invocationCallOrder[0]
    );
  });

  it('still succeeds, and logs, when the queue write fails', async () => {
    enqueueConfirm.mockRejectedValue(new Error('db down'));

    const result = await setLevel({ id: '52', nsfwLevel: '4' });

    expect(result).toEqual({ success: true, id: 52, nsfwLevel: 4 });
    expect(logAxiomError).toHaveBeenCalled();
  });

  it('does not queue when the level write fails', async () => {
    updateImageNsfwLevel.mockRejectedValue(new Error('no such image'));

    await expect(setLevel({ id: '52', nsfwLevel: '4' })).rejects.toThrow();
    expect(enqueueConfirm).not.toHaveBeenCalled();
  });
});
