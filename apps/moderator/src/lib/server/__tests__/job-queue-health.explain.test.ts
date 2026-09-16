import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { explainHarness } from '../../../test/explain-harness';

/**
 * The overdue cutoff is a CASE whose every THEN is a bind parameter, so its result type is decided by
 * Postgres at PLAN time, not by anything TypeScript or a compiled-SQL assertion can see. Without a
 * per-branch `::timestamptz` the CASE resolves to `text` and the statement dies with
 * `operator does not exist: timestamp with time zone < text` — which is exactly how it shipped to the
 * dashboard and rendered "Could not load background job health".
 *
 * Planned against the live schema, never executed.
 */

const h = explainHarness();

vi.mock('../db', () => ({ dbRead: h.db, dbWrite: h.db }));

const { getJobQueueHealth } = await import('../job-queue.service');

beforeEach(() => h.reset());
afterAll(() => h.destroy());

describe.skipIf(!h.hasDb)('getJobQueueHealth plans against the real schema', () => {
  it('plans — the parameterised CASE resolves to a timestamp, not text', async () => {
    await getJobQueueHealth();

    expect(h.queries.length).toBe(1);
    const [plan] = await h.explainAll();

    expect(plan).toContain('JobQueue');
    // Grouped by the two columns the panel lists lanes by; losing either collapses every lane into one.
    expect(plan).toMatch(/GroupAggregate|HashAggregate/);
  });
});
