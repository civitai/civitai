import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('$app/server', () => ({ getRequestEvent: vi.fn() }));

const { resolveRestriction } = vi.hoisted(() => ({
  resolveRestriction: vi.fn(async () => ({ ok: true as const })),
}));
vi.mock('$lib/server/user-actions.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/user-actions.service')>()),
  resolveRestriction,
}));
vi.mock('$lib/server/access', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/access')>()),
  canAccess: () => true,
}));

const { actions } = await import('../+page.server');

const formEvent = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [k, v] of Object.entries({ userId: '42', userRestrictionId: '5', ...fields }))
    data.append(k, v);
  return {
    request: { formData: async () => data },
    locals: { user: { id: 7 }, grants: {} },
  } as unknown as Parameters<(typeof actions)['resolveRestriction']>[0];
};

beforeEach(() => vi.clearAllMocks());

describe('user-lookup resolveRestriction — ruling reason', () => {
  it('forwards the reason and the note with the verdict', async () => {
    const result = await actions.resolveRestriction(
      formEvent({
        status: 'Overturned',
        resolvedReason: 'art-context',
        internalNotes: 'anime style',
      })
    );

    expect(result).toEqual({ success: true });
    expect(resolveRestriction).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        status: 'Overturned',
        resolvedReason: 'art-context',
        internalNotes: 'anime style',
      })
    );
  });

  it.each([
    ['no reason', { status: 'Upheld' }, /Pick a reason/],
    [
      'an uphold reason on an overturn',
      { status: 'Overturned', resolvedReason: 'repeat-evasion' },
      /not a reason for Overturned/,
    ],
    [
      'an overturn reason on an uphold',
      { status: 'Upheld', resolvedReason: 'word-match' },
      /not a reason for Upheld/,
    ],
    [
      'Other with no note',
      { status: 'Overturned', resolvedReason: 'other' },
      /note when the reason is Other/,
    ],
  ])('refuses %s without ruling', async (_label, fields, message) => {
    const result = (await actions.resolveRestriction(formEvent(fields))) as {
      status: number;
      data: { error: string };
    };

    expect(result.status).toBe(400);
    expect(result.data.error).toMatch(message);
    expect(resolveRestriction).not.toHaveBeenCalled();
  });
});
