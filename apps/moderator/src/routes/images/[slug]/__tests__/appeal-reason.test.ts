import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('$app/server', () => ({ getRequestEvent: vi.fn() }));

const { resolveImageAppeal, sendBulkAppealEmails } = vi.hoisted(() => ({
  resolveImageAppeal: vi.fn(async (_input: { imageId: number }) => ({ userId: 7 })),
  sendBulkAppealEmails: vi.fn(async () => undefined),
}));
vi.mock('$lib/server/image-moderation.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/image-moderation.service')>()),
  resolveImageAppeal,
  sendBulkAppealEmails,
}));

const { actions } = await import('../+page.server');

const formEvent = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.append(k, v);
  return {
    request: { formData: async () => data },
    locals: { user: { id: 2 } },
  } as unknown as Parameters<(typeof actions)['resolveAppeal']>[0];
};

type Refusal = { status: number; data: { error: string } };

beforeEach(() => vi.clearAllMocks());

describe('resolveAppeal — ruling reason', () => {
  it('records the reason and the note against the verdict posted', async () => {
    await actions.resolveAppeal(
      formEvent({
        imageId: '41',
        status: 'Rejected',
        resolvedReason: 'violation-confirmed',
        internalNotes: 'same image',
      })
    );

    expect(resolveImageAppeal).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        imageId: 41,
        status: 'Rejected',
        resolvedReason: 'violation-confirmed',
        internalNotes: 'same image',
      })
    );
  });

  it.each([
    ['no reason', { status: 'Approved' }, /Pick a reason/],
    [
      'a reject reason on an approval',
      { status: 'Approved', resolvedReason: 'violation-confirmed' },
      /not a reason for Approved/,
    ],
    [
      'a mute reason',
      { status: 'Rejected', resolvedReason: 'clear-intent' },
      /not a reason for Rejected/,
    ],
    [
      'Other with no note',
      { status: 'Approved', resolvedReason: 'other' },
      /note when the reason is Other/,
    ],
  ])('refuses %s without closing the appeal', async (_label, fields, message) => {
    const result = (await actions.resolveAppeal(
      formEvent({ imageId: '41', ...fields })
    )) as Refusal;

    expect(result.status).toBe(400);
    expect(result.data.error).toMatch(message);
    expect(resolveImageAppeal).not.toHaveBeenCalled();
  });
});

describe('bulkResolveAppeal — one reason for the batch', () => {
  it('applies the reason to every appeal in the batch', async () => {
    await actions.bulkResolveAppeal(
      formEvent({ imageIds: '41,42', status: 'Approved', resolvedReason: 'misclassified' })
    );

    expect(resolveImageAppeal.mock.calls.map(([arg]) => arg)).toEqual([
      expect.objectContaining({ imageId: 41, status: 'Approved', resolvedReason: 'misclassified' }),
      expect.objectContaining({ imageId: 42, status: 'Approved', resolvedReason: 'misclassified' }),
    ]);
  });

  it('refuses a bad reason before closing any appeal in the batch', async () => {
    const result = (await actions.bulkResolveAppeal(
      formEvent({ imageIds: '41,42', status: 'Rejected', resolvedReason: 'misclassified' })
    )) as Refusal;

    expect(result.status).toBe(400);
    expect(result.data.error).toMatch(/not a reason for Rejected/);
    expect(resolveImageAppeal).not.toHaveBeenCalled();
    expect(sendBulkAppealEmails).not.toHaveBeenCalled();
  });
});
