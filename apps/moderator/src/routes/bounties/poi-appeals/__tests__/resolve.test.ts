import { beforeEach, describe, expect, it, vi } from 'vitest';

const { resolveBountyPoiAppeal } = vi.hoisted(() => ({ resolveBountyPoiAppeal: vi.fn() }));

vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('$lib/server/bounty-poi.service', () => ({
  getBountyPoiAppeals: vi.fn(),
  resolveBountyPoiAppeal,
}));

const { actions } = await import('../+page.server');

const post = (fields: Record<string, string>) => {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  return { request: new Request('http://x/bounties/poi-appeals', { method: 'POST', body }) };
};
type ActionEvent = Parameters<(typeof actions)['resolve']>[0];
type Refusal = { status: number; data: { error: string; bountyId?: number } };
const resolve = (fields: Record<string, string>) =>
  actions.resolve(post(fields) as unknown as ActionEvent) as Promise<Record<string, unknown>>;

beforeEach(() => {
  vi.clearAllMocks();
  resolveBountyPoiAppeal.mockResolvedValue({ ok: true, rescanQueued: false });
});

describe('bounty real-person appeal ruling', () => {
  it.each([
    ['Rejected', 'flag-confirmed', true],
    ['Approved', 'not-a-real-person', false],
  ])('a %s ruling records its reason', async (status, resolvedReason, uphold) => {
    expect(
      await resolve({ bountyId: '9', status, resolvedReason, internalNotes: 'checked' })
    ).toMatchObject({ success: true, bountyId: 9 });
    expect(resolveBountyPoiAppeal).toHaveBeenCalledExactlyOnceWith(9, uphold, {
      resolvedReason,
      internalNotes: 'checked',
    });
  });

  it.each([
    ['no reason', { status: 'Approved' }, /Pick a reason/],
    [
      'a keep reason on an approval',
      { status: 'Approved', resolvedReason: 'flag-confirmed' },
      /not a reason for Approved/,
    ],
    [
      'Other with no note',
      { status: 'Rejected', resolvedReason: 'other' },
      /note when the reason is Other/,
    ],
    [
      'a minor reason on a real-person flag',
      { status: 'Approved', resolvedReason: 'not-a-minor' },
      /does not apply to this flag/,
    ],
  ])('refuses %s before calling the main app', async (_label, fields, message) => {
    const result = (await resolve({ bountyId: '9', ...fields })) as unknown as Refusal;
    expect(result.status).toBe(400);
    expect(result.data.error).toMatch(message);
    expect(resolveBountyPoiAppeal).not.toHaveBeenCalled();
  });

  it('refuses a missing verdict', async () => {
    const result = (await resolve({
      bountyId: '9',
      resolvedReason: 'other',
    })) as unknown as Refusal;
    expect(result.status).toBe(400);
    expect(resolveBountyPoiAppeal).not.toHaveBeenCalled();
  });
});
