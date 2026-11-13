import { IP_PATTERN } from './clickhouse-filters';

/**
 * One address as a matching key. IPv4 stays exact; IPv6 collapses to its `/64`, because a residential
 * prefix rotates the low 64 bits per connection and an exact match splits one household into dozens of
 * "different" addresses. `clusterSql` is the same key in ClickHouse.
 *
 * 🔴 The `/64` is written the way ClickHouse's `IPv6NumToString` writes it (RFC 5952: no leading
 * zeros, the longest run of two or more zero groups compressed), because `clusterSql` produces the
 * same key on the database side and the two are compared as strings.
 *
 * `null` for anything that is not a well-formed address. These strings are interpolated into ClickHouse,
 * which does no escaping, so nothing reaches a query except what this function produced.
 */
export function ipCluster(ip: string): string | null {
  const value = ip.trim().toLowerCase();
  if (!IP_PATTERN.test(value)) return null;
  if (!value.includes(':'))
    return /^\d{1,3}(\.\d{1,3}){3}$/.test(value) &&
      value.split('.').every((octet) => Number(octet) <= 255)
      ? value
      : null;
  const hextets = expandIpv6(value);
  return hextets ? `${formatIpv6([...hextets.slice(0, 4), 0, 0, 0, 0])}/64` : null;
}

/** A key `ipCluster` could have produced, and so safe to interpolate. */
export function isClusterKey(value: string): boolean {
  if (!value.endsWith('/64')) return ipCluster(value) === value;
  return ipCluster(value.slice(0, -3)) === value;
}

function expandIpv6(value: string): number[] | null {
  const halves = value.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  // An embedded IPv4 tail (`::ffff:1.2.3.4`) is not a residential prefix; there is nothing to group.
  if ([...head, ...tail].some((h) => !/^[0-9a-f]{1,4}$/.test(h))) return null;
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  return [...head, ...Array<string>(missing).fill('0'), ...tail].map((h) => parseInt(h, 16));
}

function formatIpv6(hextets: number[]): string {
  let best = { start: -1, length: 0 };
  for (let i = 0; i < hextets.length; ) {
    if (hextets[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < hextets.length && hextets[j] === 0) j++;
    if (j - i > best.length) best = { start: i, length: j - i };
    i = j;
  }
  const text = hextets.map((h) => h.toString(16));
  if (best.length < 2) return text.join(':');
  const head = text.slice(0, best.start).join(':');
  const tail = text.slice(best.start + best.length).join(':');
  return `${head}::${tail}`;
}

/**
 * Literal text every address in this `/64` contains, wherever it is written compressed or not: the
 * groups before the first zero group, which no spelling can drop. A zero group early in the prefix
 * makes it short and so broad; callers re-derive each matched row's cluster and keep only the ones
 * asked for. `null` when the first group is zero (reserved space, never a public address).
 */
function v6Prefix(cluster: string): string | null {
  const head: string[] = [];
  for (const group of cluster.slice(0, -'::/64'.length).split(':')) {
    if (group === '0' || group === '') break;
    head.push(group);
  }
  return head.length ? `${head.join(':')}:` : null;
}

/**
 * A WHERE fragment matching any address in `clusters`.
 *
 * 🔴 Shaped for the `reactions` table, where `ip` has no index and every row in the time window is
 * read: an exact `IN` for IPv4 and one `multiSearchAny` over the IPv6 prefixes, rather than computing
 * every row's `/64`. A prefix is not anchored, so it can match mid-string in an unrelated address:
 * every caller re-derives the matched row's cluster with `clusterSql` and keeps only the ones asked
 * for.
 */
export function clusterMatchSql(clusters: string[], column = 'ip'): string | null {
  const exact = new Set<string>();
  const prefixes = new Set<string>();
  for (const cluster of clusters) {
    if (!isClusterKey(cluster)) continue;
    if (!cluster.endsWith('/64')) exact.add(cluster);
    else {
      const prefix = v6Prefix(cluster);
      if (prefix) prefixes.add(prefix);
    }
  }
  const parts: string[] = [];
  if (exact.size) parts.push(`${column} IN (${[...exact].map((ip) => `'${ip}'`).join(',')})`);
  if (prefixes.size)
    parts.push(`multiSearchAny(${column}, [${[...prefixes].map((p) => `'${p}'`).join(',')}])`);
  return parts.length ? `(${parts.join(' OR ')})` : null;
}

/**
 * The ClickHouse twin of `ipCluster`, with `groupIpv4` for a hosting range that rotates IPv4 inside
 * a `/24` (off by default: a `/24` merges unrelated subscribers on one ISP block).
 *
 * 🔴 The grouping has to happen INSIDE the query. Done afterwards in JS, a `HAVING uniq(...) > 1` runs
 * per exact address, and the rotation case it exists to catch (two accounts on one prefix, never on
 * the same suffix) is exactly what it drops. The branch on `:` is load-bearing: `toIPv6` maps IPv4
 * into `::ffff:0:0/96`, so one unbranched `/64` would put every IPv4 address in one bucket.
 */
export const clusterSql = (column = 'ip', { groupIpv4 = false } = {}) =>
  `if(position(${column}, ':') > 0, concat(IPv6NumToString(tupleElement(IPv6CIDRToRange(toIPv6OrDefault(${column}), 64), 1)), '/64'), ${
    groupIpv4
      ? `concat(IPv4NumToString(bitAnd(toIPv4OrDefault(${column}), 4294967040)), '/24')`
      : column
  })`;

/** `'a','b'` for an `IN (…)` list of cluster keys, refusing anything `ipCluster` could not produce. */
export const clusterList = (clusters: string[]) =>
  clusters
    .filter(isClusterKey)
    .map((c) => `'${c}'`)
    .join(',');
