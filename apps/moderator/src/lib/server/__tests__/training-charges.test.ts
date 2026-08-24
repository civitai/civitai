import { describe, expect, it, vi } from 'vitest';

// `user-account.service` pulls the Postgres and ClickHouse clients at import; neither is touched by the
// pure function under test, and `db` deliberately throws on import without DATABASE_REPLICA_URL.
vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('$lib/server/clickhouse', () => ({ getClickhouse: () => ({}) }));

const { unaccountedCharges } = await import('../user-account.service');

/** As ClickHouse returns it: no zone marker, and it means UTC. */
const charge = (date: string, id = date) => ({ id, date, buzz: 500, workflowId: null });

describe('unaccountedCharges', () => {
  it('treats an unzoned ClickHouse timestamp as UTC', () => {
    // Real pair from the account that prompted this: the charge and the run's own submittedAt.
    // Read as local time on any box west of Greenwich these are hours apart, and the run reads as
    // deleted when it is right there on the page.
    const charges = [charge('2026-05-26 01:06:29')];
    expect(unaccountedCharges(charges, ['2026-05-26T01:06:29.761Z'])).toEqual([]);
  });

  it('lists a charge no run submitted near', () => {
    const orphan = charge('2026-04-01 16:40:06');
    expect(unaccountedCharges([orphan], ['2026-05-26T01:06:29.761Z'])).toEqual([orphan]);
  });

  it('accounts for every submission of a retrained version, not just the first', () => {
    const charges = [charge('2026-05-29 04:56:32'), charge('2026-05-29 05:58:26')];
    expect(
      unaccountedCharges(charges, ['2026-05-29T04:56:32.100Z', '2026-05-29T05:58:26.900Z'])
    ).toEqual([]);
  });

  it('does not swallow a separate submission minutes later', () => {
    const later = charge('2026-05-29 05:58:26');
    expect(unaccountedCharges([later], ['2026-05-29T04:56:32.100Z'])).toEqual([later]);
  });

  it('keeps a charge whose timestamp will not parse rather than dropping it', () => {
    const bad = charge('not a date');
    expect(unaccountedCharges([bad], ['2026-05-26T01:06:29.761Z'])).toEqual([bad]);
  });

  it('returns every charge when no run carries a usable submit time', () => {
    const charges = [charge('2026-05-26 01:06:29'), charge('2026-04-01 16:40:06')];
    expect(unaccountedCharges(charges, [null, undefined as unknown as null])).toEqual(charges);
  });
});
