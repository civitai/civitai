import { beforeEach, describe, expect, it, vi } from 'vitest';

const { listPendingCsamHolds, countPendingCsamHolds, dismissCsamHold } = vi.hoisted(() => ({
  listPendingCsamHolds: vi.fn(),
  countPendingCsamHolds: vi.fn(),
  dismissCsamHold: vi.fn(),
}));

vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('$lib/server/csam-holds.service', () => ({
  listPendingCsamHolds,
  countPendingCsamHolds,
  dismissCsamHold,
}));

const { actions, load } = await import('../+page.server');
const { holdPreview } = await import('../hold-entity');

type LoadEvent = Parameters<typeof load>[0];
type ActionEvent = Parameters<NonNullable<typeof actions>[string]>[0];

const loadAt = (query: string) =>
  load({ url: new URL(`http://x/csam/text-holds${query}`) } as unknown as LoadEvent) as Promise<
    Record<string, unknown>
  >;

const dismiss = (fields: Record<string, string>, grants: Record<string, boolean>) => {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  const event = {
    request: new Request('http://x/csam/text-holds', { method: 'POST', body }),
    locals: { grants },
  };
  return actions!.dismiss(event as unknown as ActionEvent) as Promise<Record<string, unknown>>;
};

const holder = { 'csam.report.file': true };

beforeEach(() => {
  vi.clearAllMocks();
  listPendingCsamHolds.mockResolvedValue({ items: [{ id: 1 }], hasMore: true });
  countPendingCsamHolds.mockResolvedValue(7);
  dismissCsamHold.mockResolvedValue({ ok: true });
});

describe('csam text holds load', () => {
  it('pages the queue and narrows it to one entity type', async () => {
    const data = await loadAt('?page=3&limit=20&entityType=ChatMessage');
    expect(listPendingCsamHolds).toHaveBeenCalledWith({
      limit: 20,
      offset: 40,
      entityType: 'ChatMessage',
    });
    expect(countPendingCsamHolds).toHaveBeenCalledWith('ChatMessage');
    expect(data).toMatchObject({
      page: 3,
      offset: 40,
      entityType: 'ChatMessage',
      total: 7,
      items: [{ id: 1 }],
      hasMore: true,
    });
  });

  it('ignores an unknown entity type instead of filtering on it', async () => {
    const data = await loadAt('?entityType=Image');
    expect(listPendingCsamHolds).toHaveBeenCalledWith({
      limit: 50,
      offset: 0,
      entityType: undefined,
    });
    expect(data.entityType).toBeNull();
  });

  it('still lists the queue when the total fails', async () => {
    countPendingCsamHolds.mockRejectedValue(new Error('db down'));
    const data = await loadAt('');
    expect(data).toMatchObject({ items: [{ id: 1 }], total: undefined });
  });
});

describe('csam text holds dismiss', () => {
  it('dismisses the hold with the note', async () => {
    expect(await dismiss({ holdId: '12', note: ' looked fine ' }, holder)).toMatchObject({
      success: true,
      key: 12,
    });
    expect(dismissCsamHold).toHaveBeenCalledWith({ holdId: 12, note: 'looked fine' });
  });

  it('sends no note when the field is blank', async () => {
    await dismiss({ holdId: '12', note: '   ' }, holder);
    expect(dismissCsamHold).toHaveBeenCalledWith({ holdId: 12, note: undefined });
  });

  it('refuses a moderator without the csam permission', async () => {
    expect(await dismiss({ holdId: '12' }, {})).toMatchObject({ status: 403 });
    expect(dismissCsamHold).not.toHaveBeenCalled();
  });

  it.each([
    ['no hold id', {}],
    ['a hold id past int4', { holdId: '3000000000' }],
    ['a note over the limit', { holdId: '12', note: 'x'.repeat(501) }],
  ])('refuses %s before calling the main app', async (_, fields) => {
    expect(await dismiss(fields, holder)).toMatchObject({ status: 400 });
    expect(dismissCsamHold).not.toHaveBeenCalled();
  });

  it('reports the main app refusal against the hold', async () => {
    dismissCsamHold.mockResolvedValue({ ok: false, error: 'already decided or missing' });
    expect(await dismiss({ holdId: '12' }, holder)).toMatchObject({
      status: 400,
      data: { error: 'already decided or missing', key: 12 },
    });
  });
});

describe('csam hold row preview', () => {
  it('collapses the held text onto one line', () => {
    expect(holdPreview('  first line\n\n\tsecond   line  ')).toBe('first line second line');
  });

  it('cuts long text with an ellipsis, never through a surrogate pair', () => {
    const preview = holdPreview(`${'a'.repeat(89)}😀 and more after the cut`);
    expect(preview).toBe(`${'a'.repeat(89)}😀…`);
  });
});
