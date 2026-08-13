import { describe, expect, it } from 'vitest';
import {
  canReusePrompt,
  getEngineRefusal,
  getRemixEngine,
  getRemixKinds,
  getRemixTier,
  isReuseRefused,
} from '../remix.utils';
import type { RemixSourceImage } from '../remix.utils';
import { isRemixMenuVisible } from '../RemixMenu';
import { REMIX_ENGINES } from '~/shared/constants/remix.constants';
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

  // Justin, 2026-08-12: an unrated image routes to the safe tier instead of
  // refusing. The viewer cannot hurry a scan, so a refusal message was a dead
  // end for the one case that is most common — your own fresh upload.
  it('does not refuse an unscanned image', () => {
    const searchDoc = image({ nsfwLevel: 0, ingestion: undefined });
    expect(getEngineRefusal(searchDoc)).toBeUndefined();
  });

  // Unrated (the fixture default here is level 0 via the override) routes safe,
  // so no ingestion state produces a refusal for it.
  it.each([
    ImageIngestionStatus.Pending,
    ImageIngestionStatus.Error,
    ImageIngestionStatus.NotFound,
    ImageIngestionStatus.Rescan,
    ImageIngestionStatus.PendingManualAssignment,
  ])('does not refuse an unrated image on ingestion status %s', (ingestion) => {
    expect(getEngineRefusal(image({ nsfwLevel: 0, ingestion }))).toBeUndefined();
  });

  // `minor`/`poi` are NOT NULL columns defaulting to false, so they cannot
  // distinguish "rated mature by a moderator before the scan" from "scanned and
  // clean" — only `ingestion` can. The mature tier is self-hosted, so unlike the
  // safe tier there is no provider filter behind us here.
  it.each([
    ImageIngestionStatus.Pending,
    ImageIngestionStatus.Error,
    ImageIngestionStatus.NotFound,
    ImageIngestionStatus.PendingManualAssignment,
  ])('refuses a mature image whose scan is %s', (ingestion) => {
    expect(getEngineRefusal(image({ nsfwLevel: 8, ingestion }))).toMatch(/still being reviewed/);
  });

  it('allows a mature image that has been scanned', () => {
    expect(getEngineRefusal(image({ nsfwLevel: 8 }))).toBeUndefined();
  });

  // A re-ingestion sweep can put a large slice of the catalogue into Rescan at
  // once; those images keep their earlier verdict, so refusing them would be a
  // self-inflicted outage rather than a safety gain.
  // A rescan follows a completed scan, so the earlier verdict still stands —
  // and a re-ingestion sweep can put a large slice of the catalogue into this
  // state at once, so refusing it would be a self-inflicted outage.
  it('allows a mature image in Rescan, which keeps its earlier verdict', () => {
    expect(
      getEngineRefusal(image({ nsfwLevel: 8, ingestion: ImageIngestionStatus.Rescan }))
    ).toBeUndefined();
  });

  // The unrated case Justin asked for: routes safe, so it never reaches the
  // clause above even though its scan has not finished either.
  it('does not refuse an unrated image whose scan is pending', () => {
    expect(
      getEngineRefusal(image({ nsfwLevel: 0, ingestion: ImageIngestionStatus.Pending }))
    ).toBeUndefined();
  });

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

describe('engine routing by rating', () => {
  // NsfwLevel is a bitflag set: PG=1, PG13=2, R=4, X=8, XXX=16.
  it.each([1, 2])('routes level %i to the safe engine', (nsfwLevel) => {
    expect(getRemixTier(image({ nsfwLevel }))).toBe('safe');
    expect(getRemixEngine('edit', image({ nsfwLevel }))).toBe(REMIX_ENGINES.edit.safe);
  });

  it.each([4, 8, 16])('routes level %i to the mature engine', (nsfwLevel) => {
    expect(getRemixTier(image({ nsfwLevel }))).toBe('mature');
    expect(getRemixEngine('edit', image({ nsfwLevel }))).toBe(REMIX_ENGINES.edit.mature);
  });

  // Unrated means the classifiers have not run, so we know least about it —
  // routing that to the mature engine would be exactly backwards. Note
  // getIsSafeBrowsingLevel(0) is FALSE, so this needs its own branch.
  it('routes an unrated image to the safe engine', () => {
    expect(getRemixTier(image({ nsfwLevel: 0 }))).toBe('safe');
    expect(getRemixEngine('edit', image({ nsfwLevel: 0 }))).toBe(REMIX_ENGINES.edit.safe);
  });

  it('routes video by tier too, not just edit', () => {
    expect(getRemixEngine('video', image({ nsfwLevel: 1 }))).toBe(REMIX_ENGINES.video.safe);
    expect(getRemixEngine('video', image({ nsfwLevel: 8, minor: false, poi: false }))).toBe(
      REMIX_ENGINES.video.mature
    );
  });

  // The failure this prevents is a charged request that the provider refuses,
  // which looks like a broken generator rather than a routing bug.
  it("never sends a mature image to the safe tier's ecosystem", () => {
    const mature = image({ nsfwLevel: 16 });
    expect(getRemixEngine('edit', mature).ecosystemKey).not.toBe(
      REMIX_ENGINES.edit.safe.ecosystemKey
    );
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
