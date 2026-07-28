import { describe, expect, it } from 'vitest';

import {
  computeAutofillStatus,
  describeMissingChannels,
  siteExposedChannels,
} from '~/components/Apps/listingAutofillStatus';
import type { ListingMetaSuggestion } from '~/server/utils/og-metadata';

/**
 * PURE four-state autofill status derivation. The headline requirement: never claim
 * "already filled" when the pull genuinely found nothing (the misleading old copy).
 * The state is a deterministic function of (a) what the SITE exposed and (b) what
 * actually became ACTIONABLE given current form state.
 */

describe('siteExposedChannels', () => {
  it('counts an icon whether it came as an https URL or an inline data URI', () => {
    expect(siteExposedChannels({ iconImageUrl: 'https://x/i.png' }).icon).toBe(true);
    expect(siteExposedChannels({ iconDataUri: 'data:image/svg+xml,%3Csvg%2F%3E' }).icon).toBe(true);
    expect(siteExposedChannels({}).icon).toBe(false);
  });

  it('counts a description from either description or tagline', () => {
    expect(siteExposedChannels({ description: 'x' }).description).toBe(true);
    expect(siteExposedChannels({ tagline: 'x' }).description).toBe(true);
    expect(siteExposedChannels({}).description).toBe(false);
  });
});

describe('computeAutofillStatus', () => {
  const actionedNone = { filledText: false, suggestedAsset: false };
  const actionedText = { filledText: true, suggestedAsset: false };
  const actionedAsset = { filledText: false, suggestedAsset: true };

  it('error: a failed fetch → error (regardless of data)', () => {
    expect(computeAutofillStatus({ errored: true, data: undefined, actioned: actionedNone })).toEqual(
      { status: 'error' }
    );
  });

  it('empty (site exposed nothing): {} → empty with siteExposedNothing=true (NOT "already filled")', () => {
    expect(computeAutofillStatus({ errored: false, data: {}, actioned: actionedNone })).toEqual({
      status: 'empty',
      siteExposedNothing: true,
    });
    expect(
      computeAutofillStatus({ errored: false, data: undefined, actioned: actionedNone })
    ).toEqual({ status: 'empty', siteExposedNothing: true });
  });

  it('empty (already filled): site exposed things but nothing was actionable → empty, siteExposedNothing=false', () => {
    const data: ListingMetaSuggestion = {
      name: 'X',
      description: 'd',
      coverImageUrl: 'https://x/c.png',
      iconImageUrl: 'https://x/i.png',
    };
    expect(computeAutofillStatus({ errored: false, data, actioned: actionedNone })).toEqual({
      status: 'empty',
      siteExposedNothing: false,
    });
  });

  it('applied: exposed every expected channel (description + cover + icon) AND something actioned', () => {
    const data: ListingMetaSuggestion = {
      name: 'X',
      description: 'd',
      coverImageUrl: 'https://x/c.png',
      iconImageUrl: 'https://x/i.png',
    };
    expect(computeAutofillStatus({ errored: false, data, actioned: actionedAsset })).toEqual({
      status: 'applied',
    });
  });

  it('partial (the radio case): title + inline icon actioned, but cover + description absent', () => {
    const data: ListingMetaSuggestion = {
      name: 'AI Radio',
      iconDataUri: 'data:image/svg+xml,%3Csvg%2F%3E',
    };
    // Name already filled (not counted), the inline icon IS actionable.
    const r = computeAutofillStatus({ errored: false, data, actioned: actionedAsset });
    expect(r.status).toBe('partial');
    expect(r.missing).toEqual(['description', 'cover']);
  });

  it('partial: filled description text but no cover/icon exposed', () => {
    const data: ListingMetaSuggestion = { name: 'X', description: 'd' };
    const r = computeAutofillStatus({ errored: false, data, actioned: actionedText });
    expect(r.status).toBe('partial');
    expect(r.missing).toEqual(['cover', 'icon']);
  });
});

describe('describeMissingChannels', () => {
  it('phrases one / two / three missing channels', () => {
    expect(describeMissingChannels(['icon'])).toBe('an icon');
    expect(describeMissingChannels(['cover', 'icon'])).toBe('a cover or an icon');
    expect(describeMissingChannels(['description', 'cover', 'icon'])).toBe(
      'a description, a cover, or an icon'
    );
    expect(describeMissingChannels([])).toBe('some details');
    expect(describeMissingChannels(undefined)).toBe('some details');
  });
});
