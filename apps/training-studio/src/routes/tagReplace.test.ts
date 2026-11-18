import { describe, expect, it } from 'vitest';
import {
  compileFind,
  groupTags,
  planReplace,
  prependTags,
  removeTag,
  renameTag,
  type ReplaceOptions,
} from './tagReplace';

const opts = (o: Partial<ReplaceOptions>): ReplaceOptions => ({
  find: '',
  replace: '',
  regex: false,
  matchCase: false,
  ...o,
});
const imgs = (...tags: string[][]) => tags.map((t, i) => ({ id: i + 1, tags: t }));
const ok = (p: ReturnType<typeof planReplace>) => {
  if (p.error !== null) throw new Error(p.error);
  return p;
};

describe('planReplace', () => {
  it('replaces plain text inside tags, case-insensitively by default, and skips untouched images', () => {
    const p = ok(
      planReplace(
        imgs(['red hair', 'smile'], ['Red Cap'], ['blue eyes'], []),
        opts({ find: 'red', replace: 'blue' })
      )
    );
    expect(p.changes.map((c) => [c.id, c.after])).toEqual([
      [1, ['blue hair', 'smile']],
      [2, ['blue Cap']],
    ]);
  });

  it('honors the case toggle', () => {
    const p = ok(
      planReplace(imgs(['Red', 'red']), opts({ find: 'red', replace: 'x', matchCase: true }))
    );
    expect(p.changes[0]!.after).toEqual(['Red', 'x']);
  });

  it('treats regex metacharacters and $ as literal text in plain mode', () => {
    const p = ok(planReplace(imgs(['a.b', 'axb']), opts({ find: 'a.b', replace: '$&!' })));
    expect(p.changes[0]!.after).toEqual(['$&!', 'axb']);
  });

  it('dedupes when the replace lands on a tag already present, keeping the first position', () => {
    const p = ok(
      planReplace(imgs(['girl', '1girl', 'solo']), opts({ find: '1girl', replace: 'girl' }))
    );
    expect(p.changes[0]!.after).toEqual(['girl', 'solo']);
  });

  it('splits a replacement containing commas into separate tags and dedupes them', () => {
    const p = ok(
      planReplace(imgs(['smile', 'blush']), opts({ find: 'smile', replace: 'blush, grin' }))
    );
    expect(p.changes[0]!.after).toEqual(['blush', 'grin']);
  });

  it('supports regex with capture groups', () => {
    const p = ok(
      planReplace(
        imgs(['hair_long', 'eyes_blue']),
        opts({ find: '(\\w+)_(\\w+)', replace: '$2 $1', regex: true })
      )
    );
    expect(p.changes[0]!.after).toEqual(['long hair', 'blue eyes']);
  });

  it('counts an image whose every tag is replaced with nothing as emptied', () => {
    const p = ok(planReplace(imgs(['x'], ['x', 'y'], ['y']), opts({ find: 'x', replace: '' })));
    expect(p.emptied).toBe(1);
    expect(p.changes.map((c) => [c.id, c.after])).toEqual([
      [1, []],
      [2, ['y']],
    ]);
  });

  it('never touches or counts unlabeled images', () => {
    const p = ok(planReplace(imgs([], ['a']), opts({ find: 'a', replace: 'b' })));
    expect(p.changes.map((c) => c.id)).toEqual([2]);
  });

  it('reports a replace that changes nothing as no change', () => {
    expect(ok(planReplace(imgs(['a']), opts({ find: 'a', replace: 'a' }))).changes).toEqual([]);
  });
});

describe('planReplace guards', () => {
  it('has nothing to do, and no error, for an empty find', () => {
    expect(planReplace(imgs(['a']), opts({ find: '' }))).toEqual({
      error: null,
      changes: [],
      emptied: 0,
    });
  });

  it('refuses an invalid regex with an inline message and no changes', () => {
    const p = planReplace(imgs(['a']), opts({ find: '(', regex: true }));
    expect(p.error).toMatch(/^Invalid pattern/);
    expect(p.changes).toEqual([]);
  });

  it('refuses a regex that matches empty text', () => {
    for (const find of ['a*', '^', '(?:)', 'x?']) {
      expect(planReplace(imgs(['a']), opts({ find, regex: true })).error).toMatch(/empty text/);
    }
  });

  it('refuses a zero-width pattern that only shows on a real tag', () => {
    for (const find of ['\\b', '(?=h)']) {
      const p = planReplace(imgs(['red hair']), opts({ find, replace: 'X', regex: true }));
      expect(p.error).toMatch(/empty text/);
      expect(p.changes).toEqual([]);
    }
  });

  it('does not count an image as affected when nothing in it matched, even with unnormalised tags', () => {
    const p = planReplace(imgs([' a', 'a, b', 'zzz']), opts({ find: 'q', replace: 'x' }));
    expect(p.error).toBeNull();
    expect(p.changes).toEqual([]);
  });

  it('accepts the same text in plain mode where it is not a pattern', () => {
    expect(compileFind(opts({ find: 'a*' })).error).toBeNull();
  });
});

describe('groupTags', () => {
  it('shows one row per tag across casings, named by the most-used casing, counting images not occurrences', () => {
    const groups = groupTags([
      { tags: ['orange hair', 'solo'] },
      { tags: ['Orange hair', 'solo'] },
      { tags: ['orange hair', 'Orange Hair'] },
      { tags: [] },
    ]);
    expect(groups).toEqual([
      { tag: 'orange hair', count: 3, variants: ['orange hair', 'Orange hair', 'Orange Hair'] },
      { tag: 'solo', count: 2, variants: ['solo'] },
    ]);
  });
});

describe('renameTag', () => {
  it('renames every casing in place', () => {
    expect(renameTag(['Orange hair', 'solo'], 'orange hair', ['ginger hair'])).toEqual([
      'ginger hair',
      'solo',
    ]);
  });
  it('renaming a group to its own name merges its casings into that casing, at the first position', () => {
    expect(
      renameTag(['Orange hair', 'solo', 'orange hair'], 'orange hair', ['orange hair'])
    ).toEqual(['orange hair', 'solo']);
  });
  it('leaves an image without the renamed tag alone, even when it carries the target in another casing', () => {
    const tags = ['Bar', 'solo'];
    expect(renameTag(tags, 'foo', ['bar'])).toBe(tags);
  });
  it('folds a rename target the image already carries in another casing into the typed casing', () => {
    expect(renameTag(['dress', 'skirt'], 'skirt', ['Dress'])).toEqual(['Dress']);
  });
});

describe('removeTag / prependTags', () => {
  it('remove takes every casing off', () => {
    expect(removeTag(['Smile', 'solo', 'smile'], 'smile')).toEqual(['solo']);
  });
  it('add skips an image that already has the tag in another casing', () => {
    const tags = ['Mychar', 'solo'];
    expect(prependTags(tags, ['mychar'])).toBe(tags);
    expect(prependTags(['solo'], ['mychar', 'MyChar'])).toEqual(['mychar', 'solo']);
  });
});
