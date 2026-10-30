import { describe, expect, it } from 'vitest';
import { getRemixOptions, getSoleRemixOption } from '../remix.utils';
import type { RemixSourceImage } from '../remix.utils';
import { ImageIngestionStatus, MediaType } from '~/shared/utils/prisma/enums';

/** A scanned image with a prompt; each case is this minus or plus one property. */
function image(overrides: Partial<RemixSourceImage> = {}): RemixSourceImage {
  return {
    id: 1,
    url: 'abc-123',
    type: MediaType.image,
    nsfwLevel: 1,
    ingestion: ImageIngestionStatus.Scanned,
    hasPositivePrompt: true,
    ...overrides,
  };
}

describe('getRemixOptions', () => {
  it('offers edit, animate and reuse on an image with a prompt', () => {
    expect(getRemixOptions(image())).toEqual(['edit', 'video', 'reuse']);
  });

  it('offers only reuse on a video with a prompt', () => {
    expect(getRemixOptions(image({ type: MediaType.video }))).toEqual(['reuse']);
  });

  it('drops reuse when there is no prompt', () => {
    expect(getRemixOptions(image({ hasPositivePrompt: false, hasMeta: false }))).toEqual([
      'edit',
      'video',
    ]);
  });

  it('counts only what this viewer is offered: a refusal removes the kinds', () => {
    expect(getRemixOptions(image({ poi: true }))).toEqual(['reuse']);
  });

  it('counts nothing for a blocked image, whose reuse is refused too', () => {
    expect(getRemixOptions(image({ ingestion: ImageIngestionStatus.Blocked }))).toEqual([]);
  });
});

describe('getSoleRemixOption', () => {
  it('names the option when exactly one is offered', () => {
    expect(getSoleRemixOption(image({ type: MediaType.video }))).toBe('reuse');
  });

  it('names nothing when several are offered', () => {
    expect(getSoleRemixOption(image())).toBeUndefined();
  });

  it('names nothing when none is offered', () => {
    expect(getSoleRemixOption(image({ type: MediaType.video, hasPositivePrompt: false }))).toBe(
      undefined
    );
  });

  // The menu is where a refused viewer is told why the other options are missing.
  it('keeps the menu when a refusal leaves one option', () => {
    expect(getRemixOptions(image({ minor: true }))).toEqual(['reuse']);
    expect(getSoleRemixOption(image({ minor: true }))).toBeUndefined();
  });
});
