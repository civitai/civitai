import { describe, expect, it } from 'vitest';
import * as hidden from '~/components/Apps/appHiddenByBrowsingLevel';

/**
 * The hidden state an R/X app shows to a viewer whose browsing level excludes it, on the app
 * detail page and the run page, instead of a 404. Its copy is pinned whole (a reword fails here,
 * on purpose), and the store-preview page's view decision is pinned so an excluded viewer gets
 * the hidden state — not `NotFound`, and never the app.
 */

const { appHiddenByBrowsingLevelCopy, storePreviewView } = hidden;

describe('appHiddenByBrowsingLevelCopy', () => {
  it('signed in: names the rating and points at Content & Browsing settings', () => {
    expect(
      appHiddenByBrowsingLevelCopy({ contentRating: 'r', signedIn: true, returnUrl: '/apps/x' })
    ).toEqual({
      title: 'Hidden by your browsing settings',
      body: "This app is rated R, and your browsing level doesn't include R content. To see it, turn on R in your Content & Browsing settings.",
      action: { label: 'Open Content & Browsing settings', href: '/user/account/content' },
    });
  });

  it('signed out: names the rating and asks the viewer to sign in, returning here', () => {
    expect(
      appHiddenByBrowsingLevelCopy({
        contentRating: 'x',
        signedIn: false,
        returnUrl: '/apps/run/abc',
      })
    ).toEqual({
      title: 'Hidden by your browsing settings',
      body: 'This app is rated X. Sign in and enable mature content in your browsing settings to see it.',
      action: {
        label: 'Sign in',
        href: '/login?returnUrl=%2Fapps%2Frun%2Fabc&reason=view-content',
      },
    });
  });
});

describe('storePreviewView — the app detail page', () => {
  const detail = { id: 'apl_1' };
  const notFound = { data: { code: 'NOT_FOUND' } };

  it('🔴 an excluded viewer gets the hidden state, not NotFound and not the app', () => {
    expect(
      storePreviewView({
        canSeeStore: true,
        detail: undefined,
        detailError: notFound,
        detailLoading: false,
        hidden: { contentRating: 'r' },
        hiddenLoading: false,
      })
    ).toEqual({ kind: 'hidden', contentRating: 'r' });
  });

  it('waits for the hidden-state read before deciding NotFound', () => {
    expect(
      storePreviewView({
        canSeeStore: true,
        detail: undefined,
        detailError: notFound,
        detailLoading: false,
        hidden: undefined,
        hiddenLoading: true,
      })
    ).toEqual({ kind: 'loading' });
  });

  it('a missing (or otherwise not visible) app is still NotFound', () => {
    expect(
      storePreviewView({
        canSeeStore: true,
        detail: undefined,
        detailError: notFound,
        detailLoading: false,
        hidden: null,
        hiddenLoading: false,
      })
    ).toEqual({ kind: 'not-found' });
  });

  it('a visible app renders its detail; no store access is NotFound', () => {
    const base = {
      detail,
      detailError: null,
      detailLoading: false,
      hidden: undefined,
      hiddenLoading: false,
    };
    expect(storePreviewView({ ...base, canSeeStore: true })).toEqual({ kind: 'detail', detail });
    expect(storePreviewView({ ...base, canSeeStore: false })).toEqual({ kind: 'not-found' });
  });
});
