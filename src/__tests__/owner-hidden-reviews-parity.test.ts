import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { OWNER_HIDDEN_REVIEWS } from '@civitai/shared/owner-hidden-reviews';
import { IMAGE_REVIEW_PRECEDENCE } from '@civitai/shared/image-review-types';
import { IMAGE_SAFETY_CONDITION } from '~/server/services/personal-data-export/sources/postgres';

// feed-go (Go) cannot import @civitai/shared, so its copies of the owner-hidden review list are pinned
// to it here. The personal-data export builds its list from the constant; its check below fails if
// that is ever replaced by a hand-written list.
const ROOT = path.resolve(__dirname, '../..');
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const sorted = (values: string[]) => [...values].sort();

const sqlLists = (source: string) =>
  [...source.matchAll(/"needsReview" NOT IN \(([^)]*)\)/g)].map((match) =>
    sorted(match[1].split(',').map((value) => value.trim().replace(/^'|'$/g, '')))
  );

const NOT_IN = '"needsReview" NOT IN (';

/**
 * The values each `"needsReview" NOT IN (` in Go source binds with `a.add("…")`, read up to the
 * matching `)` however the expression is wrapped. The Go calls inside it balance their own parens.
 */
const boundLists = (source: string) => {
  const lists: string[][] = [];
  for (let at = source.indexOf(NOT_IN); at >= 0; at = source.indexOf(NOT_IN, at + 1)) {
    let depth = 1;
    let end = at + NOT_IN.length;
    for (; end < source.length && depth > 0; end++) {
      if (source[end] === '(') depth++;
      else if (source[end] === ')') depth--;
    }
    const body = source.slice(at + NOT_IN.length, end - 1);
    lists.push(sorted([...body.matchAll(/a\.add\("([^"]+)"\)/g)].map((match) => match[1])));
  }
  return lists;
};

it('every owner-hidden review is a review type the account restore can put back or keep', () => {
  expect(IMAGE_REVIEW_PRECEDENCE).toEqual(expect.arrayContaining(OWNER_HIDDEN_REVIEWS));
});

describe('copies of the owner-hidden review list', () => {
  it.each(['apps/feed-go/internal/hydrate/users.go'])(
    '%s holds exactly the shared list',
    (file) => {
      const lists = sqlLists(read(file));
      expect(lists.length).toBeGreaterThan(0);
      for (const list of lists) expect(list).toEqual(sorted(OWNER_HIDDEN_REVIEWS));
    }
  );

  it('apps/feed-go/internal/feed/query.go binds exactly the shared list', () => {
    const lists = boundLists(read('apps/feed-go/internal/feed/query.go'));
    expect(lists.length).toBeGreaterThan(0);
    for (const list of lists) expect(list).toEqual(sorted(OWNER_HIDDEN_REVIEWS));
  });

  it('reads a bound list that is wrapped over several lines', () => {
    const wrapped = [
      'return `(i."needsReview" IS NULL OR i."needsReview" NOT IN (` +',
      '\ta.add("csam") + `, ` +',
      '\ta.add("minor") + `) OR ` + own() + `)`',
    ].join('\n');
    expect(boundLists(wrapped)).toEqual([['csam', 'minor']]);
  });

  it('the personal-data export excludes exactly the shared list', () => {
    const lists = [
      ...IMAGE_SAFETY_CONDITION.matchAll(/COALESCE\("Image"\."needsReview", ''\) IN \(([^)]*)\)/g),
    ].map((match) => sorted(match[1].split(',').map((v) => v.trim().replace(/^'|'$/g, ''))));
    expect(lists).toEqual([sorted(OWNER_HIDDEN_REVIEWS)]);
  });
});
