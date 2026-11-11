import { describe, expect, it } from 'vitest';
import { expandVersions, idFilter } from '../oneoffs/rescan-unread-pickle-files.lib';

describe('the rescan id filter', () => {
  it('refuses file ids and version ids together', () => {
    expect(() => idFilter('1,2', '3')).toThrow('not both');
  });

  it.each(['1,,2', '1,x', '0', '-4'])('refuses the id list %s', (value) => {
    expect(() => idFilter(undefined, value)).toThrow('positive ids');
  });

  it('reads each list once per id', () => {
    expect(idFilter(undefined, '3,3,4')).toEqual({ versionIds: [3, 4] });
    expect(idFilter('5')).toEqual({ fileIds: [5] });
    expect(idFilter()).toEqual({});
  });
});

describe('expanding versions to files', () => {
  it("takes every asked version's files and names the versions with none", () => {
    const files = [
      { id: 10, modelVersionId: 1 },
      { id: 11, modelVersionId: 1 },
      { id: 20, modelVersionId: 2 },
    ];

    expect(expandVersions([1, 2, 3], files)).toEqual({
      fileIds: [10, 11, 20],
      versionsWithoutFiles: [3],
    });
  });

  it('takes no file of a version it was not asked for', () => {
    expect(expandVersions([2], [{ id: 10, modelVersionId: 1 }]).fileIds).toEqual([]);
  });
});
