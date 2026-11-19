import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { OWNER_HIDDEN_REVIEWS } from '@civitai/shared/owner-hidden-reviews';

// feed-go (Go) and the event engine cannot import @civitai/shared, so their copies of the owner-hidden
// review list are pinned to it here.
const ROOT = path.resolve(__dirname, '../..');
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const sorted = (values: string[]) => [...values].sort();

const sqlLists = (source: string) =>
  [...source.matchAll(/"needsReview" NOT IN \(([^)]*)\)/g)].map((match) =>
    sorted(match[1].split(',').map((value) => value.trim().replace(/^'|'$/g, '')))
  );

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
    const line = read('apps/feed-go/internal/feed/query.go')
      .split('\n')
      .find((text) => text.includes('i."needsReview" NOT IN ('));
    expect(line).toBeDefined();
    const bound = [
      ...line!
        .split('NOT IN (')[1]
        .split('`))')[0]
        .matchAll(/a\.add\("([^"]+)"\)/g),
    ].map((match) => match[1]);
    expect(sorted(bound)).toEqual(sorted(OWNER_HIDDEN_REVIEWS));
  });
});
