import { describe, expect, it } from 'vitest';
import { hatPlacementViewsSql } from '~/server/events/points/placement-stats.sql';

// A pin that names its bug. Each guard below keeps "N views since you placed it" on MyHatCard true:
// without it the count includes the owner's own views, views from before the hat went on, or views of
// an image the hat has since left. The behaviour test (placement-stats.clickhouse-local.test.ts) needs
// a ClickHouse binary, which CI does not have, so it is skipped there. This pins the SQL on CI.
const GUARDS = {
  'other people only': /\bactorId\s*!=\s*ownerId\b/,
  'since the hat went on': /\bWHERE\s+v\.time\s*>=\s*s\.startedAt\b/,
  'latest placement only': new RegExp(
    [
      /argMax\(\s*\(\s*p\.3\s*,\s*p\.4\s*,\s*p\.5\s*\)\s*,\s*p\.5\s*\)\s+AS\s+current/.source,
      /[^]*?GROUP\s+BY\s+cosmeticId\s*,\s*claimKey/.source,
      /[^]*?v\.entityType\s*=\s*s\.entityType\s+AND\s+v\.entityId\s*=\s*s\.entityId/.source,
    ].join('')
  ),
};
type Guard = keyof typeof GUARDS;

const withoutComments = (sql: string) => sql.replace(/--[^\n]*/g, '');
const missingGuards = (sql: string) =>
  (Object.keys(GUARDS) as Guard[]).filter((g) => !GUARDS[g].test(withoutComments(sql)));

function mutate(from: string, to: string) {
  expect(hatPlacementViewsSql).toContain(from);
  return hatPlacementViewsSql.replace(from, to);
}

describe('hat placement views SQL', () => {
  it('keeps every guard', () => {
    expect(missingGuards(hatPlacementViewsSql)).toEqual([]);
  });

  // Controls: each guard removed is reported, and only that one.
  it.each<[Guard, string, string]>([
    ['other people only', 'AND actorId != ownerId', ''],
    ['other people only', 'AND actorId != ownerId', '-- AND actorId != ownerId'],
    ['since the hat went on', 'WHERE v.time >= s.startedAt', ''],
    [
      'latest placement only',
      'argMax((p.3, p.4, p.5), p.5) AS current',
      'any((p.3, p.4, p.5)) AS current',
    ],
    ['latest placement only', 'AND v.entityType = s.entityType AND v.entityId = s.entityId', ''],
  ])('reports %s missing when %j becomes %j', (guard, from, to) => {
    expect(missingGuards(mutate(from, to))).toEqual([guard]);
  });
});
