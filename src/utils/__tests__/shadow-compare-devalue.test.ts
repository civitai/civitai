import { describe, expect, it } from 'vitest';

import { devalueAnswerDiff, firstDiffPath } from '~/utils/faro/shadowCompareDiff';

/**
 * `devalueAnswerDiff` compares two devalue tRPC answers by their decoded values. Each body below is
 * the literal output of `devalue.stringify` (the repo's devalue) inside tRPC's envelope; expected
 * paths and kinds are literals.
 */

const answer = (devalue: string) => JSON.stringify({ result: { data: devalue } });

// Two images by one creator. Node shares the `user` object between them (one devalue index, 5); a
// writer that repeats it writes it twice (indexes 5 and 14). Same value, other bytes.
const SHARED_USER =
  '[{"items":1,"nextCursor":14},[2,11],{"id":3,"createdAt":4,"user":5},4101,["Date","2026-11-20T08:00:00.000Z"],{"id":6,"username":7,"cosmetics":8},9,"artist_nine",[9],{"id":10},7,{"id":12,"createdAt":13,"user":5},4102,["Date","2026-11-21T08:00:00.000Z"],"n-88"]';
const REPEATED_USER =
  '[{"items":1,"nextCursor":17},[2,11],{"id":3,"createdAt":4,"user":5},4101,["Date","2026-11-20T08:00:00.000Z"],{"id":6,"username":7,"cosmetics":8},9,"artist_nine",[9],{"id":10},7,{"id":12,"createdAt":13,"user":14},4102,["Date","2026-11-21T08:00:00.000Z"],{"id":6,"username":7,"cosmetics":15},[16],{"id":10},"n-88"]';
// REPEATED_USER with items[1].id 41020.
const OTHER_ID =
  '[{"items":1,"nextCursor":17},[2,11],{"id":3,"createdAt":4,"user":5},4101,["Date","2026-11-20T08:00:00.000Z"],{"id":6,"username":7,"cosmetics":8},9,"artist_nine",[9],{"id":10},7,{"id":12,"createdAt":13,"user":14},41020,["Date","2026-11-21T08:00:00.000Z"],{"id":6,"username":7,"cosmetics":15},[16],{"id":10},"n-88"]';
// REPEATED_USER with items[1].createdAt one millisecond later.
const OTHER_DATE =
  '[{"items":1,"nextCursor":17},[2,11],{"id":3,"createdAt":4,"user":5},4101,["Date","2026-11-20T08:00:00.000Z"],{"id":6,"username":7,"cosmetics":8},9,"artist_nine",[9],{"id":10},7,{"id":12,"createdAt":13,"user":14},4102,["Date","2026-11-21T08:00:00.001Z"],{"id":6,"username":7,"cosmetics":15},[16],{"id":10},"n-88"]';
// REPEATED_USER with items[0]'s `user` written before its `createdAt`.
const OTHER_ORDER =
  '[{"items":1,"nextCursor":17},[2,11],{"id":3,"user":4,"createdAt":10},4101,{"id":5,"username":6,"cosmetics":7},9,"artist_nine",[8],{"id":9},7,["Date","2026-11-20T08:00:00.000Z"],{"id":12,"createdAt":13,"user":14},4102,["Date","2026-11-21T08:00:00.000Z"],{"id":5,"username":6,"cosmetics":15},[16],{"id":9},"n-88"]';
// REPEATED_USER with items[0].thumbnailUrl: undefined (a key the JSON text of superjson would drop).
const EXTRA_UNDEFINED =
  '[{"items":1,"nextCursor":17},[2,11],{"id":3,"createdAt":4,"user":5,"thumbnailUrl":-1},4101,["Date","2026-11-20T08:00:00.000Z"],{"id":6,"username":7,"cosmetics":8},9,"artist_nine",[9],{"id":10},7,{"id":12,"createdAt":13,"user":14},4102,["Date","2026-11-21T08:00:00.000Z"],{"id":6,"username":7,"cosmetics":15},[16],{"id":10},"n-88"]';

describe('devalueAnswerDiff', () => {
  it('two bodies of the same value in different bytes (a shared object vs a repeated one) are equal', () => {
    // Positive control: the texts differ, and a text walk can only name the whole data string.
    expect(answer(SHARED_USER)).not.toBe(answer(REPEATED_USER));
    expect(firstDiffPath(answer(SHARED_USER), answer(REPEATED_USER))).toEqual({
      path: '$.result.data',
      kind: 'value',
    });
    expect(devalueAnswerDiff(answer(SHARED_USER), answer(REPEATED_USER))).toBeNull();
    expect(devalueAnswerDiff(answer(REPEATED_USER), answer(SHARED_USER))).toBeNull();
  });

  it('a value difference: the decoded path and kind value', () => {
    expect(devalueAnswerDiff(answer(SHARED_USER), answer(OTHER_ID))).toEqual({
      path: '$.result.data.items[1].id',
      kind: 'value',
    });
  });

  it('a Date one millisecond apart: kind value at the Date', () => {
    expect(devalueAnswerDiff(answer(SHARED_USER), answer(OTHER_DATE))).toEqual({
      path: '$.result.data.items[1].createdAt',
      kind: 'value',
    });
  });

  it('the same keys in another order: kind key_order at that object', () => {
    expect(devalueAnswerDiff(answer(REPEATED_USER), answer(OTHER_ORDER))).toEqual({
      path: '$.result.data.items[0]',
      kind: 'key_order',
    });
  });

  it('a key holding undefined on one side only is reported, not dropped', () => {
    expect(devalueAnswerDiff(answer(REPEATED_USER), answer(EXTRA_UNDEFINED))).toEqual({
      path: '$.result.data.items[0].thumbnailUrl',
      kind: 'extra_in_candidate',
    });
    expect(devalueAnswerDiff(answer(EXTRA_UNDEFINED), answer(REPEATED_USER))).toEqual({
      path: '$.result.data.items[0].thumbnailUrl',
      kind: 'missing_in_candidate',
    });
  });

  it('a type change in the decoded value (a Date vs a string)', () => {
    const asString = REPEATED_USER.replace(
      '["Date","2026-11-20T08:00:00.000Z"]',
      '"2026-11-20T08:00:00.000Z"'
    );
    expect(asString).not.toBe(REPEATED_USER);
    expect(devalueAnswerDiff(answer(REPEATED_USER), answer(asString))).toEqual({
      path: '$.result.data.items[0].createdAt',
      kind: 'type',
    });
  });

  it('a key off the allowlist is reported as *', () => {
    expect(
      devalueAnswerDiff(answer('[{"zed@example":1},5]'), answer('[{"zed@example":1},6]'))
    ).toEqual({ path: '$.result.data.*', kind: 'value' });
  });

  it('a circular value decodes and compares without looping', () => {
    // `[{"self":0}]` is an object whose `self` is itself.
    expect(devalueAnswerDiff(answer('[{"self":0}]'), answer('[{"self":0}]'))).toBeNull();
  });

  it('NaN equals NaN; -0 is not 0', () => {
    // devalue's special indexes: -3 NaN, -6 negative zero.
    expect(devalueAnswerDiff(answer('[{"score":-3}]'), answer('[{"score":-3}]'))).toBeNull();
    // Control: NaN against a number is a difference.
    expect(devalueAnswerDiff(answer('[{"score":-3}]'), answer('[{"score":1},5]'))).toEqual({
      path: '$.result.data.score',
      kind: 'value',
    });
    expect(devalueAnswerDiff(answer('[{"score":-6}]'), answer('[{"score":1},0]'))).toEqual({
      path: '$.result.data.score',
      kind: 'value',
    });
  });

  it('not two devalue answers: undefined, so the texts are compared as before', () => {
    const superjson = '{"result":{"data":{"json":{"nextCursor":"n-88"}}}}';
    expect(devalueAnswerDiff(superjson, answer(SHARED_USER))).toBeUndefined();
    expect(devalueAnswerDiff(answer(SHARED_USER), superjson)).toBeUndefined();
    expect(devalueAnswerDiff(superjson, superjson)).toBeUndefined();
    // An envelope with anything beside result.data is not the devalue answer shape.
    expect(
      devalueAnswerDiff(
        JSON.stringify({ result: { data: SHARED_USER, type: 'data' } }),
        answer(SHARED_USER)
      )
    ).toBeUndefined();
    expect(devalueAnswerDiff('<html>Bad gateway</html>', answer(SHARED_USER))).toBeUndefined();
    // The same envelope written with whitespace is not the writers' bytes: compared as text.
    expect(
      devalueAnswerDiff(
        `{ "result": { "data": ${JSON.stringify(SHARED_USER)} } }`,
        answer(SHARED_USER)
      )
    ).toBeUndefined();
  });

  it('a data string devalue cannot decode: kind unparseable at $.result.data', () => {
    expect(devalueAnswerDiff(answer(SHARED_USER), answer('not devalue'))).toEqual({
      path: '$.result.data',
      kind: 'unparseable',
    });
  });

  describe('budget', () => {
    it('stops at the node budget, reporting where it stopped', () => {
      // Nodes visited: the root, `items`, items[0], its id, its createdAt, its user, the user's id,
      // so the 8th node is items[0].user.username.
      const budget = { maxDepth: 32, maxNodes: 7, maxTextLength: 10_000 };
      expect(devalueAnswerDiff(answer(SHARED_USER), answer(OTHER_ID), budget)).toEqual({
        path: '$.result.data.items[0].user.username',
        kind: 'budget',
      });
      // Control: with room, the same pair resolves to the real difference.
      expect(
        devalueAnswerDiff(answer(SHARED_USER), answer(OTHER_ID), { ...budget, maxNodes: 1000 })
      ).toEqual({ path: '$.result.data.items[1].id', kind: 'value' });
    });

    it('stops at the depth budget', () => {
      const budget = { maxDepth: 2, maxNodes: 1000, maxTextLength: 10_000 };
      expect(devalueAnswerDiff(answer(SHARED_USER), answer(OTHER_ID), budget)).toEqual({
        path: '$.result.data.items[0].id',
        kind: 'budget',
      });
    });

    it('a text over the size budget is not decoded', () => {
      const budget = { maxDepth: 32, maxNodes: 1000, maxTextLength: 300 };
      // 317 and 379 characters: both over.
      expect(answer(SHARED_USER).length).toBe(317);
      expect(devalueAnswerDiff(answer(SHARED_USER), answer(OTHER_ID), budget)).toBeUndefined();
    });
  });
});
