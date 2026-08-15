import { getCookie, getCookies } from 'cookies-next';
import type { AppContext } from 'next/app';
import App from 'next/app';
import type { Session } from '~/types/session';
import {
  ANNOUNCEMENTS_DISMISSED_COOKIE,
  parseDismissedCookieValue,
} from '~/components/Announcements/announcements-dismissed-cookie';
import { env } from '~/env/client';
import { isPreview, isProd } from '~/env/other';
import type { AnnouncementsSeed } from '~/providers/announcements-seed';
import { resolveAuthGuard } from '~/server/auth/route-guard';
import { resolveChatSettings } from '~/server/schema/chat.schema';
import type { UserSettingsChat } from '~/server/schema/chat.schema';
import type { UserContentSettings } from '~/server/schema/user.schema';
import type { TosMeta } from '~/server/services/content.service';
import type { FeatureAccess } from '~/server/services/feature-flags.service';
import { parseVerifiedBotHeader, VERIFIED_BOT_HEADER } from '~/server/utils/bot-detection/header';
import { getRegion } from '~/server/utils/region-blocking';
import type { BrowsingSettingsAddon } from '~/shared/constants/browsing-settings-addons';
import type { ServerDomains } from '~/shared/constants/domain.constants';
import { parseCookies } from '~/shared/utils/cookies';

// Lives outside `src/pages/_app.tsx` so anything that needs this logic — the unit test that
// pins the auth-cookie discriminator, above all — does not have to load the page component
// and the entire provider/layout tree behind it. `_app` assigns it as its `getInitialProps`,
// so it still ships in the same (server AND client) bundle and runs on client navigations
// exactly as before.

const baseUrl = process.env.NEXTAUTH_URL_INTERNAL ?? env.NEXT_PUBLIC_BASE_URL;
// Bound the server-side self-fetch to `/api/user/settings` so a slow/hung apex
// Service endpoint can't stall every SSR render's critical path. The endpoint
// does session + settings + a 3-way Promise.all (tos/announcements/follows) —
// several DB/redis round-trips — so under rollout load it can be slow-but-
// successful. 8s sits well under the gateway/kubelet ceilings but only trips on
// a genuine hang (don't abort a fetch that would have succeeded → needless
// degraded render). Env-overridable for tuning. (Confirm P99 from Tempo.)
// Clamp to a positive floor: `AbortSignal.timeout()` throws RangeError on a
// negative value, so a fat-fingered/negative env override (e.g. `-1`) would
// throw on EVERY render and silently force the permanent-degrade path. Floor at
// 1s; a too-low (but positive) value at worst over-degrades, it can't crash.
const SETTINGS_FETCH_TIMEOUT_MS = Math.max(
  1000,
  Number(process.env.APP_SETTINGS_FETCH_TIMEOUT_MS) || 8000
);
export const getAppInitialProps = async (appContext: AppContext) => {
  const initialProps = await App.getInitialProps(appContext);
  const { req: request } = appContext.ctx;
  if (!request) return initialProps;
  // Everything below this point is only serverside

  // const url = appContext.ctx?.req?.url;

  const { pageProps, ...appProps } = initialProps;
  const colorScheme = getCookie('mantine-color-scheme', appContext.ctx) ?? 'dark';
  const cookies = getCookies(appContext.ctx);
  const parsedCookies = parseCookies(cookies);
  // Server-read announcement `dismissed` state from the `announcements-dismissed`
  // cookie. `getCookies` hands us the URL-decoded JSON string, which
  // `parseDismissedCookieValue` (the SAME parser the client store uses) turns into
  // the per-type dismissed record. Threaded down so SSR + first client paint agree.
  const announcementsDismissed = parseDismissedCookieValue(
    typeof cookies[ANNOUNCEMENTS_DISMISSED_COOKIE] === 'string'
      ? (cookies[ANNOUNCEMENTS_DISMISSED_COOKIE] as string)
      : undefined
  );

  // Match BOTH session cookie families: the new hub `civ-token` / `__Secure-civ-token` AND the legacy
  // next-auth `civitai-token` / `__Secure-civitai-token` (still honored during the cutover). Note the suffixes
  // don't subsume each other — `civitai-token` does NOT end with `civ-token` — so both checks are required.
  // Used to seed `SessionProvider` (unknown → fetch on mount) and `loggedIn` below.
  let hasAuthCookie = Object.keys(cookies).some(
    (x) => x.endsWith('civ-token') || x.endsWith('civitai-token')
  );
  // const session = hasAuthCookie ? await getSession(appContext.ctx) : undefined;
  // const flags = getFeatureFlags({ user: session?.user, host: appContext.ctx.req?.headers.host });
  const { serverDomainMap, getRequestDomainColor, getAllServerHosts, getAvailableOAuthProviders } =
    await import('~/server/utils/server-domain');
  const serverDomains: ServerDomains = {
    green: serverDomainMap.green,
    blue: serverDomainMap.blue,
    red: serverDomainMap.red,
  };
  const canIndex = getAllServerHosts().includes((request.headers.host ?? '').toLowerCase());
  // Provider list comes from the hub (single source of provider config/secrets), cached + fail-open.
  const availableOAuthProviders = await getAvailableOAuthProviders();

  const region = getRegion(request);

  // Read the verified-bot header set by botDetectionMiddleware.
  const verifiedBot = parseVerifiedBotHeader(request.headers[VERIFIED_BOT_HEADER]);

  // Self-fetch the pod's own apex Service for the per-user settings bootstrap.
  // This sits on EVERY SSR page render's critical path with no resolver behind
  // it, so any failure here (fetch reject — ECONNREFUSED/ECONNRESET from a
  // churning keep-alive socket — timeout/abort, non-OK status, or a `res.json()`
  // reject) must NOT throw out of `getInitialProps`: that would surface a
  // user-facing 500 with no app error log. Degrade to the anonymous/no-settings
  // shape instead; the downstream consumers already tolerate it (`settings`
  // undefined → the client `user.getSettings` query self-heals; `session` null →
  // anon render; the optional seeds are `enabled: !!x` gated).
  // The success-path shape is identical to before; on failure we fall back to
  // the anonymous/no-settings shape. `settings` keeps its original
  // `UserContentSettings` type (downstream consumers already treat an undefined
  // runtime value as "no snapshot" — see the `if (session?.user && settings)`
  // gate and `initialData: settings` below), so the fallback `undefined` matches
  // the documented failed-snapshot path without widening any downstream type.
  type SettingsBootstrap = {
    settings: UserContentSettings;
    tosMeta?: TosMeta;
    announcements?: AnnouncementsSeed;
    following?: number[];
    // Absent on the degraded path. `browsingSettingsAddons` must stay possibly-
    // undefined all the way to the provider — see the endpoint for why `[]` is
    // not a safe substitute.
    browsingSettingsAddons?: BrowsingSettingsAddon[];
    liveNow?: boolean;
    session: Session | null;
  };
  let settingsBootstrap: SettingsBootstrap;
  // True only on the DEGRADED fallback path (we couldn't reach/parse the settings
  // endpoint). A SUCCESSFUL fetch returning `session: null` looks identical in the
  // destructured shape below, but the two drive `hasAuthCookie` differently — see the
  // carve-out near the return.
  let settingsDegraded = false;
  try {
    const res = await fetch(`${baseUrl as string}/api/user/settings`, {
      headers: { ...request.headers } as HeadersInit,
      signal: AbortSignal.timeout(SETTINGS_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`settings fetch returned ${res.status}`);
    const data = (await res.json()) as SettingsBootstrap;
    // The endpoint's OWN internal catch swallows transient errors (e.g. a DB blip on a
    // draining pod mid-roll) into a SUCCESSFUL `200 {}` — a body with NO `session` key.
    // That sails past the `!res.ok` guard but carries no authoritative session, so
    // treating it as a real result would render a logged-in user as signed out. Key
    // ABSENT (`{}`) ⇒ degraded; key PRESENT (`session: null`) ⇒ render anonymous.
    // `'session' in data` is the discriminator — a truthiness check erases it.
    if (!data || typeof data !== 'object' || !('session' in data)) {
      throw new Error('settings fetch returned no session payload (endpoint-swallowed error)');
    }
    settingsBootstrap = data;
  } catch (e) {
    settingsDegraded = true;
    // Observable but non-fatal: log concisely and fall through to a safe render.
    // The structured marker `[_app] settings bootstrap fetch failed` is the
    // stable greppable string and the ONLY alertable signal — a genuinely-broken
    // settings endpoint mass-degrades every SSR render with NO 5xx spike (we
    // swallow the throw), so it would otherwise be silent. A Loki log-rate alert
    // on this marker is wired on the datapacket-talos side.
    // NB: deliberately NO prom-client metric here — `_app.tsx` runs in BOTH the
    // client and server bundles, and importing `~/server/prom/client` (even
    // dynamically) pulls `prom-client` → Node built-ins (`tls`/`v8`) into the
    // CLIENT bundle and breaks `next build` ("Can't resolve 'tls'/'v8'"). The
    // greppable warn + Loki alert is the agreed signal.
    console.warn(
      `[_app] settings bootstrap fetch failed, rendering without it: ${
        e instanceof Error ? e.message : String(e)
      }`
    );
    settingsBootstrap = {
      settings: undefined as unknown as UserContentSettings,
      tosMeta: undefined,
      announcements: undefined,
      following: undefined,
      browsingSettingsAddons: undefined,
      liveNow: undefined,
      session: null,
    };
  }
  const {
    settings,
    session,
    tosMeta,
    announcements,
    following,
    browsingSettingsAddons,
    // Fail closed to "not live". `getLiveNow` reads the main redis with no internal
    // catch and no deadline race, so the endpoint's own `.catch` is what turns a
    // degraded read into `false`; this default covers the bootstrap fetch failing
    // outright. The client query self-heals on its 5-minute refetch.
    liveNow = false,
  } = settingsBootstrap;
  const { getFeatureFlagsAsync, computeUserFeatureFlagsOverlay } = await import(
    '~/server/services/feature-flags.service'
  );
  const flags = await getFeatureFlagsAsync({
    user: session?.user,
    host: request?.headers.host,
    req: request,
  });

  const domain = getRequestDomainColor(request);

  // SSR-inject two ambient per-bootstrap trpc results that fire on every
  // logged-in page load but are fully derivable from data already fetched here.
  // Both client queries gate on a logged-in user, so only seed for sessions.
  // - userFeatureFlags: the per-user toggleable-feature overlay
  //   (`user.getFeatureFlags`), a pure function of `settings.features` + the SSR
  //   host `flags`. Computed here via the SAME shared function the resolver uses
  //   (fs-free, safe in this client-bundled getInitialProps graph).
  // - tosMeta: the static per-domain ToS metadata (lastmod + body hash + the
  //   per-domain settings field keys) — resolved server-side in the
  //   `/api/user/settings` route above and delivered via that fetch, so we never
  //   import `content.service` (and its `fs/promises` read) into this graph.
  //   ToS content only changes on a deploy (never mid-session). The show/hide
  //   decision is computed client-side in `useToSUpdateModal` against the seeded
  //   `user.getSettings`, so there is no tRPC query to seed here — `tosMeta` just
  //   rides down through pageProps to AppProvider as-is.
  let userFeatureFlags: FeatureAccess | undefined;
  if (session?.user && settings) {
    userFeatureFlags = computeUserFeatureFlagsOverlay(settings.features, flags);
  }

  // SSR-seed `chat.getUserSettings` (logged-in only) so the chat widget reads a
  // primed cache and never fires the query on bootstrap (~19 req/s off
  // api-primary). Fully DERIVED from the `settings.chat` field already fetched
  // above for the bootstrap — NO extra I/O. The chat settings are static per
  // user (only the user's own `setUserSettings` changes them, which patches the
  // cache via optimistic `setData`), so SSR-seeding is exact.
  //
  // Byte-equality (#2471): the `chat.getUserSettings` resolver returns
  // `settings.chat` and substitutes the SAME default object when absent — mirror
  // it here so the seed matches the resolver output exactly. Seed only when a
  // settings snapshot is present (the degraded/anon path leaves it undefined and
  // the client query self-heals).
  let chatSettings: UserSettingsChat | undefined;
  if (session?.user && settings) {
    chatSettings = resolveChatSettings(settings.chat);
  }

  if (session) {
    (appContext.ctx.req as any)['session'] = session;
  } else if (hasAuthCookie && !settingsDegraded) {
    // Render anonymous, but DO NOT delete the cookie. `session: null` is ambiguous:
    // `getServerAuthSession` fail-softs to null (`.catch(() => null)` at
    // get-server-auth-session.ts:92,102), so a hub outage is indistinguishable on the
    // wire from an expired token — and deleting on the outage durably logs out a valid
    // user. Scope: the delete this replaces named the LEGACY `civitai-token` family only,
    // so only legacy holders were ever affected either way. Cost of keeping it is near
    // zero: a civ-token's Max-Age comes from its own `exp` (civ-cookie.ts:163), so an
    // expired one is never in the jar to linger; a stale legacy cookie costs one failed
    // jose decode per request. Deleting safely needs the endpoint to signal a degraded
    // lookup distinctly from "no session".
    hasAuthCookie = false;
  }

  // Auth route guards, moved off the edge middleware (the thin hub civ-token can't resolve the full user in the
  // edge runtime — see preview-access.ts / route-guards). Runs here in Node with the resolved session, catching
  // direct/SSR loads. A non-mod can't client-nav to these (the nav isn't shown to them) and the tRPC procedures
  // are the real data gate, so the client-nav gap is harmless.
  const guardPath = (request.url ?? '').split('?')[0];
  const guard = resolveAuthGuard(guardPath, session, { isProd, isPreview });
  let guardTo: string | undefined;
  if (guard && 'redirect' in guard) {
    guardTo = guard.redirect;
  } else if (guard && 'needsPreviewCheck' in guard && session?.user) {
    // Logged-in non-moderator on a preview deploy → resolve the allowlist via Flipt (async, kept out of the guard).
    const { checkPreviewAccess } = await import('~/server/auth/preview-access');
    if (!(await checkPreviewAccess(session.user))) guardTo = '/preview-restricted';
  }
  if (guardTo && appContext.ctx.res) {
    appContext.ctx.res.writeHead(302, { Location: guardTo });
    appContext.ctx.res.end();
  }

  return {
    pageProps: {
      ...pageProps,
      colorScheme,
      cookies: parsedCookies,
      canIndex,
      // cookieKeys: Object.keys(cookies),
      session,
      settings,
      browsingSettingsAddons,
      liveNow,
      flags,
      userFeatureFlags,
      tosMeta,
      announcements,
      announcementsDismissed,
      following,
      seed: Date.now(),
      hasAuthCookie,
      region,
      domain,
      serverDomains,
      availableOAuthProviders,
      host: appContext.ctx.req?.headers.host ?? '',
      verifiedBot,
    },
    ...appProps,
  };
};
