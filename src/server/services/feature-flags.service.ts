import type { IncomingMessage } from 'http';
import { camelCase } from 'lodash-es';
import type { NextApiRequest } from 'next';
import type { SessionUser } from '~/types/session';
import { isDev } from '~/env/other';
import type { RegionInfo } from '~/server/utils/region-blocking';
import { getRegion, isRegionRestricted } from '~/server/utils/region-blocking';
import { getDisplayName } from '~/utils/string-helpers';
import { colorDomainNames, type ColorDomain } from '~/shared/constants/domain.constants';

export type ServerAvailability = ColorDomain;

// Parsed once at module load — env is immutable at runtime. Each color maps
// to the set of lowercased hosts (primary + aliases) that resolve to it.
// Used in `hasFeature` to short-circuit per-color server availability checks
// without re-parsing CSV env vars on every flag lookup.
const colorHostSets: Record<ColorDomain, Set<string>> = colorDomainNames.reduce((acc, color) => {
  const hosts = new Set<string>();
  const primary = process.env[`SERVER_DOMAIN_${color.toUpperCase()}`]?.toLowerCase();
  if (primary) hosts.add(primary);
  const aliasesRaw = process.env[`SERVER_DOMAIN_${color.toUpperCase()}_ALIASES`];
  if (aliasesRaw) {
    for (const alias of aliasesRaw.split(',')) {
      const trimmed = alias.trim().toLowerCase();
      if (trimmed) hosts.add(trimmed);
    }
  }
  acc[color] = hosts;
  return acc;
}, {} as Record<ColorDomain, Set<string>>);

// --------------------------
// Feature Availability
// --------------------------
const envAvailability = ['dev'] as const;
const regionAvailability = ['restricted', 'nonRestricted'] as const;
const serverAvailability = colorDomainNames;
export const userTiers = ['free', 'founder', 'bronze', 'silver', 'gold'] as const;
const roleAvailablity = ['public', 'user', 'mod', 'member', 'granted', ...userTiers] as const;
type RoleAvailability = (typeof roleAvailablity)[number];
const featureAvailability = [
  ...envAvailability,
  ...regionAvailability,
  ...serverAvailability,
  ...roleAvailablity,
] as const;
// Tracks which flags have ENV overrides so Flipt is skipped for those
const envOverriddenFlags = new Set<string>();
const featureFlags = createFeatureFlags({
  canWrite: ['public'],
  earlyAccessModel: ['public'],
  apiKeys: ['public'],
  apiKeyBuzzLimit: { availability: ['mod'], fliptKey: 'api-key-buzz-limit' },
  oauthApps: { availability: ['mod'], fliptKey: 'oauth-apps' },
  articles: ['public'],
  articleCreate: ['public'],
  articleRatingDispute: { availability: ['user'], fliptKey: 'article-rating-dispute' },
  adminTags: ['mod', 'granted'],
  civitaiLink: ['mod', 'member'],
  imageTraining: { availability: ['user'], fliptKey: 'image-training' },
  videoTraining: { availability: ['public'], fliptKey: 'video-training' },
  aiToolkitSd15: { availability: ['mod'], fliptKey: 'ai-toolkit-sd15' },
  aiToolkitSdxl: { availability: ['mod'], fliptKey: 'ai-toolkit-sdxl' },
  aiToolkitFlux: { availability: ['mod'], fliptKey: 'ai-toolkit-flux' },
  aiToolkitSd35: { availability: ['mod'], fliptKey: 'ai-toolkit-sd35' },
  aiToolkitHunyuan: { availability: ['mod'], fliptKey: 'ai-toolkit-hunyuan' },
  aiToolkitWan: { availability: ['mod'], fliptKey: 'ai-toolkit-wan' },
  aiToolkitChroma: { availability: ['mod'], fliptKey: 'ai-toolkit-chroma' },
  aiToolkitDefaultSd: { availability: ['mod'], fliptKey: 'ai-toolkit-default-sd' },
  kohyaTraining: { availability: ['public'], fliptKey: 'kohya-training' },
  qwenTraining: { availability: ['mod'], fliptKey: 'qwen-training' },
  flux2Training: { availability: ['public'], fliptKey: 'flux2-training' },
  zimageturboTraining: { availability: ['mod'], fliptKey: 'zimage-turbo-training' },
  zimagebaseTraining: { availability: ['mod'], fliptKey: 'zimage-base-training' },
  fluxTwoKleinTraining: { availability: ['mod'], fliptKey: 'flux2-klein-training' },
  ltx2Training: { availability: ['mod'], fliptKey: 'ltx2-training' },
  ltx23Training: { availability: ['mod'], fliptKey: 'ltx23-training' },
  wan22Training: { availability: ['mod'], fliptKey: 'wan22-training' },
  ernieTraining: { availability: ['mod'], fliptKey: 'ernie-training' },
  hidreamO1Training: { availability: ['mod'], fliptKey: 'hidream-o1-training' },
  animaTraining: { availability: ['mod'], fliptKey: 'anima-training' },
  booguTraining: { availability: ['mod'], fliptKey: 'boogu-training' },
  krea2Training: { availability: ['mod'], fliptKey: 'krea2-training' },
  audioTraining: { availability: ['mod'], fliptKey: 'audio-training' },
  // Steps-based training pricing + QOL inputs (steps/batchSize/sample params/continue-training).
  // Public availability so it can be rolled out to a tester segment via Flipt; default off.
  trainingStepsPricing: { availability: ['mod'], fliptKey: 'training-steps-pricing' },
  trainingAutoLabelOrchestrator: {
    availability: ['mod'],
    fliptKey: 'training-auto-label-orchestrator',
  },
  imageTrainingResults: { availability: ['user'], fliptKey: 'image-training-results' },
  trainingAutoCaption: { availability: ['public'], fliptKey: 'training-auto-caption2' },
  trainingAutoTag: { availability: ['public'], fliptKey: 'training-auto-tag2' },
  wan22MultiStep: { availability: ['public'], fliptKey: 'wan22-multi-step' },
  enhancedCompatibilitySdcpp: {
    availability: ['public'],
    fliptKey: 'enhanced-compatibility-sdcpp',
  },
  questions: ['dev', 'mod'],
  imageGeneration: ['public'],
  largerGenerationImages: {
    toggleable: true,
    default: false,
    displayName: 'Larger Images in Generator',
    description: `Images displayed in the generator will be larger on small screens`,
    availability: ['public'],
  },
  postsNavItem: {
    toggleable: true,
    default: false,
    displayName: 'Posts in Navigation',
    description: `Show the Posts item in the main site navigation.`,
    availability: ['public'],
  },
  eventsNavItem: {
    toggleable: true,
    default: false,
    displayName: 'Events in Navigation',
    description: `Show the Events item in the main site navigation.`,
    availability: ['public'],
  },
  nativeVideoControls: {
    toggleable: true,
    default: false,
    displayName: 'Native Video Controls',
    description: `Use your browser's built-in video player controls (with a seek bar) for all videos.`,
    availability: ['public'],
  },
  alternateHome: ['public'],
  collections: ['public'],
  air: {
    toggleable: true,
    default: true,
    displayName: 'AI Resource Identifier',
    description: `Show the Civitai AIR on resources for easy use within the Civitai Services API or Civitai Comfy Nodes.`,
    availability: ['user'],
  },
  profileCollections: ['public'],
  imageSearch: ['public'],
  buzz: ['public'],
  referralProgramV2: { availability: ['public'], fliptKey: 'referral-program-v2' },
  assistant: {
    toggleable: true,
    default: true,
    displayName: 'CivBot Assistant',
    description: `A helpful chat assistant that can answer questions about Stable Diffusion, Civitai, and more! We're still training it, so please report any issues you find!`,
    availability: ['user'],
  },
  assistantPersonality: ['bronze', 'silver', 'gold'],
  bounties: ['blue', 'red', 'public'],
  newsroom: ['public'],
  safety: ['public'],
  csamReports: isDev ? ['mod'] : ['granted'],
  appealReports: isDev ? ['mod'] : ['granted'],
  reviewTrainingData: isDev ? ['mod'] : ['granted'],
  clubs: ['mod'],
  createClubs: ['mod', 'granted'],
  moderateTags: ['granted'],
  chat: {
    toggleable: true,
    default: true,
    displayName: 'Chats',
    description: 'Send and receive DMs from users across the site.',
    availability: ['blue', 'red', 'user'],
  },
  creatorsProgram: ['mod', 'granted'],
  buzzWithdrawalTransfer: ['granted'],
  vault: ['user'],
  draftMode: ['public'],
  membershipsV2: ['public'],
  cosmeticShop: ['public'],
  impersonation: isDev ? ['mod'] : ['granted'],
  donationGoals: ['public'],
  creatorComp: ['public'],
  imageIndexFeed: { availability: ['public'], fliptKey: 'image-index-feed' },
  // #region [Domain Specific Features]
  isGreen: ['public', 'green'],
  isBlue: ['public', 'blue', 'red'],
  isRed: ['public', 'blue', 'red'],
  canViewNsfw: ['public', 'blue', 'red', 'nonRestricted'],
  canBuyBuzz: ['public'],
  // #endregion
  // Temporarily disabled until we change ads provider -Manuel
  paddleAdjustments: ['granted'],
  announcements: ['granted'],
  blocklists: ['granted'],
  toolSearch: ['public'],
  comicSearch: ['public'],
  generationOnlyModels: ['mod', 'granted', 'gold'],
  appTour: ['public'],
  privateModels: ['public'],
  auctions: ['blue', 'red', 'green', 'public'],
  newOrderGame: ['blue', 'red', 'public'],
  newOrderReset: ['granted'],
  changelogEdit: ['granted'],
  bugsPage: ['public'],
  bugsEdit: ['granted'],
  annualMemberships: ['dev'],
  disablePayments: ['blue', 'red', 'public'],
  prepaidMemberships: ['public'],
  coinbasePayments: [],
  emerchantpayPayments: ['public'],
  nowpaymentPayments: [],
  thirtyDayEarlyAccess: ['granted'],
  datapacketRead: ['public'],
  modelVersionPopularity: ['mod'],
  kinguinIframe: ['dev'],
  trainingModelsModeration: ['granted'],
  serviceStatus: ['granted'],
  cashManagement: { availability: ['granted'], fliptKey: 'feature-cash-management' },
  auctionsMod: ['granted'],
  challengePlatform: ['public'],
  comicCreator: { availability: ['mod'], fliptKey: 'comic-creator' },
  licensingFee: { availability: ['user'], fliptKey: 'licensing-fee' },
  liveMetrics: { availability: ['mod'], fliptKey: 'live-metrics' },
  strikes: ['public'],
  prepaidBuzzTransactions: { availability: ['mod'], fliptKey: 'prepaid-buzz-transactions' },
  userPaymentConfiguration: {
    availability: ['granted'],
    fliptKey: 'user-payment-configuration',
  },
  articleImageScanning: ['public'],
  generationPresets: { availability: ['public'], fliptKey: 'generation-presets' },
  wildcards: { availability: ['public'], fliptKey: 'wildcards' },
  // 3D Models — split flags: feed (view/comment/review) vs generator (create).
  // Both mod-only at launch; Flipt key allows broadening without a code change.
  model3dFeed: { availability: ['mod'], fliptKey: 'model3d-feed' },
  model3dGenerator: { availability: ['mod'], fliptKey: 'model3d-generator' },
  // Retool privileged endpoints — `granted` means the moderator must carry the
  // matching permission key in user.permissions. Endpoints lookup the key
  // directly from `RetoolAction.privileged`, so the permission name MUST stay
  // in sync with the camelCase flag key here.
  retoolUpdateIdentity: ['granted'],
  retoolToggleModerator: ['granted'],
  // App Blocks (Phase 1) — gates the BlockSlot mount on model pages. Off by
  // default until we ship publisher install UX + moderator approval workflow.
  // When off, BlockSlot renders nothing and no token-issuance traffic fires.
  appBlocks: { availability: ['mod'], fliptKey: 'app-blocks-enabled' },
  // App Blocks W10 — full-page apps (`/apps/run/<slug>`). A SEPARATE dark flag
  // so the page surface enables independently of the master `app-blocks-enabled`
  // gate. The page route + page-token mint require BOTH `appBlocks` AND
  // `appBlocksPages`. Mod-only today; widened (Flipt segment) at W10 launch.
  appBlocksPages: { availability: ['mod'], fliptKey: 'app-blocks-pages-enabled' },
  // App Blocks — PUBLIC "App builders" get-started landing page (`/apps/get-started`).
  // Scope A soft launch: a single public marketing/funnel page that explains the
  // platform to would-be app developers. INDEPENDENT of the mod-only `appBlocks`
  // gate — this flag controls ONLY the public get-started page + its nav entry, NOT
  // any other `/apps/*` surface (those stay gated on `appBlocks`). Public/everyone by
  // default so the page is live for all users; the Flipt key is purely a kill switch
  // (flip it off to drop the page + nav entry without a deploy).
  appBlocksGetStarted: { availability: ['public'], fliptKey: 'app-blocks-get-started' },
});

export const featureFlagKeys = Object.keys(featureFlags) as FeatureFlagKey[];

// --------------------------
// Logic
// --------------------------
type FeatureAccessContext = {
  user?: SessionUser;
  host?: string;
  req: NextApiRequest | IncomingMessage;
};

/**
 * Unified region access checking that combines global restrictions with feature-specific controls
 * Priority order: Global restrictions > Feature excludes > Feature includes
 */
function checkRegionAccess(
  feature: FeatureFlag,
  availability: FeatureAvailability[],
  req?: NextApiRequest | IncomingMessage
): boolean {
  // Bypass all region checks in dev mode
  if (isDev) {
    return true;
  }

  // Check if feature has any region requirements
  const regionRequirements = availability.filter((x) =>
    regionAvailability.includes(x as (typeof regionAvailability)[number])
  );
  const hasFeatureRegions = !!feature.regions;

  // If no region requirements at all, allow access
  if (regionRequirements.length === 0 && !hasFeatureRegions) {
    return true;
  }

  // Get region info (only once)
  let region: RegionInfo | undefined;
  if (req) {
    region = getRegion(req);
  }

  // If region info is required but not available, deny access
  if ((regionRequirements.length > 0 || hasFeatureRegions) && !region?.countryCode) {
    return hasFeatureRegions ? false : true; // Only deny if feature has specific geo restrictions
  }

  if (!region) return true; // Should not happen at this point, but safe fallback

  const isGloballyRestricted = isRegionRestricted(region);
  const countryCode = region.countryCode?.toUpperCase();

  // Check global region availability requirements (restricted/nonRestricted)
  if (regionRequirements.length > 0) {
    const globalMatch = regionRequirements.some((requirement) => {
      return requirement === 'restricted'
        ? isGloballyRestricted
        : requirement === 'nonRestricted'
        ? !isGloballyRestricted
        : false;
    });

    // If global requirements are not met, deny access
    if (!globalMatch) return false;
  }

  // Check feature-specific region restrictions
  if (hasFeatureRegions && countryCode) {
    const { include, exclude } = feature.regions!;

    // CRITICAL: Global restrictions always override feature includes
    // If region is globally restricted, deny access regardless of feature includes
    if (isGloballyRestricted && include && include.includes(countryCode)) {
      return false;
    }

    // Check exclude list (blacklist) - always deny if in exclude
    if (exclude && exclude.length > 0 && exclude.includes(countryCode)) {
      return false;
    }

    // Check include list (whitelist) - only allow if in include list when list exists
    if (include && include.length > 0) {
      return include.includes(countryCode);
    }
  }

  return true;
}

// Lazy-loaded flipt module (server-only — avoids pulling ~/env/server into client bundle)
type FliptModule = typeof import('~/server/flipt/client');
let _fliptModule: FliptModule | null = null;
let _fliptLoading: Promise<FliptModule | null> | null = null;

function loadFliptModule(): Promise<FliptModule | null> {
  if (_fliptModule) return Promise.resolve(_fliptModule);
  if (typeof window !== 'undefined') return Promise.resolve(null);
  if (!_fliptLoading) {
    _fliptLoading = import('~/server/flipt/client')
      .then((mod) => {
        _fliptModule = mod;
        return mod;
      })
      .catch((err) => {
        console.error('[Flipt] Module load failed:', err?.message ?? err);
        // Allow retry on next call by clearing the cached promise
        _fliptLoading = null;
        return null;
      });
  }
  return _fliptLoading;
}

// Kick off loading immediately on server (non-blocking, just warms the import)
if (typeof window === 'undefined') {
  loadFliptModule();
}

export function buildFliptContext(user?: SessionUser): Record<string, string> {
  const ctx: Record<string, string> = {};
  if (user) {
    ctx.userId = String(user.id);
    ctx.isModerator = String(!!user.isModerator);
    ctx.tier = user.tier ?? 'free';
    ctx.isLoggedIn = 'true';
    ctx.isMember = String(!!user.tier && user.tier !== 'free');
  } else {
    ctx.isLoggedIn = 'false';
  }
  const deploymentId = process.env.FLIPT_DEPLOYMENT_ID;
  if (deploymentId) ctx.deploymentId = deploymentId;
  return ctx;
}

const hasFeature = (
  key: FeatureFlagKey,
  { user, req, host = req?.headers.host }: FeatureAccessContext,
  // Built once per getFeatureFlags call and threaded through — previously every
  // flag rebuilt buildFliptContext(user) (N times/request).
  fliptContext: Record<string, string>
) => {
  const feature = featureFlags[key];
  const { availability } = feature;

  // Region restrictions always apply — Flipt cannot override them.
  // Mods and granted users bypass region restrictions as before.
  const isMod = user?.isModerator;
  const hasGrantedPermission = availability.includes('granted')
    ? !!user?.permissions?.includes(key)
    : false;

  if (!(isMod || hasGrantedPermission)) {
    const regionAccess = checkRegionAccess(feature, availability, req);
    if (!regionAccess) return false;
  }

  // Server/domain restrictions always apply — Flipt cannot override them.
  // Each color maps to a primary host plus an optional alias list — any of
  // those hosts counts as "on this color". Lookup uses the precomputed
  // `colorHostSets` so we don't re-parse env on every flag check.
  let serverMatch = true;
  const availableServers = availability.filter((x) =>
    serverAvailability.includes(x as ServerAvailability)
  );
  if (!availableServers.length || !host) serverMatch = true;
  else {
    const normalizedHost = host.toLowerCase();
    serverMatch = availableServers.some((server) =>
      colorHostSets[server as ColorDomain]?.has(normalizedHost)
    );
    if (!serverMatch) return false;
  }

  // Flipt overrides role checks (both enable AND disable) — but not ENV, region, or domain.
  // When Flipt is unavailable, fall through to static evaluation.
  if (feature.fliptKey && !envOverriddenFlags.has(key) && _fliptModule) {
    const fliptResult = _fliptModule.isFliptSync(
      feature.fliptKey,
      user ? String(user.id) : 'anonymous',
      fliptContext
    );
    if (fliptResult !== null) {
      if (isDev) {
        console.log(`[Flipt] ${key} (${feature.fliptKey}) => ${fliptResult}`);
      }
      return fliptResult;
    }
    // Flipt unavailable — fall through to static evaluation below
  }

  // --- Static evaluation (used when no Flipt override or Flipt unavailable) ---

  // Check environment availability
  const envRequirement = availability.includes('dev') ? isDev : availability.length > 0;

  // Check granted access
  const grantedAccess = availability.includes('granted')
    ? !!user?.permissions?.includes(key)
    : false;

  // Check role availability
  const roles = availability.filter((x) => roleAvailablity.includes(x as RoleAvailability));
  let roleAccess = roles.length === 0 || roles.includes('public');
  if (!roleAccess && roles.length !== 0 && !!user) {
    if (roles.includes('user')) roleAccess = true;
    else if (roles.includes('mod') && user.isModerator) roleAccess = true;
    else if (!!user.tier && user.tier != 'free') {
      if (roles.includes('member')) roleAccess = true; // Gives access to any tier
      else if (roles.includes(user.tier as RoleAvailability)) roleAccess = true; // Gives access to specific tier
    }
  }

  // Check basic access (env, server, roles)
  const hasBasicAccess = envRequirement && serverMatch && (grantedAccess || roleAccess);
  if (!hasBasicAccess) return false;

  return true;
};

// Sparse payload at runtime: only `true` flags are actually present, absent keys
// are `undefined`. Type stays as `Record<FeatureFlagKey, boolean>` so consumers
// read `features.X` as `boolean` without coercion. Truthy checks work the same
// way against `false` and `undefined`. Removing a flag from the registry shrinks
// `FeatureFlagKey`, which surfaces a type error at every consumer.
export type FeatureAccess = Record<FeatureFlagKey, boolean>;

function computeFeatureFlags(ctx: FeatureAccessContext): FeatureAccess {
  // Build the Flipt context once and reuse for every flag (was rebuilt per flag).
  const fliptContext = buildFliptContext(ctx.user);
  const keys = Object.keys(featureFlags) as FeatureFlagKey[];
  return keys.reduce<FeatureAccess>((acc, key) => {
    if (!hasFeature(key, ctx, fliptContext)) return acc;
    const feature = featureFlags[key];
    // Toggleable flags resolve to their default at the base layer. Logged-in
    // users get their stored choice merged on top client-side (via
    // user.getFeatureFlags), but anonymous users have no override — so a
    // default-off toggleable (e.g. postsNavItem) must stay off for them rather
    // than leak through on bare access.
    if (feature.toggleable && feature.default === false) return acc;
    acc[key] = true;
    return acc;
  }, {} as FeatureAccess);
}

// getFeatureFlags is PURE given (user identity, host, region, live Flipt config):
// same inputs => same FeatureAccess. It runs on every request that touches
// ctx.features (the image feed does), evaluating ~all flags — each previously
// rebuilding the Flipt context and calling isFliptSync. Memoize the whole result
// with a short TTL so repeat requests from the same (user, host, region) — e.g.
// one user scrolling the feed (many getInfinite calls) — skip the per-flag work.
//
// KEY COMPLETENESS IS A CORRECTNESS INVARIANT. The cache key must include EVERY
// input hasFeature reads: user id/isModerator/tier/permissions, host (domain
// gating), and the FULL region. Region gates compliance-sensitive
// restricted-region features, so two different regions must NEVER share an entry
// — the whole region object is serialized into the key to guarantee that. Live
// Flipt config changes are bounded by the TTL (same staleness as the per-eval
// cache in flipt/client.ts). Mutation-safety: the cached object is never handed
// out — callers always get a shallow copy.
const FEATURE_ACCESS_TTL_MS = 10_000;
const FEATURE_ACCESS_MAX = 20_000;
type FeatureAccessEntry = { value: FeatureAccess; expiresAt: number };
let featureAccessCur = new Map<string, FeatureAccessEntry>();
let featureAccessPrev = new Map<string, FeatureAccessEntry>();

function featureAccessKey({ user, req, host = req?.headers.host }: FeatureAccessContext): string {
  // In dev, checkRegionAccess bypasses region entirely, so it can't affect the
  // result and is omitted from the key. Also guard a nullish req (parity with
  // checkRegionAccess's `if (req)`) so key construction never throws.
  const region = isDev || !req ? undefined : getRegion(req);
  const u = user
    ? `u:${user.id}:${user.isModerator ? 1 : 0}:${user.tier ?? 'free'}:${(user.permissions ?? [])
        .slice()
        .sort()
        .join(',')}`
    : 'anon';
  return `${u}|h:${host ?? ''}|r:${region ? JSON.stringify(region) : ''}`;
}

export const getFeatureFlags = (ctx: FeatureAccessContext): FeatureAccess => {
  const now = Date.now();
  const key = featureAccessKey(ctx);

  let entry = featureAccessCur.get(key);
  if (entry) {
    if (entry.expiresAt > now) return { ...entry.value };
    featureAccessCur.delete(key);
  }
  entry = featureAccessPrev.get(key);
  if (entry) {
    if (entry.expiresAt > now) {
      featureAccessPrev.delete(key);
      featureAccessCur.set(key, entry); // promote so hot keys survive rotation
      return { ...entry.value };
    }
    featureAccessPrev.delete(key);
  }

  const value = computeFeatureFlags(ctx);
  // Generational rotation (bounds memory to ~2x MAX without a full-clear thrash).
  if (featureAccessCur.size >= FEATURE_ACCESS_MAX) {
    featureAccessPrev = featureAccessCur;
    featureAccessCur = new Map();
  }
  featureAccessCur.set(key, { value, expiresAt: now + FEATURE_ACCESS_TTL_MS });
  return { ...value };
};

export function getFeatureFlagsLazy(ctx: FeatureAccessContext) {
  const obj = {} as FeatureAccess & { features: FeatureAccess };

  for (const key in featureFlags) {
    Object.defineProperty(obj, key, {
      get() {
        if (!obj.features) {
          obj.features = getFeatureFlags(ctx);
        }
        return obj.features[key as keyof FeatureAccess];
      },
    });
  }
  return obj as FeatureAccess;
}

export async function getFeatureFlagsAsync(ctx: FeatureAccessContext) {
  // Ensure Flipt module is loaded and initialized (timeout + circuit breaker in FliptSingleton)
  const flipt = await loadFliptModule();
  if (flipt) {
    await flipt.ensureFliptInitialized();
  }
  return getFeatureFlags(ctx);
}

export const toggleableFeatures = Object.entries(featureFlags)
  .filter(([, value]) => value.toggleable)
  .map(([key, value]) => ({
    key: key as FeatureFlagKey,
    displayName: value.displayName,
    description: value.description,
    default: value.default ?? true,
  }));

export const domainRestrictedToggleableKeys = new Set(
  Object.entries(featureFlags)
    .filter(([, value]) => {
      if (!value.toggleable) return false;
      const servers = value.availability.filter((x) =>
        serverAvailability.includes(x as ServerAvailability)
      );
      return servers.length > 0;
    })
    .map(([key]) => key as FeatureFlagKey)
);

export const defaultToggleableFeatures = toggleableFeatures.reduce(
  (acc, feature) => ({ ...acc, [feature.key]: feature.default }),
  {} as FeatureAccess
);

/**
 * Pure computation of the per-user toggleable-feature overlay returned by
 * `user.getFeatureFlags`. Single source of truth shared by the tRPC resolver
 * (`getUserFeatureFlagsHandler`) and the SSR seed in `_app` getInitialProps —
 * keeping the SSR-injected `initialData` byte-identical to a live fetch.
 *
 * @param userFeatures the stored `settings.features` JSON record (toggle choices)
 * @param hostFeatures the request's already-resolved host-level FeatureAccess
 *   (the controller's `ctx.features`) — used to enforce domain restrictions.
 */
export function computeUserFeatureFlagsOverlay(
  userFeatures: Record<string, boolean> | undefined,
  hostFeatures: FeatureAccess
): FeatureAccess {
  const features = userFeatures ?? {};

  // filter toggleable features from user settings
  const filteredUserFeatures = Object.keys(features).reduce(
    (acc, key) =>
      toggleableFeatures.some((x) => x.key === key) ? { ...acc, [key]: features[key] } : acc,
    {} as FeatureAccess
  );

  const result = {
    ...defaultToggleableFeatures,
    ...filteredUserFeatures,
  } as FeatureAccess;

  // Don't let toggleable defaults override domain restrictions
  for (const key of domainRestrictedToggleableKeys) {
    if (key in result && !hostFeatures[key]) {
      delete result[key];
    }
  }

  return result;
}

type FeatureAvailability = (typeof featureAvailability)[number];
export type FeatureFlagKey = keyof typeof featureFlags;

type GeoRestrictions = {
  include?: string[]; // Whitelist regions (country codes)
  exclude?: string[]; // Blacklist regions (country codes)
};

type FeatureFlag = {
  displayName: string;
  description?: string;
  availability: FeatureAvailability[];
  toggleable: boolean;
  default?: boolean;
  regions?: GeoRestrictions; // Optional geo restrictions
  fliptKey?: string; // Optional Flipt flag key for remote toggling
};

// Simplified: Support either simple arrays or objects with any FeatureFlag properties
type FeatureFlagInput =
  | FeatureAvailability[] // Legacy format: ['public']
  | (Partial<FeatureFlag> & { availability: FeatureAvailability[] }); // Object with at least availability

function createFeatureFlags<T extends Record<string, FeatureFlagInput>>(flags: T) {
  const features = {} as { [K in keyof T]: FeatureFlag };
  const envOverrides = getEnvOverrides();

  for (const [key, value] of Object.entries(flags)) {
    // Convert arrays to object format for consistency
    const flagData = Array.isArray(value) ? { availability: value } : value;

    // Build the feature flag with defaults for missing properties
    features[key as keyof T] = {
      displayName: getDisplayName(key), // Default display name
      toggleable: false, // Default not toggleable
      ...flagData, // Spread all provided properties (overrides defaults)
    } as FeatureFlag;

    // Apply ENV overrides
    const override = envOverrides[key as FeatureFlagKey];
    if (override) {
      features[key as keyof T].availability = override;
      envOverriddenFlags.add(key);
    }
  }

  return features;
}

function getEnvOverrides() {
  const processFeatureAvailability: Partial<Record<FeatureFlagKey, FeatureAvailability[]>> = {};
  // Set flags from ENV
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('FEATURE_FLAG_')) continue;
    const featureKey = camelCase(key.replace('FEATURE_FLAG_', ''));
    const availability: FeatureAvailability[] = [];

    for (const x of value?.split(',') ?? []) {
      if (featureAvailability.includes(x as FeatureAvailability))
        availability.push(x as FeatureAvailability);
    }
    processFeatureAvailability[featureKey as FeatureFlagKey] = availability;
  }

  return processFeatureAvailability;
}
