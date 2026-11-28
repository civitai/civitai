import { describe, expect, it } from 'vitest';

import { firstDiffPath } from '~/utils/faro/shadowCompareDiff';

/**
 * `firstDiffPath` names where two response texts first differ, keys and indices only. Expected
 * paths are literals: a walk that drops a segment, counts an index wrong or reports the wrong side
 * cannot reproduce them. Field names and values are pairwise distinct across each fixture so a path
 * cannot land on the right string by visiting the wrong node. Every key a test expects spelled out is
 * one of `REPORTABLE_KEYS`; any other key is reported as `*`.
 */

const envelope = (json: unknown) => JSON.stringify({ result: { data: { json } } });

describe('firstDiffPath', () => {
  it('a scalar change in a nested object: the full key path, kind value', () => {
    expect(
      firstDiffPath(
        envelope({ user: { cosmetic: { nsfwLevel: 31 } }, nextCursor: 'c-77' }),
        envelope({ user: { cosmetic: { nsfwLevel: 32 } }, nextCursor: 'c-77' })
      )
    ).toEqual({ path: '$.result.data.json.user.cosmetic.nsfwLevel', kind: 'value' });
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
        JSON.stringify({ stats: { likeCountAllTime: 9, viewCountAllTime: 41 } }),
        JSON.stringify({ stats: { likeCountAllTime: 9 } })
      )
    ).toEqual({ path: '$.stats.viewCountAllTime', kind: 'missing_in_candidate' });
    expect(
      firstDiffPath(
        JSON.stringify({ stats: { likeCountAllTime: 9 } }),
        JSON.stringify({ stats: { likeCountAllTime: 9, commentCountAllTime: 3 } })
      )
    ).toEqual({ path: '$.stats.commentCountAllTime', kind: 'extra_in_candidate' });
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
    expect(firstDiffPath('{"imageCount":5}', '{"imageCount":"5"}')).toEqual({
      path: '$.imageCount',
      kind: 'type',
    });
    expect(firstDiffPath('{"cosmetic":{"width":2}}', '{"cosmetic":null}')).toEqual({
      path: '$.cosmetic',
      kind: 'type',
    });
    expect(firstDiffPath('{"tags":[]}', '{"tags":{}}')).toEqual({ path: '$.tags', kind: 'type' });
  });

  it('the same keys in another order: kind key_order at the object', () => {
    expect(
      firstDiffPath(
        '{"hiddenMetrics":{"buzz":1,"downloads":2},"rank":0}',
        '{"hiddenMetrics":{"downloads":2,"buzz":1},"rank":0}'
      )
    ).toEqual({ path: '$.hiddenMetrics', kind: 'key_order' });
  });

  it('structurally equal texts that still differ in bytes: kind encoding at the root', () => {
    expect(firstDiffPath('{"score":1.0}', '{"score":1}')).toEqual({ path: '$', kind: 'encoding' });
    expect(firstDiffPath('{"name":"a"}', '{ "name": "a" }')).toEqual({
      path: '$',
      kind: 'encoding',
    });
  });

  it('-0 against 0 is a value difference at its path, not encoding (JSON.parse keeps -0)', () => {
    expect(firstDiffPath('{"score":-0}', '{"score":0}')).toEqual({
      path: '$.score',
      kind: 'value',
    });
  });

  it('a text that is not JSON: kind unparseable', () => {
    expect(firstDiffPath('{"locked":true}', '<html>Bad gateway</html>')).toEqual({
      path: '$',
      kind: 'unparseable',
    });
  });

  it('a key off the allowlist is reported as *, never spelled, even when it looks like a field name', () => {
    expect(
      firstDiffPath(
        JSON.stringify({ meta: { 'zed@example': { width: 1 } } }),
        JSON.stringify({ meta: { 'zed@example': { width: 2 } } })
      )
    ).toEqual({ path: '$.meta.*.width', kind: 'value' });
    // Shaped exactly like a field name (the old mask spelled such a key out), but a user chose it.
    expect(
      firstDiffPath(
        JSON.stringify({ meta: { my_private_tag: 'a' } }),
        JSON.stringify({ meta: { my_private_tag: 'b' } })
      )
    ).toEqual({ path: '$.meta.*', kind: 'value' });
    expect(
      firstDiffPath(
        JSON.stringify({ items: [{}] }),
        JSON.stringify({ items: [{ 'items.0.x': 1 }] })
      )
    ).toEqual({ path: '$.items[0].*', kind: 'extra_in_candidate' });
  });

  it('a known field name is still spelled out', () => {
    expect(
      firstDiffPath(
        JSON.stringify({ items: [{ stats: { heartCountAllTime: 4 } }] }),
        JSON.stringify({ items: [{ stats: { heartCountAllTime: 5 } }] })
      )
    ).toEqual({ path: '$.items[0].stats.heartCountAllTime', kind: 'value' });
  });

  describe('budget', () => {
    const nest = (depth: number, leaf: number): unknown =>
      depth === 0 ? leaf : { data: nest(depth - 1, leaf) };

    it('stops at the depth budget, reporting where it stopped', () => {
      // The difference is 10 levels down; a walk without a depth bound reports kind value there.
      const budget = { maxDepth: 3, maxNodes: 1000, maxTextLength: 10_000 };
      expect(
        firstDiffPath(JSON.stringify(nest(10, 1)), JSON.stringify(nest(10, 2)), budget)
      ).toEqual({ path: '$.data.data.data.data', kind: 'budget' });
      // Control: with room, the same pair resolves to the value at the bottom.
      expect(
        firstDiffPath(JSON.stringify(nest(10, 1)), JSON.stringify(nest(10, 2)), {
          ...budget,
          maxDepth: 40,
        })
      ).toEqual({
        path: '$.data.data.data.data.data.data.data.data.data.data',
        kind: 'value',
      });
    });

    it('stops at the node budget, reporting where it stopped', () => {
      const tagIds = Array.from({ length: 50 }, (_, i) => i);
      const changed = tagIds.map((x) => (x === 40 ? -40 : x));
      // Nodes visited: the root, `tagIds`, then one per element, so the 8th node is tagIds[5].
      const budget = { maxDepth: 40, maxNodes: 7, maxTextLength: 10_000 };
      expect(
        firstDiffPath(JSON.stringify({ tagIds }), JSON.stringify({ tagIds: changed }), budget)
      ).toEqual({ path: '$.tagIds[5]', kind: 'budget' });
      // Control: with room, the same pair resolves to the real difference.
      expect(
        firstDiffPath(JSON.stringify({ tagIds }), JSON.stringify({ tagIds: changed }), {
          ...budget,
          maxNodes: 1000,
        })
      ).toEqual({ path: '$.tagIds[40]', kind: 'value' });
    });

    it('does not parse a text over the size budget', () => {
      const big = JSON.stringify({ description: 'x'.repeat(500) });
      const budget = { maxDepth: 40, maxNodes: 1000, maxTextLength: 300 };
      expect(firstDiffPath(big, '{"description":"y"}', budget)).toEqual({
        path: '$',
        kind: 'budget',
      });
      expect(firstDiffPath('{"description":"y"}', big, budget)).toEqual({
        path: '$',
        kind: 'budget',
      });
      // Control: under the size budget the same shape is walked.
      expect(firstDiffPath('{"description":"x"}', '{"description":"y"}', budget)).toEqual({
        path: '$.description',
        kind: 'value',
      });
    });
  });
});
