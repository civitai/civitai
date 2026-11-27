import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Restore from the moderator app logs `bulkRestore` for each image the main app restored. It skips an
 * image only the CSAM review may restore, and keeps one blocked while its owner is deleted: neither
 * gets a restore on its audit trail.
 */

const recordModActivity = vi.hoisted(() => vi.fn(async (_row: { entityId: number }) => undefined));

vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('$env/dynamic/private', () => ({ env: { WEBHOOK_TOKEN: 'test-token' } }));
vi.mock('$app/server', () => ({ getRequestEvent: () => ({ locals: {} }) }));
vi.mock('../civitai-url', () => ({ tryCivitaiInternalUrl: () => 'https://main.test' }));
vi.mock('../mod-activity', () => ({ recordModActivity }));

const { restoreImages, restoredIdsOf, setImageFlag } = await import('../user-actions.service');

const answer = (body: Record<string, unknown>) =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }))
  );
const logged = () => recordModActivity.mock.calls.map(([row]) => row.entityId);

beforeEach(() => {
  recordModActivity.mockClear();
});

describe('restoreImages', () => {
  it('logs a restore only for the images the main app restored', async () => {
    answer({ images: 1, restored: [3], skipped: [1, 2] });

    expect(
      await restoreImages({ imageIds: [1, 2, 3, 4], moderatorId: 9, csamReview: false })
    ).toEqual({
      ok: true,
      count: 1,
    });
    expect(logged()).toEqual([3]);
  });

  it('logs nothing when the main app restored nothing', async () => {
    answer({ images: 0, restored: [], skipped: [1] });

    await restoreImages({ imageIds: [1], moderatorId: 9, csamReview: false });
    expect(logged()).toEqual([]);
  });

  it.each([true, false])(
    "sends the moderator's grant (%s) for the main app to gate on",
    async (grant) => {
      answer({ images: 0, restored: [], skipped: [1] });

      await restoreImages({ imageIds: [1], moderatorId: 9, csamReview: grant });

      const [, init] = vi.mocked(fetch).mock.calls[0] as [unknown, RequestInit];
      expect(JSON.parse(init.body as string)).toMatchObject({ csamReview: grant });
    }
  );
});

describe('restoredIdsOf', () => {
  it('reads a response without `restored` by its `skipped` list', () => {
    expect(restoredIdsOf([1, 2, 3], { images: 2, skipped: [2] })).toEqual([1, 3]);
  });
});

describe('setImageFlag', () => {
  it('records the chunks applied before a later chunk is refused', async () => {
    const ids = Array.from({ length: 150 }, (_, i) => i + 1);
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ message: 'ok' }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'refused' }), { status: 403 }))
    );

    const result = await setImageFlag({
      imageIds: ids,
      flag: 'minor',
      value: false,
      moderatorId: 9,
      csamReview: false,
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain('100 images were already updated');
    expect(logged()).toEqual(ids.slice(0, 100));
  });
});
