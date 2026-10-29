import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({ dbRead: {}, dbWrite: {} }));

const { generatorSectionFor } = await import('../tickets/generator-restrictions');

const restrictions = vi.fn();
const blocked = vi.fn();
const reads = {
  restrictions: (...a: unknown[]) => restrictions(...a),
  blockedPrompts: (...a: unknown[]) => blocked(...a),
} as never;
const all = () => true;

const restriction = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  userId: 7,
  username: 'u',
  userCreatedAt: new Date('2026-01-01T00:00:00Z'),
  type: 'generation',
  status: 'Pending',
  createdAt: new Date('2026-10-01T00:00:00Z'),
  resolvedAt: null,
  resolvedMessage: null,
  resolvedReason: null,
  internalNotes: null,
  userMessage: null,
  userMessageAt: null,
  triggers: [{ key: 'a', category: 'minor', imageId: 99, inputImages: ['https://x/y.png'] }],
  ...over,
});
const prompt = (i: number) => ({
  key: `${i}:t`,
  time: '2026-10-01T00:00:00.000Z',
  prompt: `p${i}`,
  negativePrompt: null,
  source: 'image',
});

beforeEach(() => {
  restrictions.mockReset().mockResolvedValue({ items: [restriction(1)], totalCount: 1 });
  blocked.mockReset().mockResolvedValue({ prompts: [prompt(1)], total: 1 });
});

describe('generatorSectionFor', () => {
  it('lists the restrictions of the user and their blocked prompts', async () => {
    const res = await generatorSectionFor({ userId: 7, canRead: all }, reads);
    expect(res).toMatchObject({
      status: 'ok',
      userId: 7,
      restrictions: {
        status: 'ok',
        truncated: false,
        rows: [{ id: 1, type: 'generation', status: 'Pending', rulable: true, triggerCount: 1 }],
      },
      blockedPrompts: { status: 'ok', truncated: false, rows: [{ prompt: 'p1', source: 'image' }] },
    });
  });

  it('carries no generated media from the restriction rows', async () => {
    const res = await generatorSectionFor({ userId: 7, canRead: all }, reads);
    const json = JSON.stringify(res);
    expect(json).not.toContain('imageId');
    expect(json).not.toContain('inputImages');
    expect(json).not.toContain('x/y.png');
  });

  it('reads each section only under its own page grant', async () => {
    const queueOnly = await generatorSectionFor(
      { userId: 7, canRead: (p) => p === '/audit/generator-restrictions' },
      reads
    );
    expect(queueOnly).toHaveProperty('restrictions');
    expect(queueOnly).not.toHaveProperty('blockedPrompts');
    expect(blocked).not.toHaveBeenCalled();

    restrictions.mockClear();
    const lookupOnly = await generatorSectionFor(
      { userId: 7, canRead: (p) => p === '/retool/user-lookup' },
      reads
    );
    expect(lookupOnly).toHaveProperty('blockedPrompts');
    expect(lookupOnly).not.toHaveProperty('restrictions');
    expect(restrictions).not.toHaveBeenCalled();
  });

  it('turns a ClickHouse failure into an unavailable blocked prompts section only', async () => {
    blocked.mockRejectedValue(new Error('clickhouse down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await generatorSectionFor({ userId: 7, canRead: all }, reads);
    expect(res).toMatchObject({
      status: 'ok',
      restrictions: { status: 'ok' },
      blockedPrompts: { status: 'unavailable' },
    });
  });

  it('turns a failing restriction read into an unavailable restrictions section only', async () => {
    restrictions.mockRejectedValue(new Error('db down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await generatorSectionFor({ userId: 7, canRead: all }, reads);
    expect(res).toMatchObject({
      restrictions: { status: 'unavailable' },
      blockedPrompts: { status: 'ok' },
    });
  });

  it('asks for one row over the cap and says when either list was cut', async () => {
    restrictions.mockResolvedValue({
      items: Array.from({ length: 11 }, (_, i) => restriction(i + 1)),
      totalCount: 40,
    });
    blocked.mockResolvedValue({
      prompts: Array.from({ length: 11 }, (_, i) => prompt(i)),
      total: 80,
    });
    const res = await generatorSectionFor({ userId: 7, canRead: all }, reads);
    expect(restrictions).toHaveBeenCalledWith(7, 11);
    expect(blocked).toHaveBeenCalledWith(7, 11);
    expect(res).toMatchObject({
      restrictions: { truncated: true },
      blockedPrompts: { truncated: true },
    });
    if (res.restrictions?.status === 'ok') expect(res.restrictions.rows).toHaveLength(10);
    if (res.blockedPrompts?.status === 'ok') expect(res.blockedPrompts.rows).toHaveLength(10);
  });

  it('offers a ruling only on a Pending restriction of a type that can be ruled on', async () => {
    restrictions.mockResolvedValue({
      items: [
        restriction(1),
        restriction(2, { status: 'Upheld' }),
        restriction(3, { type: 'bot-account' }),
      ],
      totalCount: 3,
    });
    const res = await generatorSectionFor({ userId: 7, canRead: all }, reads);
    if (res.restrictions?.status !== 'ok') throw new Error('expected ok');
    expect(res.restrictions.rows.map((r) => [r.id, r.rulable])).toEqual([
      [1, true],
      [2, false],
      [3, false],
    ]);
  });
});
