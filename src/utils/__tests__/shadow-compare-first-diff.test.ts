import { describe, expect, it } from 'vitest';

import { firstDiffPath } from '~/utils/faro/shadowCompareDiff';

/**
 * `firstDiffPath` names where two response texts first differ, keys and indices only. Expected
 * paths are literals: a walk that drops a segment, counts an index wrong or reports the wrong side
 * cannot reproduce them. Field names and values are pairwise distinct across each fixture so a path
 * cannot land on the right string by visiting the wrong node.
 */

const envelope = (json: unknown) => JSON.stringify({ result: { data: { json } } });

describe('firstDiffPath', () => {
  it('a scalar change in a nested object: the full key path, kind value', () => {
    expect(
      firstDiffPath(
        envelope({ owner: { profile: { level: 31 } }, cursor: 'c-77' }),
        envelope({ owner: { profile: { level: 32 } }, cursor: 'c-77' })
      )
    ).toEqual({ path: '$.result.data.json.owner.profile.level', kind: 'value' });
  });

  it('a change inside an array element: the index is in the path', () => {
    const items = [
      { id: 101, nsfwLevel: 1 },
      { id: 202, nsfwLevel: 2 },
      { id: 303, nsfwLevel: 4 },
    ];
    const changed = [items[0], items[1], { id: 303, nsfwLevel: 8 }];
    expect(firstDiffPath(envelope({ items }), envelope({ items: changed }))).toEqual({
      path: '$.result.data.json.items[2].nsfwLevel',
      kind: 'value',
    });
  });

  it('two differences: the first in the control text is reported', () => {
    const control = { items: [5, 6, 7, 8] };
    const candidate = { items: [5, 60, 7, 80] };
    expect(firstDiffPath(JSON.stringify(control), JSON.stringify(candidate))).toEqual({
      path: '$.items[1]',
      kind: 'value',
    });
  });

  it('a key the candidate lacks, and one only the candidate has', () => {
    expect(
      firstDiffPath(
        JSON.stringify({ stats: { likes: 9, views: 41 } }),
        JSON.stringify({ stats: { likes: 9 } })
      )
    ).toEqual({ path: '$.stats.views', kind: 'missing_in_candidate' });
    expect(
      firstDiffPath(
        JSON.stringify({ stats: { likes: 9 } }),
        JSON.stringify({ stats: { likes: 9, shares: 3 } })
      )
    ).toEqual({ path: '$.stats.shares', kind: 'extra_in_candidate' });
  });

  it('an array the candidate cut short, and one it extended', () => {
    expect(
      firstDiffPath(JSON.stringify({ tags: [11, 12, 13] }), JSON.stringify({ tags: [11, 12] }))
    ).toEqual({ path: '$.tags[2]', kind: 'missing_in_candidate' });
    expect(
      firstDiffPath(JSON.stringify({ tags: [11] }), JSON.stringify({ tags: [11, 12, 13] }))
    ).toEqual({ path: '$.tags[1]', kind: 'extra_in_candidate' });
  });

  it('a type change: number vs string, object vs null, array vs object', () => {
    expect(firstDiffPath('{"count":5}', '{"count":"5"}')).toEqual({
      path: '$.count',
      kind: 'type',
    });
    expect(firstDiffPath('{"cover":{"w":2}}', '{"cover":null}')).toEqual({
      path: '$.cover',
      kind: 'type',
    });
    expect(firstDiffPath('{"list":[]}', '{"list":{}}')).toEqual({ path: '$.list', kind: 'type' });
  });

  it('the same keys in another order: kind key_order at the object', () => {
    expect(
      firstDiffPath('{"meta":{"alpha":1,"beta":2},"z":0}', '{"meta":{"beta":2,"alpha":1},"z":0}')
    ).toEqual({ path: '$.meta', kind: 'key_order' });
  });

  it('structurally equal texts that still differ in bytes: kind encoding at the root', () => {
    expect(firstDiffPath('{"ratio":1.0}', '{"ratio":1}')).toEqual({ path: '$', kind: 'encoding' });
    expect(firstDiffPath('{"q":"a"}', '{ "q": "a" }')).toEqual({ path: '$', kind: 'encoding' });
  });

  it('a text that is not JSON: kind unparseable', () => {
    expect(firstDiffPath('{"ok":true}', '<html>Bad gateway</html>')).toEqual({
      path: '$',
      kind: 'unparseable',
    });
  });

  it('a key that does not look like a field name is reported as *, never spelled', () => {
    expect(
      firstDiffPath(
        JSON.stringify({ byUser: { 'zed@example': { n: 1 } } }),
        JSON.stringify({ byUser: { 'zed@example': { n: 2 } } })
      )
    ).toEqual({ path: '$.byUser.*.n', kind: 'value' });
    expect(
      firstDiffPath(
        JSON.stringify({ items: [{}] }),
        JSON.stringify({ items: [{ 'items.0.x': 1 }] })
      )
    ).toEqual({ path: '$.items[0].*', kind: 'extra_in_candidate' });
  });

  describe('budget', () => {
    const nest = (depth: number, leaf: number): unknown =>
      depth === 0 ? leaf : { down: nest(depth - 1, leaf) };

    it('stops at the depth budget, reporting where it stopped', () => {
      // The difference is 10 levels down; a walk without a depth bound reports kind value there.
      const budget = { maxDepth: 3, maxNodes: 1000, maxTextLength: 10_000 };
      expect(
        firstDiffPath(JSON.stringify(nest(10, 1)), JSON.stringify(nest(10, 2)), budget)
      ).toEqual({ path: '$.down.down.down.down', kind: 'budget' });
      // Control: with room, the same pair resolves to the value at the bottom.
      expect(
        firstDiffPath(JSON.stringify(nest(10, 1)), JSON.stringify(nest(10, 2)), {
          ...budget,
          maxDepth: 40,
        })
      ).toEqual({
        path: '$.down.down.down.down.down.down.down.down.down.down',
        kind: 'value',
      });
    });

    it('stops at the node budget, reporting where it stopped', () => {
      const xs = Array.from({ length: 50 }, (_, i) => i);
      const changed = xs.map((x) => (x === 40 ? -40 : x));
      // Nodes visited: the root, `xs`, then one per element, so the 8th node is xs[5].
      const budget = { maxDepth: 40, maxNodes: 7, maxTextLength: 10_000 };
      expect(
        firstDiffPath(JSON.stringify({ xs }), JSON.stringify({ xs: changed }), budget)
      ).toEqual({ path: '$.xs[5]', kind: 'budget' });
      // Control: with room, the same pair resolves to the real difference.
      expect(
        firstDiffPath(JSON.stringify({ xs }), JSON.stringify({ xs: changed }), {
          ...budget,
          maxNodes: 1000,
        })
      ).toEqual({ path: '$.xs[40]', kind: 'value' });
    });

    it('does not parse a text over the size budget', () => {
      const big = JSON.stringify({ blob: 'x'.repeat(500) });
      const budget = { maxDepth: 40, maxNodes: 1000, maxTextLength: 300 };
      expect(firstDiffPath(big, '{"blob":"y"}', budget)).toEqual({ path: '$', kind: 'budget' });
      expect(firstDiffPath('{"blob":"y"}', big, budget)).toEqual({ path: '$', kind: 'budget' });
      // Control: under the size budget the same shape is walked.
      expect(firstDiffPath('{"blob":"x"}', '{"blob":"y"}', budget)).toEqual({
        path: '$.blob',
        kind: 'value',
      });
    });
  });
});
