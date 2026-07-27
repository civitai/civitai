import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockDbRead, mockDbWrite } = vi.hoisted(() => ({
  mockDbRead: { $queryRaw: vi.fn() },
  mockDbWrite: { $queryRaw: vi.fn(), $executeRaw: vi.fn() },
}));

const { mockSetModelMinor, mockTrackModActivity, mockLogToAxiom } = vi.hoisted(() => ({
  mockSetModelMinor: vi.fn(),
  mockTrackModActivity: vi.fn(),
  mockLogToAxiom: vi.fn(),
}));

vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead, dbWrite: mockDbWrite }));
vi.mock('~/server/services/model.service', () => ({ setModelMinor: mockSetModelMinor }));
vi.mock('~/server/services/moderator.service', () => ({ trackModActivity: mockTrackModActivity }));
vi.mock('~/server/logging/client', () => ({ logToAxiom: mockLogToAxiom }));

import { findMinorHashMatches } from '~/server/services/minor-hash.service';

beforeEach(() => {
  vi.clearAllMocks();
  mockDbRead.$queryRaw.mockResolvedValue([]);
});

describe('findMinorHashMatches', () => {
  it('maps rows to { modelId, userId }', async () => {
    mockDbRead.$queryRaw.mockResolvedValue([
      { id: 10, userId: 1 },
      { id: 11, userId: 2 },
    ]);

    const result = await findMinorHashMatches('ABC123');

    expect(result).toEqual([
      { modelId: 10, userId: 1 },
      { modelId: 11, userId: 2 },
    ]);
  });

  it('returns [] without querying when the hash is empty', async () => {
    const result = await findMinorHashMatches('');

    expect(result).toEqual([]);
    expect(mockDbRead.$queryRaw).not.toHaveBeenCalled();
  });

  it('queries with the SHA256 + lockedProperties gate', async () => {
    await findMinorHashMatches('ABC123');

    // $queryRaw is called as a tagged template, so the mock receives
    // (TemplateStringsArray, ...substitutions) — not a single Sql object.
    const [strings, ...values] = mockDbRead.$queryRaw.mock.calls[0];
    const text = Array.from(strings as TemplateStringsArray).join('?');
    expect(text).toContain(`'SHA256'`);
    expect(text).toContain(`'minor' = ANY(m."lockedProperties")`);
    expect(text).toContain(`mf.type = 'Model'`);
    expect(values).toContain('ABC123');
  });
});
