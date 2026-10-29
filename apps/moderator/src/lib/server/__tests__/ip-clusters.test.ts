import { describe, expect, it } from 'vitest';
import { clusterList, clusterMatchSql, ipCluster, isClusterKey } from '../ip-clusters';

/**
 * The JS cluster key is compared as a STRING with the one ClickHouse derives (`clusterSql`), so the two
 * must agree byte for byte. Each pair below is what ClickHouse's `IPv6NumToString` produced for that
 * address. And every value here is interpolated into ClickHouse unescaped, so anything that is not an
 * address must never come out the other side.
 */

describe('ipCluster', () => {
  it.each([
    ['2001:db8:aaaa:bbbb:1:2:3:4', '2001:db8:aaaa:bbbb::/64'],
    ['2001:db8:0:1::5', '2001:db8:0:1::/64'],
    ['2001:db8::1', '2001:db8::/64'],
    ['2001:0:0:1:2::', '2001:0:0:1::/64'],
    ['2001:db8:abc:0:1:2:3:4', '2001:db8:abc::/64'],
    ['fe80::1', 'fe80::/64'],
    ['1.2.3.4', '1.2.3.4'],
    ['10.0.0.1', '10.0.0.1'],
  ])('%s groups as ClickHouse groups it (%s)', (ip, cluster) => {
    expect(ipCluster(ip)).toBe(cluster);
  });

  it.each(["1.2.3.4' OR 1=1 --", '999.1.1.1', '::ffff:1.2.3.4', 'a:b:c', '1:2:3:4:5:6:7:8:9', ''])(
    'rejects %j',
    (value) => {
      expect(ipCluster(value)).toBeNull();
    }
  );
});

describe('interpolation guards', () => {
  it('keeps only keys ipCluster could have produced', () => {
    expect(isClusterKey('2001:db8::/64')).toBe(true);
    expect(isClusterKey("1.2.3.4'); DROP TABLE x; --")).toBe(false);
    expect(clusterList(['1.2.3.4', "x' OR '1'='1", '2001:db8::/64'])).toBe(
      "'1.2.3.4','2001:db8::/64'"
    );
  });

  it('matches a /64 by the groups before its first zero group, so every spelling of it matches', () => {
    const where = clusterMatchSql([
      '1.2.3.4',
      '2001:db8:aaaa:bbbb::/64',
      '2001:db8:abc::/64',
      '2001:0:5:6::/64',
      "evil'",
    ]);
    expect(where).toBe(
      "(ip IN ('1.2.3.4') OR multiSearchAny(ip, ['2001:db8:aaaa:bbbb:','2001:db8:abc:','2001:']))"
    );
  });

  it('has nothing to match when nothing valid was given', () => {
    expect(clusterMatchSql(["x'"])).toBeNull();
  });
});
