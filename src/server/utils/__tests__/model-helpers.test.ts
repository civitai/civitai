import { describe, it, expect } from 'vitest';
import { resolveActiveFile, selectLiveLinkedComponents } from '~/server/utils/model-helpers';

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

describe('resolveActiveFile', () => {
  const pruned = { id: 10, type: 'Model', metadata: { format: 'SafeTensor', size: 'pruned' } };
  const full = { id: 20, type: 'Model', metadata: { format: 'SafeTensor', size: 'full' } };
  const files = [pruned, full] as Parameters<typeof resolveActiveFile>[0];

  it('returns the explicitly selected file even when preferences point elsewhere', () => {
    // `pruned` is what the preferences would pick, so a helper that ignored the
    // selection would still return a file — and silently the wrong one.
    expect(resolveActiveFile(files, full.id, { metadata: { size: 'pruned' } })).toBe(full);
    expect(resolveActiveFile(files, pruned.id, { metadata: { size: 'full' } })).toBe(pruned);
  });

  it('falls back to the preference-matched file when nothing is selected', () => {
    expect(resolveActiveFile(files, null, { metadata: { size: 'full' } })).toBe(full);
    expect(resolveActiveFile(files, undefined, { metadata: { size: 'pruned' } })).toBe(pruned);
  });

  it('ignores an id that belongs to another version instead of blanking out', () => {
    expect(resolveActiveFile(files, 999, { metadata: { size: 'full' } })).toBe(full);
  });

  it('returns null when there are no files to choose from', () => {
    expect(resolveActiveFile([], 10)).toBeNull();
  });
});
