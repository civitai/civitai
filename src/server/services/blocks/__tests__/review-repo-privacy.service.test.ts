import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Coverage for the one-off "flip existing in-review snapshots to private"
 * backfill. The properties that matter are the ones that make it safe for a
 * human to run it, re-run it, and trust the report: idempotent, tolerant of a
 * vanished repo, log-and-continue on a per-repo failure, and a dryRun that
 * changes nothing while still naming what it would touch.
 */

const { mockList, mockSetPrivate, mockLogToAxiom } = vi.hoisted(() => ({
  mockList: vi.fn(),
  mockSetPrivate: vi.fn(),
  mockLogToAxiom: vi.fn(() => Promise.resolve(undefined)),
}));

vi.mock('../forgejo.service', () => ({
  listReviewRepos: (...a: unknown[]) => mockList(...a),
  setReviewRepoPrivate: (...a: unknown[]) => mockSetPrivate(...a),
}));
vi.mock('~/server/logging/client', () => ({
  logToAxiom: (...a: unknown[]) => mockLogToAxiom(...a),
}));

import { backfillReviewRepoPrivacy } from '../review-repo-privacy.service';

beforeEach(() => {
  mockList.mockReset();
  mockSetPrivate.mockReset();
  mockSetPrivate.mockResolvedValue('updated');
  mockLogToAxiom.mockReset();
  mockLogToAxiom.mockReturnValue(Promise.resolve(undefined));
});

describe('backfillReviewRepoPrivacy', () => {
  it('flips the public repos and leaves the already-private ones untouched', async () => {
    mockList.mockResolvedValue([
      { name: 'a', private: false },
      { name: 'b', private: true },
      { name: 'c', private: false },
    ]);

    const result = await backfillReviewRepoPrivacy();

    expect(mockSetPrivate.mock.calls.map((c) => c[0])).toEqual(['a', 'c']);
    expect(result).toMatchObject({
      scanned: 3,
      updated: 2,
      alreadyPrivate: 1,
      missing: 0,
      dryRun: false,
    });
    expect(result.updatedSlugs).toEqual(['a', 'c']);
    expect(result.failed).toEqual([]);
  });

  /** Re-running after a completed backfill must be a pure no-op. */
  it('is idempotent: a second run over an all-private org patches nothing', async () => {
    mockList.mockResolvedValue([
      { name: 'a', private: true },
      { name: 'b', private: true },
    ]);

    const result = await backfillReviewRepoPrivacy();

    expect(mockSetPrivate).not.toHaveBeenCalled();
    expect(result).toMatchObject({ scanned: 2, updated: 0, alreadyPrivate: 2 });
  });

  it('counts a repo that vanished mid-run as `missing`, not failed', async () => {
    mockList.mockResolvedValue([{ name: 'a', private: false }]);
    mockSetPrivate.mockResolvedValue('missing');

    const result = await backfillReviewRepoPrivacy();

    expect(result.missing).toBe(1);
    expect(result.updated).toBe(0);
    expect(result.failed).toEqual([]);
  });

  it('logs-and-continues past a per-repo failure', async () => {
    mockList.mockResolvedValue([
      { name: 'bad', private: false },
      { name: 'good', private: false },
    ]);
    mockSetPrivate.mockImplementation(async (slug: string) => {
      if (slug === 'bad') throw new Error('forgejo 403');
      return 'updated';
    });

    const result = await backfillReviewRepoPrivacy();

    expect(result.failed).toEqual([{ slug: 'bad', error: 'forgejo 403' }]);
    expect(result.updated).toBe(1);
    expect(mockSetPrivate).toHaveBeenCalledWith('good');
  });

  it('dryRun names the slugs it would flip but issues no PATCH', async () => {
    mockList.mockResolvedValue([
      { name: 'a', private: false },
      { name: 'b', private: true },
    ]);

    const result = await backfillReviewRepoPrivacy({ dryRun: true });

    expect(mockSetPrivate).not.toHaveBeenCalled();
    expect(result).toMatchObject({ dryRun: true, updated: 0, alreadyPrivate: 1 });
    expect(result.updatedSlugs).toEqual(['a']);
  });

  it('honours `limit`', async () => {
    mockList.mockResolvedValue([
      { name: 'a', private: false },
      { name: 'b', private: false },
      { name: 'c', private: false },
    ]);

    const result = await backfillReviewRepoPrivacy({ limit: 2 });

    expect(result.scanned).toBe(2);
    expect(mockSetPrivate).toHaveBeenCalledTimes(2);
  });

  it('logs a per-repo outcome plus a summary', async () => {
    mockList.mockResolvedValue([{ name: 'a', private: false }]);

    await backfillReviewRepoPrivacy();

    const payloads = mockLogToAxiom.mock.calls.map((c) => c[0] as Record<string, unknown>);
    expect(payloads).toContainEqual(
      expect.objectContaining({ slug: 'a', outcome: 'updated' })
    );
    expect(payloads).toContainEqual(
      expect.objectContaining({ outcome: 'summary', scanned: 1, updated: 1 })
    );
  });

  it('handles an org with no repos at all', async () => {
    mockList.mockResolvedValue([]);

    const result = await backfillReviewRepoPrivacy();

    expect(result).toMatchObject({ scanned: 0, updated: 0, alreadyPrivate: 0 });
    expect(mockSetPrivate).not.toHaveBeenCalled();
  });
});
