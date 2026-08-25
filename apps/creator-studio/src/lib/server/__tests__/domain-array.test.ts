import { describe, it, expect } from 'vitest';
import { DOMAIN_LABELS, toDomainArray } from '$lib/announcements';

describe('toDomainArray', () => {
  it('parses the raw Postgres literal pg hands back for an unparsed enum array', () => {
    // The bug this exists for: `[...new Set('{green,blue}')]` is ten single-character chips.
    expect(toDomainArray('{green,blue}')).toEqual(['green', 'blue']);
  });

  it('parses a single-element literal', () => {
    expect(toDomainArray('{all}')).toEqual(['all']);
  });

  it('yields nothing for an empty literal', () => {
    expect(toDomainArray('{}')).toEqual([]);
  });

  it('passes a real array through, deduped', () => {
    expect(toDomainArray(['green', 'blue', 'green'])).toEqual(['green', 'blue']);
  });

  it('yields nothing for null or undefined', () => {
    expect(toDomainArray(null)).toEqual([]);
    expect(toDomainArray(undefined)).toEqual([]);
  });

  it('never returns a value longer than the number of domains that exist', () => {
    // A structural guard on the failure mode itself: any character-wise reading of a literal
    // produces more entries than there are DomainColor values, whatever the spelling.
    const parsed = toDomainArray('{green,blue}');

    expect(parsed.length).toBeLessThanOrEqual(Object.keys(DOMAIN_LABELS).length);
    expect(parsed.every((entry) => entry in DOMAIN_LABELS)).toBe(true);
  });
});

describe('domain labels name the site, not the colour', () => {
  it('renders the two pickable domains as their hosts', () => {
    expect(DOMAIN_LABELS.green.label).toBe('civitai.com');
    expect(DOMAIN_LABELS.blue.label).toBe('civitai.red');
  });

  it('never shows a raw colour name to a creator', () => {
    const labels = Object.values(DOMAIN_LABELS).map((entry) => entry.label);

    expect(labels).not.toContain('green');
    expect(labels).not.toContain('blue');
  });
});
