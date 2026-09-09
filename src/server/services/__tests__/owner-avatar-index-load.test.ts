import { describe, expect, it, vi } from 'vitest';

/**
 * `user.service` is a hub, so this module loads into ~21 suites that hand-list their
 * `~/server/search-index` mock. Reading an index handle at module scope is enough for
 * vitest to throw `No "<name>" export is defined on the mock` at import time — which
 * fails those suites with ZERO tests collected, a shape that reads as a pass to anything
 * counting. Every one of them broke that way on the first push of this branch.
 *
 * Mocking the module as EMPTY is the whole point: the module must load without touching
 * a single export.
 */

vi.mock('~/server/search-index', () => ({}));

describe('owner-avatar-index — module load', () => {
  it('loads without reading any search-index export', async () => {
    const mod = await import('~/server/services/owner-avatar-index');

    expect(typeof mod.queueOwnerAvatarReindex).toBe('function');
  });
});
