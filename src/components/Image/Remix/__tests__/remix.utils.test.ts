import { describe, expect, it } from 'vitest';
import { canReusePrompt, getEngineRefusal, getRemixKinds, isReuseRefused } from '../remix.utils';
import type { RemixSourceImage } from '../remix.utils';
import { isRemixMenuVisible } from '../RemixMenu';
import { ImageIngestionStatus, MediaType } from '~/shared/utils/prisma/enums';

/**
 * A scanned, unremarkable image. Every case below is this minus one property,
 * so a test that stops discriminating shows up as a fixture that no longer
 * differs from the baseline rather than as a silent pass.
 */
function image(overrides: Partial<RemixSourceImage> = {}): RemixSourceImage {
  return {
    id: 1,
    url: 'abc-123',
    type: MediaType.image,
    nsfwLevel: 1,
    ingestion: ImageIngestionStatus.Scanned,
    ...overrides,
  };
}

describe('getEngineRefusal', () => {
  it('allows a scanned image', () => {
    expect(getEngineRefusal(image())).toBeUndefined();
  });

  // The reason the check is on nsfwLevel rather than ingestion: the search
  // backend's document type has no ingestion field at all, and it returns
  // unscanned images to their owner. `minor`/`poi` are null there because the
  // classifiers have not run, so every later check would pass vacuously.
  it('refuses an unscanned image even when no ingestion status is present', () => {
    const searchDoc = image({ nsfwLevel: 0, ingestion: undefined, minor: null, poi: null });
    expect(getEngineRefusal(searchDoc)).toMatch(/still being reviewed/);
  });

  it('refuses a pending image on the db path', () => {
    expect(getEngineRefusal(image({ ingestion: ImageIngestionStatus.Pending }))).toMatch(
      /still being reviewed/
    );
  });

  // A scan that ran and failed can leave a nonzero level, so nsfwLevel alone
  // does not catch these.
  it.each([ImageIngestionStatus.Error, ImageIngestionStatus.NotFound])(
    'refuses %s even with a rated level',
    (ingestion) => {
      expect(getEngineRefusal(image({ ingestion }))).toMatch(/still being reviewed/);
    }
  );

  // Both are states an already-classified image passes through, and a
  // re-ingestion sweep can put a large slice of the catalogue into Rescan.
  it.each([ImageIngestionStatus.Rescan, ImageIngestionStatus.PendingManualAssignment])(
    'allows %s, which keeps its earlier verdict',
    (ingestion) => {
      expect(getEngineRefusal(image({ ingestion }))).toBeUndefined();
    }
  );

  it('refuses a blocked image by status or by reason', () => {
    expect(getEngineRefusal(image({ ingestion: ImageIngestionStatus.Blocked }))).toMatch(/blocked/);
    expect(getEngineRefusal(image({ blockedFor: 'AiNotVerified' }))).toMatch(/blocked/);
  });

  it('refuses minor and poi images', () => {
    expect(getEngineRefusal(image({ minor: true }))).toMatch(/minor/);
    expect(getEngineRefusal(image({ poi: true }))).toMatch(/real people/);
  });
});

describe('isReuseRefused', () => {
  // Reuse copies text and resource ids already rendered on the page — no image
  // leaves the site — so a pending scan does not need to block it.
  it('stays available while a scan is pending', () => {
    expect(isReuseRefused(image({ nsfwLevel: 0, ingestion: ImageIngestionStatus.Pending }))).toBe(
      false
    );
  });

  it('is refused for a blocked image', () => {
    expect(isReuseRefused(image({ ingestion: ImageIngestionStatus.Blocked }))).toBe(true);
    expect(isReuseRefused(image({ blockedFor: 'AiNotVerified' }))).toBe(true);
  });
});

describe('getRemixKinds', () => {
  it('offers edit and animate for an image', () => {
    expect(getRemixKinds(image())).toEqual(['edit', 'video']);
  });

  it.each([MediaType.video, MediaType.audio])('offers no engine kinds for %s', (type) => {
    expect(getRemixKinds(image({ type }))).toEqual([]);
  });
});

describe('the refusal-only menu state', () => {
  // This combination — button visible, every engine option refused, no reuse
  // to fall back on — is what wedged the onboarding tour once already: the menu
  // rendered with nothing clickable in it, so the "user acted" callback never
  // fired and a step whose only exit is clicking through had no exit. RemixMenu
  // handles it by firing that callback on open instead. If someone makes
  // `isRemixMenuVisible` refusal-aware, this fails and points at the `onOpen`
  // branch that then has no reason to exist.
  it('is reachable: visible, refused, and nothing to fall back on', () => {
    const refused = image({ poi: true });
    expect(getEngineRefusal(refused)).toBeDefined();
    expect(canReusePrompt(refused)).toBe(false);
    expect(isRemixMenuVisible(refused)).toBe(true);
  });

  it('still offers reuse when the source has a prompt', () => {
    const refused = image({ poi: true, hasPositivePrompt: true });
    expect(getEngineRefusal(refused)).toBeDefined();
    expect(isReuseRefused(refused)).toBe(false);
  });
});

describe('canReusePrompt', () => {
  it('prefers hasPositivePrompt over hasMeta', () => {
    expect(canReusePrompt(image({ hasPositivePrompt: false, hasMeta: true }))).toBe(false);
    expect(canReusePrompt(image({ hasPositivePrompt: true, hasMeta: false }))).toBe(true);
  });

  it('falls back to hasMeta when the prompt flag is absent', () => {
    expect(canReusePrompt(image({ hasMeta: true }))).toBe(true);
    expect(canReusePrompt(image())).toBe(false);
  });
});
