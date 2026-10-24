import { describe, expect, it, vi } from 'vitest';

const captured = vi.hoisted(() => [] as string[]);

vi.mock('$lib/server/db', async () => {
  const { capturingDb } = await import('../../../test/capture-sql');
  const db = capturingDb(captured);
  return { dbRead: db, dbWrite: db };
});

// The real module imports `$app/server`, which only exists inside SvelteKit.
vi.mock('../user-actions.service', () => ({ callModEndpoint: vi.fn() }));

const { getBountyPoiAppeals } = await import('../bounty-poi.service');

describe('getBountyPoiAppeals SQL', () => {
  it('reads Pending Bounty appeals with the text-scan poi verdict, oldest first', async () => {
    captured.length = 0;
    await getBountyPoiAppeals({ limit: 20 });
    expect(captured).toHaveLength(1);
    const statement = captured[0];
    expect(statement).toContain(`a."entityType" = 'Bounty'`);
    expect(statement).toContain(`a.status::text = 'Pending'`);
    expect(statement).toContain(`b.meta->'textScanFlags'->'poi' AS "textScanPoi"`);
    expect(statement).toContain(`b."expiresAt"`);
    expect(statement).toMatch(/ORDER BY a\."createdAt", a\.id/);
  });
});
