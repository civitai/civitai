import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MantineProvider } from '@mantine/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The app-block chrome's "Recently run" icon — node `unit` tier (the browser suites render
 * the whole menu).
 *
 * The rule under test: a row draws the `iconUrl` the live, server-gated listing read returned
 * for its slug, and the generic glyph whenever that read is loading, failed, has no row, or the
 * gate returned `null` — never a url that came from the recents store.
 *
 * The hook is stubbed per slug, so these tests pin the CLIENT half. The server half (that
 * `getAppDetail`'s `iconUrl` is gated by host, viewer level and listing rating) is pinned in
 * `listing-media-audience.seam.test.ts`, "T7".
 *
 * Fixture urls are distinct from each other and from anything the code names.
 */

type Read = { detail: { iconUrl: string | null } | undefined; isLoading: boolean; error: unknown };
const reads = vi.hoisted(() => new Map<string, Read>());
vi.mock('~/components/AppBlocks/useChromeListingDetail', () => ({
  useChromeListingDetail: (slug: string): Read =>
    reads.get(slug) ?? { detail: undefined, isLoading: false, error: new Error('NOT_FOUND') },
}));

import { ChromeRecentAppIcon } from '~/components/AppBlocks/ChromeRecentAppIcon';
import { chromeRecentAppIconSrc } from '~/components/AppBlocks/chromeRecentAppIconSrc';
import { selectChromeRecentApps } from '~/components/Apps/recentAppsRail';
import {
  getRecentlyOpenedApps,
  RECENTLY_OPENED_APPS_KEY,
  RECENTS_ENVELOPE_VERSION,
} from '~/components/Apps/recentlyOpenedAppsStore';

const GATED_ICON = 'https://cdn.test/gated-icon-7f3.png';
const STORED_R_ICON = 'https://stored.test/r-icon-91c.png';

const render = (slug: string) =>
  renderToStaticMarkup(
    createElement(MantineProvider, null, createElement(ChromeRecentAppIcon, { slug }))
  );

const GENERIC = 'data-testid="app-recently-run-icon-generic"';
const LISTING = 'data-testid="app-recently-run-icon-listing"';

beforeEach(() => reads.clear());
afterEach(() => vi.unstubAllGlobals());

describe('chromeRecentAppIconSrc — fail closed', () => {
  it('a settled read with a gated-in icon yields that icon', () => {
    expect(
      chromeRecentAppIconSrc({ detail: { iconUrl: GATED_ICON }, isLoading: false, error: null })
    ).toBe(GATED_ICON);
  });

  it('the gate hid the icon (null) ⇒ null', () => {
    expect(
      chromeRecentAppIconSrc({ detail: { iconUrl: null }, isLoading: false, error: null })
    ).toBeNull();
  });

  it('loading ⇒ null, even when a row is already held', () => {
    expect(
      chromeRecentAppIconSrc({ detail: { iconUrl: GATED_ICON }, isLoading: true, error: null })
    ).toBeNull();
  });

  it('an error ⇒ null, even when React Query still holds an earlier success', () => {
    expect(
      chromeRecentAppIconSrc({
        detail: { iconUrl: GATED_ICON },
        isLoading: false,
        error: new Error('boom'),
      })
    ).toBeNull();
  });

  it('no row, or an empty url ⇒ null', () => {
    expect(chromeRecentAppIconSrc({ detail: undefined, isLoading: false, error: null })).toBeNull();
    expect(
      chromeRecentAppIconSrc({ detail: { iconUrl: '' }, isLoading: false, error: null })
    ).toBeNull();
  });
});

describe('ChromeRecentAppIcon — what the row renders', () => {
  it('a visible listing: the gated icon, not the glyph', () => {
    reads.set('vis-app', { detail: { iconUrl: GATED_ICON }, isLoading: false, error: null });
    const html = render('vis-app');
    expect(html).toContain(LISTING);
    expect(html).toContain(`src="${GATED_ICON}"`);
    expect(html).not.toContain(GENERIC);
  });

  it('the gate hides the icon (e.g. an R icon on a non-red host): the generic glyph', () => {
    reads.set('r-app', { detail: { iconUrl: null }, isLoading: false, error: null });
    const html = render('r-app');
    expect(html).toContain(GENERIC);
    expect(html).not.toContain('<img');
  });

  it('loading: the generic glyph', () => {
    reads.set('slow-app', { detail: undefined, isLoading: true, error: null });
    const html = render('slow-app');
    expect(html).toContain(GENERIC);
    expect(html).not.toContain('<img');
  });

  it('an error (404 or fault): the generic glyph', () => {
    // No entry ⇒ the stub answers with an error, like a gated-out listing's NOT_FOUND.
    const html = render('gone-app');
    expect(html).toContain(GENERIC);
    expect(html).not.toContain('<img');
  });
});

describe('a url stored in localStorage never reaches the menu', () => {
  function fakeWindowWith(blob: unknown) {
    const store = new Map<string, string>([[RECENTLY_OPENED_APPS_KEY, JSON.stringify(blob)]]);
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
      },
    });
  }

  it('an old-format entry carrying an R icon url renders the live answer, never the stored url', () => {
    fakeWindowWith({
      v: RECENTS_ENVELOPE_VERSION,
      ownerId: null,
      apps: [
        { id: 'ab_r', blockId: 'r-app', name: 'R App', iconUrl: STORED_R_ICON },
        { id: 'ab_v', blockId: 'vis-app', name: 'Vis App', iconUrl: STORED_R_ICON },
      ],
    });
    const rows = selectChromeRecentApps(getRecentlyOpenedApps(null), {
      canOpenPage: true,
      limit: 5,
    });
    vi.unstubAllGlobals();
    // Positive control: the seeded entries were read, so the assertions below are about them.
    expect(rows.map((r) => r.blockId)).toEqual(['r-app', 'vis-app']);

    // The server gate hides r-app's icon and shows vis-app's.
    reads.set('r-app', { detail: { iconUrl: null }, isLoading: false, error: null });
    reads.set('vis-app', { detail: { iconUrl: GATED_ICON }, isLoading: false, error: null });
    const [rHtml, visHtml] = rows.map((r) => render(r.blockId));

    expect(rHtml).toContain(GENERIC);
    expect(rHtml).not.toContain(STORED_R_ICON);
    expect(visHtml).toContain(`src="${GATED_ICON}"`);
    expect(visHtml).not.toContain(STORED_R_ICON);
  });

  it('selectChromeRecentApps strips an icon url from an in-memory entry too', () => {
    const rows = selectChromeRecentApps(
      [{ id: 'ab_m', blockId: 'mem-app', name: 'Mem App', iconUrl: STORED_R_ICON }],
      { canOpenPage: true, limit: 5 }
    );
    expect(rows).toEqual([{ id: 'ab_m', blockId: 'mem-app', name: 'Mem App' }]);
    expect('iconUrl' in rows[0]).toBe(false);
  });
});
