import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { lastGoodKey } from '../feed-primary-degrade';

/**
 * The Go feed service (apps/feed-go) copies lastGoodKey's condition: for a request whose page can
 * never have a saved last-good copy, a failed feed call is this app's 503 whatever
 * `feed-service-degrade` says, and feed-go may answer that 503 itself. The two copies read one
 * fixture, apps/feed-go/internal/feed/testdata/last-good-key.json: this test runs it against the real
 * lastGoodKey, feed-go's unavailable_test.go against its own copy, so a change to the condition on
 * either side fails one of them until the fixture (and the other side) follows.
 */

type Fixture = {
  uncacheableParams: string[];
  cases: { name: string; currentUserId: number | null; query: string; lastGood: boolean }[];
};

const FIXTURE = join(process.cwd(), 'apps/feed-go/internal/feed/testdata/last-good-key.json');
const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Fixture;

describe('lastGoodKey against the fixture shared with feed-go', () => {
  it('has cases on both sides, signed in and signed out', () => {
    expect(fixture.cases.filter((c) => c.lastGood).length).toBeGreaterThanOrEqual(3);
    expect(fixture.cases.filter((c) => !c.lastGood).length).toBeGreaterThanOrEqual(5);
    expect(fixture.cases.filter((c) => c.currentUserId).length).toBeGreaterThanOrEqual(2);
  });

  it.each(fixture.cases)('$name', ({ currentUserId, query, lastGood }) => {
    const key = lastGoodKey({ currentUserId }, query);
    expect(key !== undefined).toBe(lastGood);
    if (lastGood) expect(key).toBe(query);
  });

  it.each(fixture.uncacheableParams)('an anonymous query with %s alone has no key', (p) => {
    expect(lastGoodKey({ currentUserId: null }, `levels=1&${p}=1`)).toBeUndefined();
  });
});
