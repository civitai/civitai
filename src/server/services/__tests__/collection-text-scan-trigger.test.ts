import { describe, expect, it } from 'vitest';
const { shouldScanCollection } = await import('~/server/services/text-scan/actions/collection');

const c = (
  o: Partial<{ name: string; description: string | null; read: string; availability: string }>
) => ({
  name: 'a',
  description: null,
  read: 'Public',
  availability: 'Public',
  ...o,
});

describe('shouldScanCollection', () => {
  it('scans a new visible collection', () => expect(shouldScanCollection(null, c({}))).toBe(true));
  it('skips private', () => expect(shouldScanCollection(null, c({ read: 'Private' }))).toBe(false));
  it('scans Private → Public with unchanged text', () =>
    expect(shouldScanCollection(c({ read: 'Private' }), c({}))).toBe(true));
  it('scans a text edit', () => expect(shouldScanCollection(c({}), c({ name: 'b' }))).toBe(true));
  it('skips an edit that changed neither', () =>
    expect(shouldScanCollection(c({}), c({}))).toBe(false));
});
