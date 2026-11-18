import { describe, expect, it } from 'vitest';
import { parseRebuildArgs } from './hidden-rebuild.service';

describe('parseRebuildArgs', () => {
  it('reads the flags and id lists', () => {
    expect(parseRebuildArgs(['--print-sql', '--exclude', '3,41', '--ids', '7'])).toEqual({
      apply: false,
      printSql: true,
      excludeImageIds: [3, 41],
      ids: [7],
    });
    expect(parseRebuildArgs([])).toEqual({
      apply: false,
      printSql: false,
      excludeImageIds: [],
      ids: null,
    });
  });

  it.each([
    [['--exclude=3,41']],
    [['--exclude', '3,', '41']],
    [['--exclude', '3, 41']],
    [['--exclude']],
    [['--exclude', '--apply']],
    [['--exclude', '3', 'stray']],
    [['--apply', '--print-sql']],
    [['--ids', '7']],
  ])('refuses %j rather than drop an id', (argv) => {
    expect(() => parseRebuildArgs(argv)).toThrow();
  });
});
