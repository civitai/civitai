import type { UserSettingsChat } from '~/server/schema/chat.schema';
import type { UserContentSettings } from '~/server/schema/user.schema';
import type { TosMeta } from '~/server/services/content.service';
import type { FeatureAccess } from '~/server/services/feature-flags.service';
import type { RegionInfo } from '~/server/utils/region-blocking';
import type { NavBanner } from '~/shared/constants/nav-banner.constants';
import type { SiteAlertsPayload } from '~/shared/constants/site-alert.constants';
import {
  SHELL_BYPASS_PARAM,
  SHELL_BYPASS_VALUE,
  SHELL_MAIN_IMAGE_SUFFIX,
  shellPageDataUrl,
} from '~/shared/constants/shell.constants';
import type { Session } from '~/types/session';

/**
 * The members of the 200 body of `GET /api/page-data/images/[imageId]` that a shell boot reads,
 * after the JSON round trip (members the endpoint leaves `undefined` are absent).
 */
export type ShellPageData = {
  session: Session | null;
  settings?: UserContentSettings;
  tosMeta?: TosMeta;
  following?: number[];
  navBanners?: NavBanner[];
  siteAlerts?: SiteAlertsPayload;
  liveNow?: boolean;
  flags: FeatureAccess;
  userFeatureFlags?: FeatureAccess;
  chatSettings?: UserSettingsChat;
  region: RegionInfo;
  adsGated: boolean;
  trpcState: unknown;
};

/**
 * The RESPONSE HEADER of the main-image request (`GET /api/page-data/images/[imageId]/main-image`)
 * holding the URL of the page's main `<img>` for this viewer (`imageDetailPreloadUrl`),
 * `encodeURIComponent`-encoded; absent when the page will request none. The endpoint writes it
 * under this name and the inline head script reads it under this name. A header on a `204`, so the
 * script has nothing to parse.
 */
export const SHELL_MAIN_IMAGE_HEADER = 'X-Civ-Main-Image';

/** The `SHELL_MAIN_IMAGE_HEADER` value for `url`: header-safe whatever the URL holds. */
export function encodeShellMainImageHeader(url: string) {
  return encodeURIComponent(url);
}

/**
 * Without any of these the body is not adopted and the page falls back to a full render. `region`
 * is here because consent fails open on a missing region; the full render fails closed instead.
 * Pinned against the endpoint by its own suite.
 */
export const SHELL_PAGE_DATA_REQUIRED_KEYS = [
  'session',
  'flags',
  'region',
  'adsGated',
  'trpcState',
] as const;

export type ShellPageDataResult = { ok: true; data: ShellPageData } | { ok: false; status: number };

declare global {
  interface Window {
    /** The page-data request a shell page's inline script starts before the app loads. */
    __civShell?: Promise<Response>;
  }
}

function isShellPageData(body: unknown): body is ShellPageData {
  return (
    !!body && typeof body === 'object' && SHELL_PAGE_DATA_REQUIRED_KEYS.every((key) => key in body)
  );
}

async function readShellResponse(pending: Promise<Response>): Promise<ShellPageDataResult> {
  try {
    const res = await pending;
    if (res.status !== 200) return { ok: false, status: res.status };
    const body: unknown = await res.json();
    return isShellPageData(body) ? { ok: true, data: body } : { ok: false, status: 500 };
  } catch {
    return { ok: false, status: 0 };
  }
}

// Keyed by the request, so a second caller (a StrictMode re-run of the effect) shares one read of
// a body that can only be read once.
const results = new WeakMap<Promise<Response>, Promise<ShellPageDataResult>>();

const PAGE_DATA_INIT: RequestInit = {
  credentials: 'same-origin',
  headers: { accept: 'application/json' },
};

/** The main-image request: the viewer's cookies, and ahead of other fetches (it gates the LCP). */
const MAIN_IMAGE_INIT: RequestInit = { credentials: 'same-origin', priority: 'high' };

/** The only status a main-image answer that carries a URL has. */
export const SHELL_MAIN_IMAGE_STATUS = 204;

/**
 * The inline `<head>` script of a shell page (`_document`): starts the page-data request before the
 * app's bundles have loaded, into `window.__civShell`, for `adoptShellPageData` to take over. The
 * same URL and options as the fallback request there, built from the same constants. The no-op
 * `catch` only keeps a network failure from being reported as unhandled before the app attaches;
 * the app still reads the rejection.
 *
 * In the same tick it starts the main-image request (`shellMainImageUrl`: the page-data path plus
 * `SHELL_MAIN_IMAGE_SUFFIX`), which does a fraction of the page data's work. When that answers
 * `SHELL_MAIN_IMAGE_STATUS` carrying `SHELL_MAIN_IMAGE_HEADER`, it adds ONE
 * `<link rel="preload" as="image" fetchpriority="high">` for that URL to `<head>`, so the main
 * image downloads from then on rather than from when the page renders its `<img>`, after the page
 * data, the bundles, the hydration and the adoption. Anything else — another status, a network
 * error, no header, an empty one or one that does not decode — adds nothing. The page-data request
 * is untouched by it: the app alone reads that response. Only the URL the private endpoint names
 * is used; the shell HTML carries none.
 */
export function shellPageDataPrefetchScript(): string {
  const prefix = JSON.stringify(shellPageDataUrl('', ''));
  const suffix = JSON.stringify(SHELL_MAIN_IMAGE_SUFFIX);
  const header = JSON.stringify(SHELL_MAIN_IMAGE_HEADER);
  return (
    `try{var p=fetch(${prefix}+location.pathname+location.search,${JSON.stringify(
      PAGE_DATA_INIT
    )});` +
    `p.catch(function(){});window.__civShell=p;` +
    `fetch(${prefix}+location.pathname+${suffix}+location.search,${JSON.stringify(
      MAIN_IMAGE_INIT
    )})` +
    `.then(function(r){if(r.status!==${SHELL_MAIN_IMAGE_STATUS})return;` +
    `var h=r.headers.get(${header});if(!h)return;` +
    `var u=decodeURIComponent(h);if(!u)return;` +
    `var l=document.createElement("link");l.setAttribute("rel","preload");` +
    `l.setAttribute("as","image");l.setAttribute("fetchpriority","high");` +
    `l.setAttribute("href",u);document.head.appendChild(l)})` +
    `.catch(function(){})}catch(e){}`
  );
}

// Diagnostics only (`~/utils/faro/loginGate`): this document's page-data answer, once read.
let pageDataStatus: number | undefined;

/** This document's page-data HTTP status (200 = adopted; 0 = network error; 500 also = an
 *  unusable body), or `undefined` while unread or on a page that is not a shell. */
export function shellPageDataStatus(): number | undefined {
  return pageDataStatus;
}

/** The in-flight `window.__civShell` request, or a new one if the inline script did not start it. */
export function adoptShellPageData(): Promise<ShellPageDataResult> {
  const pending = (window.__civShell ??= fetch(
    shellPageDataUrl(window.location.pathname, window.location.search),
    PAGE_DATA_INIT
  ));
  let result = results.get(pending);
  if (!result) {
    result = readShellResponse(pending).then((r) => {
      pageDataStatus = r.ok ? 200 : r.status;
      return r;
    });
    results.set(pending, result);
  }
  return result;
}

/**
 * Where a shell page goes when its page data is not a 200: `/region-blocked` on a 451, otherwise
 * the same URL with the bypass param, which the server answers with a full render. `null` when
 * the URL already carries the bypass, so a server that sent a shell anyway cannot cause a loop.
 */
export function shellFallbackUrl(status: number, href: string): string | null {
  if (status === 451) return '/region-blocked';
  const url = new URL(href);
  if (url.searchParams.get(SHELL_BYPASS_PARAM) === SHELL_BYPASS_VALUE) return null;
  url.searchParams.set(SHELL_BYPASS_PARAM, SHELL_BYPASS_VALUE);
  // A path starting `//` would be read as another origin by `location.replace`.
  return `/${url.pathname.replace(/^\/+/, '')}${url.search}${url.hash}`;
}

/** Indirection so tests can observe the navigation; `replace` keeps the shell out of history. */
export const shellNavigation = {
  replace: (url: string) => window.location.replace(url),
};
