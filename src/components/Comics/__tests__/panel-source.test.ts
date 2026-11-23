import { describe, expect, it } from 'vitest';
import { candidateSlotsFromMetadata, isImportedPanel } from '~/components/Comics/panel-source';

describe('isImportedPanel', () => {
  it('reads an imported panel whose source url was withheld as imported', () => {
    expect(isImportedPanel(null, { hasSourceImage: true })).toBe(true);
  });

  it('reads a panel with no metadata and no prompt as imported', () => {
    expect(isImportedPanel('', null)).toBe(true);
  });

  it('reads a generated panel as not imported', () => {
    expect(isImportedPanel(null, { hasSourceImage: true, enhanceEnabled: true })).toBe(false);
    expect(isImportedPanel(null, { hasSourceImage: false })).toBe(false);
    expect(isImportedPanel('a prompt', { hasSourceImage: true })).toBe(false);
  });
});

describe('candidateSlotsFromMetadata', () => {
  it('leaves out an entry with no key that is not locked', () => {
    expect(
      candidateSlotsFromMetadata([
        { nsfwLevel: 1 },
        '',
        { key: '', nsfwLevel: 1 },
        { key: 'k', nsfwLevel: 1 },
        'plain',
        { requiresUnlock: true, nsfwLevel: 8 },
      ])
    ).toEqual([
      { key: 'k', nsfwLevel: 1 },
      { key: 'plain', nsfwLevel: null },
      { requiresUnlock: true, blockedReason: 'canUpgrade', nsfwLevel: 8 },
    ]);
  });

  it('reads no stored candidates as none', () => {
    expect(candidateSlotsFromMetadata(undefined)).toBeNull();
  });
});
