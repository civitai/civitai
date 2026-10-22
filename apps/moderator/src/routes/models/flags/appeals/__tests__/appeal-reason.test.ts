import { beforeEach, describe, expect, it, vi } from 'vitest';

const { resolveMinorFlagAppeal, resolveMinorFlagAppealPerLabel } = vi.hoisted(() => ({
  resolveMinorFlagAppeal: vi.fn(),
  resolveMinorFlagAppealPerLabel: vi.fn(),
}));

vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('$lib/server/minor-hash.service', () => ({ bustMinorQueueCounts: vi.fn() }));
vi.mock('$lib/server/minor-flag.service', () => ({
  confirmMinorFlag: vi.fn(),
  dismissMinorHashMatch: vi.fn(),
  resolveMinorFlagAppeal,
  resolveMinorFlagAppealPerLabel,
  resolveRedetection: vi.fn(),
  revertMinorFlag: vi.fn(),
  setModelMinorFlag: vi.fn(),
}));

const { actions } = await import('../+page.server');

const post = (fields: Record<string, string>) => {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  return { request: new Request('http://x/models/flags/appeals', { method: 'POST', body }) };
};
type ActionEvent = Parameters<NonNullable<typeof actions>[string]>[0];
type Refusal = { status: number; data: { error: string; modelId?: number } };
const run = (name: string, fields: Record<string, string>) =>
  actions![name](post(fields) as unknown as ActionEvent) as Promise<Record<string, unknown>>;

beforeEach(() => {
  vi.clearAllMocks();
  resolveMinorFlagAppeal.mockResolvedValue({ ok: true, rescanQueued: false });
  resolveMinorFlagAppealPerLabel.mockResolvedValue({ ok: true, rescanQueued: false });
});

describe('model flag appeal rulings — reason', () => {
  it('records the reason and note with an uphold', async () => {
    expect(
      await run('upholdAppeal', {
        modelId: '42',
        resolvedReason: 'flag-confirmed',
        internalNotes: 'school uniform tag',
      })
    ).toMatchObject({ success: true, modelId: 42 });
    expect(resolveMinorFlagAppeal).toHaveBeenCalledExactlyOnceWith(42, true, {
      resolvedReason: 'flag-confirmed',
      internalNotes: 'school uniform tag',
    });
  });

  it('records the reason with an overturn', async () => {
    await run('overturnAppeal', { modelId: '42', resolvedReason: 'not-a-minor' });
    expect(resolveMinorFlagAppeal).toHaveBeenCalledExactlyOnceWith(42, false, {
      resolvedReason: 'not-a-minor',
      internalNotes: undefined,
    });
  });

  it('records one Approved reason for a split ruling', async () => {
    await run('splitAppeal', {
      modelId: '42',
      minor: 'uphold',
      poi: 'overturn',
      resolvedReason: 'not-a-real-person',
    });
    expect(resolveMinorFlagAppealPerLabel).toHaveBeenCalledExactlyOnceWith(
      42,
      { minor: 'uphold', poi: 'overturn' },
      { resolvedReason: 'not-a-real-person', internalNotes: undefined }
    );
  });

  // A plain form post (no JS yet) sends only the pressed split button's `ruling`.
  it.each([
    ['liftPoi', 'not-a-real-person', { minor: 'uphold', poi: 'overturn' }],
    ['liftMinor', 'not-a-minor', { minor: 'overturn', poi: 'uphold' }],
  ])('rules both labels from a %s button posted without JS', async (ruling, reason, decisions) => {
    await run('splitAppeal', { modelId: '42', ruling, resolvedReason: reason });
    expect(resolveMinorFlagAppealPerLabel).toHaveBeenCalledExactlyOnceWith(42, decisions, {
      resolvedReason: reason,
      internalNotes: undefined,
    });
  });

  it.each([
    ['upholdAppeal', 'no reason', {}, /Pick a reason/],
    [
      'upholdAppeal',
      'an unflag reason',
      { resolvedReason: 'not-a-minor' },
      /not a reason for Rejected/,
    ],
    [
      'overturnAppeal',
      'a keep reason',
      { resolvedReason: 'flag-confirmed' },
      /not a reason for Approved/,
    ],
    [
      'overturnAppeal',
      'Other with no note',
      { resolvedReason: 'other' },
      /note when the reason is Other/,
    ],
    [
      'splitAppeal',
      'a keep reason on a split',
      { minor: 'uphold', poi: 'overturn', resolvedReason: 'flag-confirmed' },
      /not a reason for Approved/,
    ],
    [
      'splitAppeal',
      'a minor reason on a split that keeps minor',
      { minor: 'uphold', poi: 'overturn', resolvedReason: 'not-a-minor' },
      /does not apply to this flag/,
    ],
  ])('%s refuses %s before calling the main app', async (action, _label, fields, message) => {
    const result = (await run(action, { modelId: '42', ...fields })) as unknown as Refusal;
    expect(result.status).toBe(400);
    expect(result.data).toMatchObject({ modelId: 42 });
    expect(result.data.error).toMatch(message);
    expect(resolveMinorFlagAppeal).not.toHaveBeenCalled();
    expect(resolveMinorFlagAppealPerLabel).not.toHaveBeenCalled();
  });
});
