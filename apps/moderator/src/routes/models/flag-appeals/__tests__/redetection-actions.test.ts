import { beforeEach, describe, expect, it, vi } from 'vitest';

const { resolveRedetection } = vi.hoisted(() => ({ resolveRedetection: vi.fn() }));

vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('$lib/server/minor-hash.service', () => ({
  getAutoFlaggedMinorModels: vi.fn(),
  getMinorFlagAppealGroups: vi.fn(),
  getMinorFlagAppealsForReview: vi.fn(),
  getMinorHashMatchesForReview: vi.fn(),
  getModelMinorState: vi.fn(),
  getRedetectedModels: vi.fn(async () => ({ items: [], hasMore: false })),
}));
vi.mock('$lib/server/minor-flag.service', () => ({
  confirmMinorFlag: vi.fn(),
  dismissMinorHashMatch: vi.fn(),
  resolveMinorFlagAppeal: vi.fn(),
  resolveMinorFlagAppealPerLabel: vi.fn(),
  resolveRedetection,
  revertMinorFlag: vi.fn(),
  setModelMinorFlag: vi.fn(),
}));

const { actions, load } = await import('../+page.server');

const post = (fields: Record<string, string>) => {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  return { request: new Request('http://x/models/flag-appeals', { method: 'POST', body }) };
};
type ActionEvent = Parameters<NonNullable<typeof actions>[string]>[0];
const run = (name: string, fields: Record<string, string>) =>
  actions![name](post(fields) as unknown as ActionEvent) as Promise<Record<string, unknown>>;

beforeEach(() => {
  vi.clearAllMocks();
  resolveRedetection.mockResolvedValue({ ok: true });
});

describe('re-detection actions', () => {
  it('keep forwards the label and keeps', async () => {
    expect(await run('keepRedetected', { modelId: '42', label: 'poi' })).toMatchObject({
      success: true,
      modelId: 42,
    });
    expect(resolveRedetection).toHaveBeenCalledWith(42, 'poi', true);
  });

  it('dismiss forwards the label and dismisses', async () => {
    await run('dismissRedetected', { modelId: '42', label: 'minor' });
    expect(resolveRedetection).toHaveBeenCalledWith(42, 'minor', false);
  });

  it.each([
    ['an unknown label', { modelId: '42', label: 'nsfw' }],
    ['no model', { label: 'minor' }],
  ])('refuses %s before calling the main app', async (_name, fields) => {
    const result = await run('keepRedetected', fields);
    expect(result).toMatchObject({ status: 400 });
    expect(resolveRedetection).not.toHaveBeenCalled();
  });

  it('shows a refusal instead of reporting success', async () => {
    resolveRedetection.mockResolvedValue({ ok: false, error: 'Reload the queue.' });
    const result = (await run('dismissRedetected', { modelId: '42', label: 'minor' })) as {
      status: number;
      data: { error: string; modelId: number };
    };
    expect(result.status).toBe(400);
    expect(result.data).toMatchObject({ error: 'Reload the queue.', modelId: 42 });
  });
});

describe('queue view', () => {
  it('loads the re-detected list only for ?view=redetected', async () => {
    const data = await (load as unknown as (e: { url: URL }) => Promise<{ view: string }>)({
      url: new URL('http://x/models/flag-appeals?view=redetected'),
    });
    expect(data.view).toBe('redetected');
  });
});
