import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Audit from '~/utils/metadata/audit';
import type * as AuditBase from '~/utils/metadata/audit-base';

// The detectors have their own tests; here each one answers yes for one marker word, so what is
// under test is the composition: which text each detector reads, the order, and the POI switch.
const seen = vi.hoisted(() => ({
  illegal: [] as string[],
  poi: [] as string[],
  blocked: [] as string[],
}));

vi.mock('~/utils/metadata/audit', async (importOriginal) => ({
  ...(await importOriginal<typeof Audit>()),
  includesInappropriate: ({ prompt }: { prompt: string }) => {
    seen.illegal.push(prompt);
    return prompt.includes('ILLEGAL') ? 'minor' : false;
  },
  includesPoi: (prompt: string) => {
    seen.poi.push(prompt);
    return prompt.includes('PERSON');
  },
}));
vi.mock('~/utils/metadata/audit-base', async (importOriginal) => ({
  ...(await importOriginal<typeof AuditBase>()),
  getBlockedNsfwWords: (text: string) => {
    seen.blocked.push(text);
    return text.includes('BLOCKED') ? ['BLOCKED'] : [];
  },
}));

import { getSearchRefusal } from '~/components/Search/search-refusal';

const refusal = (text: string, disablePoi = true, auditedText = text) =>
  getSearchRefusal({ text, auditedText, disablePoi });

describe('getSearchRefusal', () => {
  beforeEach(() => {
    seen.illegal = [];
    seen.poi = [];
    seen.blocked = [];
  });

  it('lets a clean search run', () => {
    expect(refusal('red dragon')).toBeUndefined();
  });

  it('refuses each kind of search', () => {
    expect(refusal('ILLEGAL')).toBe('illegal');
    expect(refusal('PERSON')).toBe('poi');
    expect(refusal('BLOCKED')).toBe('blocked-words');
  });

  it('refuses a real person only when the viewer has turned them off', () => {
    expect(refusal('PERSON', true)).toBe('poi');
    expect(refusal('PERSON', false)).toBeUndefined();
  });

  it('names the illegal refusal first, whatever else the search also is', () => {
    expect(refusal('ILLEGAL PERSON BLOCKED')).toBe('illegal');
  });

  it('reads the whitelisted text for illegal and POI, the raw text for blocked words', () => {
    refusal('raw text', true, 'audited text');
    expect(seen.illegal).toEqual(['audited text']);
    expect(seen.poi).toEqual(['audited text']);
    expect(seen.blocked).toEqual(['raw text']);
  });
});
