import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

// Beside the rail the content column is capped at 1320px, which fits only three 320px masonry
// columns at every viewport width, so Suggested Resources stops scaling with the screen there.
const pageSource = readFileSync(
  resolve(__dirname, '../../../pages/models/[id]/[[...slug]].tsx'),
  'utf8'
);

function indexOfUnique(needle: string) {
  const first = pageSource.indexOf(needle);
  expect(first, `${needle} not found in the model page`).toBeGreaterThan(-1);
  expect(pageSource.indexOf(needle, first + 1), `${needle} appears more than once`).toBe(-1);
  return first;
}

describe('model page: Suggested Resources and Discussion render full width, below the rail region', () => {
  const railEnd = indexOfUnique('className={classes.rail}');

  it.each(['<AssociatedModels', '<ModelDiscussion'])(
    '%s renders after the rail region closes',
    (tag) => {
      expect(indexOfUnique(tag), `${tag} is inside the 1320px rail column`).toBeGreaterThan(
        railEnd
      );
    }
  );
});
