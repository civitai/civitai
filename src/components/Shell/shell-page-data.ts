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
  shellPageDataUrl,
} from '~/shared/constants/shell.constants';
import type { Session } from '~/types/session';

/**
 * The members of the 200 body of `GET /api/page-data/images/[imageId]` that a shell boot reads,
 * after the JSON round trip (members the endpoint leaves `undefined` are absent).
 */
export type ShellPageData = {
  session: Session | null;
  /** Present (true) when `session` is null but the request carried a session cookie: unknown, not
   *  signed out. */
  sessionUnknown?: boolean;
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

/**
 * The inline `<head>` script of a shell page (`_document`): starts the page-data request before the
 * app's bundles have loaded, into `window.__civShell`, for `adoptShellPageData` to take over. The
 * same URL and options as the fallback request there, built from the same constants. The no-op
 * `catch` only keeps a network failure from being reported as unhandled before the app attaches;
 * the app still reads the rejection.
 */
export function shellPageDataPrefetchScript(): string {
  const prefix = JSON.stringify(shellPageDataUrl('', ''));
  return (
    `try{var p=fetch(${prefix}+location.pathname+location.search,${JSON.stringify(
      PAGE_DATA_INIT
    )});` + `p.catch(function(){});window.__civShell=p}catch(e){}`
  );
}

/** The in-flight `window.__civShell` request, or a new one if the inline script did not start it. */
export function adoptShellPageData(): Promise<ShellPageDataResult> {
  const pending = (window.__civShell ??= fetch(
    shellPageDataUrl(window.location.pathname, window.location.search),
    PAGE_DATA_INIT
  ));
  let result = results.get(pending);
  if (!result) {
    result = readShellResponse(pending);
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
