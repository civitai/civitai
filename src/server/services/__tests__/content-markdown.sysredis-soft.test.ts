import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * STEP-7 sysRedis soft-dependency (Group A) — content.service.getMarkdownContent.
 *
 * getMarkdownContent reads the region-warning content blob (sysRedis.hGet) on a
 * user-facing content query. It was already wrapped in try/catch, but the catch
 * collapses ANY read error to a 404 (`throwNotFoundError`) — so on a fast DOWN
 * it already fails to 404. The park hole was the SLOW/half-open case: the awaited
 * hGet would park ~11min before the OS keepalive errored the socket. STEP 7 adds
 * `withSysReadDeadline` to BOUND that park — the fail direction is UNCHANGED
 * (still 404), the SLOW case now rejects at the deadline and 404s in ~2s.
 *
 * The SLOW test is fail-on-revert: the underlying hGet NEVER settles, so removing
 * the wrap would hang the call → the test would TIME OUT.
 */

const { hGet, hSet, mockWithSysReadDeadline } = vi.hoisted(() => ({
  hGet: vi.fn(),
  hSet: vi.fn(async () => 1),
  mockWithSysReadDeadline: vi.fn<(p: Promise<unknown>) => Promise<unknown>>(),
}));

vi.mock('~/server/redis/client', () => ({
  sysRedis: { hGet, hSet },
  REDIS_SYS_KEYS: { CONTENT: { REGION_WARNING: 'content:region-warning' } },
  withSysReadDeadline: mockWithSysReadDeadline,
}));

import { getMarkdownContent } from '~/server/services/content.service';

const VALID = `---
title: Region Warning
description: A warning
---
Body text here.`;

beforeEach(() => {
  vi.clearAllMocks();
  mockWithSysReadDeadline.mockImplementation((p) => p); // transparent by default
  hGet.mockResolvedValue(VALID);
});

describe('getMarkdownContent — sysRedis read (park-bounded, fail direction unchanged)', () => {
  it('happy path: returns parsed frontmatter + markdown; read went through withSysReadDeadline', async () => {
    const result = await getMarkdownContent({ key: 'us' });
    expect(result.title).toBe('Region Warning');
    expect(result.description).toBe('A warning');
    expect(result.content.trim()).toBe('Body text here.');
    expect(mockWithSysReadDeadline).toHaveBeenCalledTimes(1);
  });

  it('genuine not-found (key unset → hGet null): throws NOT_FOUND (behavior preserved)', async () => {
    hGet.mockResolvedValue(null);
    await expect(getMarkdownContent({ key: 'us' })).rejects.toThrow();
    expect(mockWithSysReadDeadline).toHaveBeenCalledTimes(1);
  });

  it('DOWN: hGet throws → caught → 404 (throwNotFoundError), never hangs', async () => {
    hGet.mockRejectedValue(new Error('sysRedis connection is down'));
    await expect(getMarkdownContent({ key: 'us' })).rejects.toThrow();
    expect(mockWithSysReadDeadline).toHaveBeenCalledTimes(1);
  });

  it('SLOW/half-open: hGet NEVER settles + deadline REJECTS → 404 (fail-on-revert)', async () => {
    hGet.mockReturnValue(new Promise(() => undefined)); // never settles
    mockWithSysReadDeadline.mockRejectedValue(new Error('sysRedis read timed out after 2000ms'));
    // Without the wrap the bare `await sysRedis.hGet` would hang and this test
    // would TIME OUT. With the wrap the deadline rejects → caught → 404.
    await expect(getMarkdownContent({ key: 'us' })).rejects.toThrow();
    expect(mockWithSysReadDeadline).toHaveBeenCalledTimes(1);
  });
});
