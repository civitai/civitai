import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { coverAspectWarning } from '../announcements';

describe('coverAspectWarning', () => {
  it('says nothing about a square cover', () => {
    expect(coverAspectWarning(1024, 1024)).toBeNull();
  });

  it('says nothing when the dimensions are unknown', () => {
    expect(coverAspectWarning(null, null)).toBeNull();
    expect(coverAspectWarning(1024, undefined)).toBeNull();
    expect(coverAspectWarning(0, 0)).toBeNull();
  });

  it('tolerates a few pixels of rounding', () => {
    expect(coverAspectWarning(1024, 1010)).toBeNull();
  });

  it('names the edge a landscape cover loses, with its real size', () => {
    const warning = coverAspectWarning(1920, 1080);
    expect(warning).toContain('1920');
    expect(warning).toContain('1080');
    expect(warning).toContain('sides');
  });

  it('names the edge a portrait cover loses', () => {
    expect(coverAspectWarning(1080, 1920)).toContain('top and bottom');
  });
});

describe('CoverField', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../../routes/(app)/announcements/CoverField.svelte', import.meta.url)),
    'utf8'
  );

  // Fails closed: an unreadable or renamed file makes the assertions below meaningless, so assert
  // the read landed before asserting anything about its contents.
  it('reads the field it is asserting about', () => {
    expect(source).toContain('uploadCover');
  });

  // Both assert the RENDERED markup, not the import: an import survives deleting the element that
  // uses it, which is exactly the regression that would drop the guidance from the form.
  it('renders the aspect guidance', () => {
    expect(source).toContain('{COVER_ASPECT_LABEL}');
  });

  it('renders the non-square warning', () => {
    expect(source).toContain('{aspectWarning}<');
  });
});
