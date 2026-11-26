import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { strikeOwnersOffered } from '../strike-offer';

/** The remove flow offers "strike the owners" unless the selection holds a service review image. */

describe('strikeOwnersOffered', () => {
  const reviewImageIds = new Set<string | number>([10]);

  it('offers it for ordinary images (control)', () => {
    expect(strikeOwnersOffered({ strike: true, selected: [11, 12], reviewImageIds })).toBe(true);
  });

  it('withholds it when a review image is selected', () => {
    expect(strikeOwnersOffered({ strike: true, selected: [11, 10], reviewImageIds })).toBe(false);
  });

  it('withholds it from a moderator who may not strike', () => {
    expect(strikeOwnersOffered({ strike: false, selected: [11] })).toBe(false);
  });
});

describe('the bar and its hosts use it', () => {
  const src = (file: string) =>
    readFileSync(path.resolve(import.meta.dirname, '..', '..', file), 'utf8');

  it('renders the strike row only when offered', () => {
    const bar = src('lib/components/ImageActionBar.svelte');
    expect(bar).toContain('strikeOwnersOffered({ strike, selected, reviewImageIds })');
    const gate = bar.indexOf('{#if strikeOffered}');
    expect(gate).toBeGreaterThan(-1);
    expect(bar.indexOf('name="strikeOwners"')).toBeGreaterThan(gate);
    expect(bar).not.toContain('{#if strike}');
  });

  it.each([
    'lib/components/report-queue/ImageEvidence.svelte',
    'routes/reports/user/SuspectPanel.svelte',
    'routes/retool/bulk-image-manager/+page.svelte',
  ])('%s passes its review image ids', (file) => {
    expect(src(file)).toMatch(/<ImageActionBar(?:(?!\/>)[\s\S])*\{reviewImageIds\}/);
  });
});
