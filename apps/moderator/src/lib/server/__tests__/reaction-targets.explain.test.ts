import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { explainHarness } from '../../../test/explain-harness';
import { MIN_FLAGGED } from '$lib/reactions';

/**
 * `getReactionTargets` is hand-written `sql` against a 744M-row table: identifiers and enum labels
 * TypeScript never sees. Planned against the live schema, never executed.
 *
 * The regression this exists for is a misspelt `ReviewReactions` label — `'Laughs'` typechecks and
 * returns a column of zeros, so the flagged half silently empties and the panel looks clean.
 */

const h = explainHarness();

vi.mock('../db', () => ({ dbRead: h.db, dbWrite: h.db }));
vi.mock('../clickhouse', () => ({ getClickhouse: vi.fn() }));
vi.mock('../buzz', () => ({ getBuzz: vi.fn() }));
vi.mock('../notifications', () => ({ getNotifications: vi.fn() }));
vi.mock('../moderator-db', () => ({ getModeratorDb: vi.fn() }));
vi.mock('../users.service', () => ({ usersByIds: vi.fn() }));

const service = await import('../user-account.service');

beforeEach(() => h.reset());
afterAll(() => h.destroy());

describe.skipIf(!h.hasDb)('getReactionTargets plans against the real schema', () => {
  it('plans, and reads only ImageReaction, Image and User', async () => {
    await service.getReactionTargets(1);

    expect(h.queries.length).toBe(1);
    const [plan] = await h.explainAll();

    // The panel is off the page load precisely because this table is huge; a plan that stopped using
    // the userId index would be a full scan of it on every lookup.
    expect(plan).toContain('ImageReaction_userId');
    expect(plan).not.toContain('Seq Scan on "ImageReaction"');
  });

  it('carries the caller’s limits into the statement rather than hardcoding them', async () => {
    await service.getReactionTargets(1, 3, 2);

    const [q] = h.queries;
    expect(q.parameters).toEqual([1, MIN_FLAGGED, 3, 2]);
  });
});
