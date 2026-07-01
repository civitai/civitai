import { describe, it, expect } from 'vitest';
import { selectLiveLinkedComponents } from '~/server/utils/linked-component-helpers';

describe('selectLiveLinkedComponents', () => {
  const comps = [
    { fileId: 1, name: 'live' },
    { fileId: 2, name: 'deleted' },
    { fileId: undefined, name: 'no-file' },
  ];

  it('keeps only components whose fileId is in the live set', () => {
    const live = new Set([1]);
    expect(selectLiveLinkedComponents(comps, live)).toEqual([{ fileId: 1, name: 'live' }]);
  });

  it('drops everything when the live set is empty', () => {
    expect(selectLiveLinkedComponents(comps, new Set())).toEqual([]);
  });
});
