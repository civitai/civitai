import { beforeEach, describe, expect, it, vi } from 'vitest';

const rescanStuckImages = vi.fn();

vi.mock('$lib/server/ingestion.service', () => ({
  rescanStuckImages,
  getImagesPendingIngestion: vi.fn(),
  countImagesPendingIngestion: vi.fn(),
  getIngestionHealth: vi.fn(),
  MAX_RESCAN_PER_REQUEST: 500,
  RECENT_PENDING_DAYS: 5,
}));

// `$lib/server/query` reaches `db.ts` through users.service, which throws at import without a URL.
vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));

const { actions } = await import('../to-ingest/+page.server');

const request = (fields: Record<string, string>) =>
  ({
    formData: async () => {
      const form = new FormData();
      for (const [k, v] of Object.entries(fields)) form.set(k, v);
      return form;
    },
  } as never);

const locals = { user: { id: 7 } } as never;
const rescan = (fields: Record<string, string>) =>
  actions.rescan({ request: request(fields), locals } as never);

beforeEach(() => {
  // reset, not clear: a `mockResolvedValue` from one case must not answer the next.
  vi.resetAllMocks();
});

describe('to-ingest rescan action', () => {
  it('passes the selected ids and the acting moderator', async () => {
    rescanStuckImages.mockResolvedValue({ ok: true, count: 2 });

    const result = await rescan({ imageIds: '11,12' });

    expect(rescanStuckImages).toHaveBeenCalledWith({ imageIds: [11, 12], userId: 7 });
    expect(result).toEqual({ success: true, count: 2 });
  });

  it('"all" passes no ids, so the service picks the oldest stuck images itself', async () => {
    rescanStuckImages.mockResolvedValue({ ok: true, count: 242 });

    await rescan({ all: 'true', imageIds: '11' });

    expect(rescanStuckImages).toHaveBeenCalledWith({ imageIds: undefined, userId: 7 });
  });

  it("returns the service's refusal to the moderator as a 400", async () => {
    rescanStuckImages.mockResolvedValue({ ok: false, error: 'Select at least one image.' });

    const result = (await rescan({ imageIds: '' })) as { status: number; data: { error: string } };

    expect(result.status).toBe(400);
    expect(result.data.error).toBe('Select at least one image.');
  });
});
