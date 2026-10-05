import { describe, expect, it } from 'vitest';
import { excludedReactorFilter } from '~/shared/utils/excluded-reactor-filter';

// Only the non-empty path is reached through the job tests; these two branches are not.
// The throw matters most: this builds SQL TEXT, so an id it cannot vouch for must stop the
// query rather than be dropped — dropping it would keep counting that user's reactions.
describe('excludedReactorFilter', () => {
  it('emits nothing for an empty list, so the query is valid and unfiltered', () => {
    expect(excludedReactorFilter([])).toBe('');
  });

  it('emits the predicate against the reaction alias', () => {
    expect(excludedReactorFilter([7, 9])).toBe('AND r."userId" NOT IN (7,9)');
  });

  it.each([[[1.5]], [[Number.NaN]], [['1; DROP TABLE x' as unknown as number]]])(
    'refuses %j rather than splicing it into SQL',
    (ids) => {
      expect(() => excludedReactorFilter(ids)).toThrow('non-integer excluded user id');
    }
  );
});
