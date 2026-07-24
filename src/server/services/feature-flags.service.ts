import type { IncomingMessage } from 'http';
import { camelCase } from 'lodash-es';
import type { NextApiRequest } from 'next';
import type { SessionUser } from '~/types/session';
import { isDev } from '~/env/other';
import type { RegionInfo } from '~/server/utils/region-blocking';
import { getRegion, isRegionRestricted } from '~/server/utils/region-blocking';
import { getDisplayName } from '~/utils/string-helpers';
import { colorDomainNames, type ColorDomain } from '~/shared/constants/domain.constants';
import { OnboardingSteps } from '~/server/common/enums';
import { Flags } from '~/shared/utils/flags';

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
  // Faro RUM frontend observability. Default OFF (mods only); widen the cohort via
  // Flipt (`faro`). Runtime kill-switch for the Faro Web SDK — the FaroProvider only
  // initialises when this flag is on AND the NEXT_PUBLIC_FARO_* build-args are set.
  faro: { availability: ['mod'], fliptKey: 'faro' },
  // Cohort-ramp gate for the Faro resource_timing decomposition. SEPARATE from `faro` so the
  // network-phase measurements can be ramped by % of users at runtime (via Flipt) independently
  // of the main RUM signals — the FaroProvider includes ResourceTimingInstrumentation only when
  // this flag is on AND the NEXT_PUBLIC_FARO_RESOURCE_TIMING_ENABLED build-arg is set.
  // availability ['mod'] is the Flipt-DOWN fallback (mirrors `faro`); Flipt is authoritative
  // when the flag exists — ramp by bumping its % rollout, never all-at-once.
  faroResourceTiming: { availability: ['mod'], fliptKey: 'faro-resource-timing' },
  // Cohort-ramp gate for tRPC request batching (httpBatchStreamLink). Default OFF
  // (mods only) so batching is dark until ramped via Flipt (`trpc-batching`). Batching
  // is applied ONLY to AUTHENTICATED-browser queries — anonymous tRPC GETs stay
  // unbatched so they remain CF edge-cacheable (verified: anon `model.getAll` GET
  // returns cf-cache-status HIT with s-maxage=60; authed requests have edgeTTL forced
  // to 0 in createContext, so batching them loses no edge cache). availability ['mod']
  // is the Flipt-DOWN fallback (mirrors `faro`); Flipt is authoritative when the flag
  // exists — ramp by bumping its % rollout, never all-at-once. See `src/utils/trpc.ts`.
  trpcBatching: { availability: ['mod'], fliptKey: 'trpc-batching' },
  // Feed-page CLS fix. Reserves vertical space for the above-feed announcements
  // banner during the pre-hydration window so the isClient-gated / dynamically
  // imported carousel mount doesn't shove the (very tall) masonry feed down — the
  // shift production RUM attributes to `MasonryContainer .queries`, which is the
  // DISPLACED VICTIM (largest moved element), not the cause. Default OFF (mods
  // only = the Flipt-DOWN fallback); ramp a % of ALL
  // users via Flipt (`feed-reserve-cls`) as a THRESHOLD rollout — CLS is an
  // all-user route metric, so a mod cohort can't move the aggregate. Purely
  // cosmetic space reservation (worst case = a little dead space, never a
  // functional break), so flipping the flag off is an instant, safe rollback.
  feedReserveCls: { availability: ['mod'], fliptKey: 'feed-reserve-cls' },
  // Perf: emit the COMPACT wire shape for `hiddenPreferences.getHidden` (id-only
  // arrays for the model / model3d / explicit-image sets instead of
  // `{ id, hidden: true }` objects). `getHidden` returns a user's ENTIRE hidden
  // set; for a whale it superjson-serializes ~12.4MB / ~1.15s SYNCHRONOUSLY on
  // every response (incl. cache hits) — the single worst event-loop freeze in
  // the `trpc-response-oversized` dataset (twin of `user.getEngagedModels`). The
  // client re-expands to the legacy shape so downstream data is identical —
  // BUT ONLY a client bundle that ships with this PR (which contains
  // `expandHiddenPreferences`). A PRE-PR bundle reads the compact `number[]` as
  // `{ id }[]`, gets `x.id === undefined`, and UN-HIDES the user's entire hidden
  // set (incl. NSFW/moderated) until a hard reload.
  //
  // 🔴 RAMP DISCIPLINE: `availability: []` = DARK by default and FAILS CLOSED
  // (empty availability → static eval false when Flipt is absent/down), so the
  // Flipt `hidden-prefs-compact` threshold is the ONLY on-switch. NOT `['mod']`:
  // that would turn compact ON for every mod the instant the server deploys,
  // while their tabs may still run the OLD bundle → guaranteed un-hide exposure
  // window on every deploy. Deploy dark, CONFIRM the new bundle is serving
  // everywhere (hours — see the SPA-cache rollout pattern), THEN ramp the Flipt
  // threshold; never ramp during/immediately-after a deploy. Instant rollback =
  // set the threshold to 0. Verify via
  // `trpc-response-oversized {path="hiddenPreferences.getHidden"}` serializeMs tail.
  // (Mirrors the `genTabDeferView` / `coinbasePayments` `availability: []` precedent.)
  hiddenPrefsCompact: { availability: [], fliptKey: 'hidden-prefs-compact' },
  // Perf experiment: defer the generation-tab-switch remount (useDeferredValue) to fix
  // mobile INP (p75 ~304ms, dominant phase = processing_duration; the gen-tab switch is
  // the single hottest interaction). `availability: []` = DARK by default and fails CLOSED when
  // the Flipt flag is absent or Flipt is down (empty availability → static eval false), so the
  // deferral only turns on via the Flipt `gen-tab-defer-view` THRESHOLD rollout — a clean all-user
  // A/B with NO mod segment (a mod cohort contaminated a prior A/B). NOT `['public']`: that would
  // fail OPEN (true for 100% of users) whenever the Flipt key is missing/unreachable, defeating
  // the A/B (no flag-off cohort) and shipping the deferral fleet-wide unmeasured. OFF =
  // byte-identical to today. Measured via RUM `exp_gen_tab_defer_view`. Instant safe rollback.
  genTabDeferView: { availability: [], fliptKey: 'gen-tab-defer-view' },
  // Serialize-perf: LAZY per-post image load on `image.getImagesAsPostsInfinite` (the #2
  // producer of oversized/event-loop-freezing tRPC responses). Model galleries carry
  // multi-image showcase posts (17% have >12 images; p90/p99 ≈ 20). When ON the server
  // returns only the first `GALLERY_POST_IMAGE_SLICE` (6) images per post PLUS the true
  // `imageCount`; the card carousel lazy-loads the remainder on approach via
  // `trpc.image.getInfinite({ postId })`. So the gallery is NOT truncated — only the initial
  // payload shrinks (a large cut on the heavy tail). OFF = byte-identical to today (all
  // images inline, no `imageCount`).
  //
  // 🔴 SERVER-SIDE flag → STALE-CLIENT RAMP DISCIPLINE (same class as the shape-swap flags):
  // a PRE-this-PR bundle (no lazy-load code) would render only the 6-image slice with
  // `total = slice.length` → "6 of 6" instead of "1 of 20" until the user reloads. That's a
  // UX-truncation regression (NOT content-unsafe; browsing-level filtering is unchanged),
  // self-healing on reload. Hence `availability: []` = DARK by default, fails CLOSED (no
  // slice) when Flipt is absent/down; the Flipt `gallery-lazy-post-images` THRESHOLD is the
  // ONLY on-switch. Ramp ONLY after the new bundle is serving everywhere (confirm via RUM
  // app_version — hours, per the SPA-cache rollout pattern); threshold-only; instant rollback =
  // drop the threshold to 0. Supersedes the retired `imagesAsPostsPerPostCap` cap flag (which
  // truncated the gallery and was never ramped). (Mirrors the genTabDeferView precedent.)
  galleryLazyPostImages: { availability: [], fliptKey: 'gallery-lazy-post-images' },
  // Serialize-perf: SLIM the per-model image count on `model.getAll` — the #1
  // producer of oversized / event-loop-freezing tRPC responses (the
  // `trpc-response-oversized` #3017 dataset; p90 > 1MB, ~20x the next path). When
  // ON, the browse-feed response caps each model to `GET_ALL_IMAGES_PER_MODEL_SLIM`
  // (6) images instead of `GET_ALL_IMAGES_PER_MODEL` (12) — a ~42% page-byte cut
  // (the always-on per-image field trim in `model-getall-images` applies either
  // way). The browse `ModelCard` renders only the cover, so nothing VISIBLE
  // changes; the residual risk is browsing-level FEED-DROP: the shared image cache
  // is ordered `postId,index` (browsing-agnostic), so a mixed-level model whose only
  // browsing-safe image sits past index 6 could be dropped from an SFW-mode viewer's
  // feed (`hidden.noImages`). The flag-ON path MITIGATES this by picking an
  // nsfw-biased COVERAGE slice (`selectSlimGetAllModelImages`) instead of the naive
  // first-6 — it keeps one image of every distinct `nsfwLevel` bit present, so any
  // viewer with a visible image in the full set keeps one in the slice (image
  // `nsfwLevel` is a single bit, ≤6 distinct, all fit in 6). Still `availability: []`
  // = DARK by default and FAILS
  // CLOSED (empty availability → static eval false when Flipt is absent/down), so
  // the cap stays 12 (byte-identical COUNT to today) unless the Flipt
  // `get-all-model-images-slim` threshold is ramped. Deploy dark, then ramp the
  // threshold WHILE watching the feed-drop rate (Loki
  // `event_name="feed_noimages_drop"`, `~/utils/faro/feedDrop`); instant rollback =
  // set the threshold to 0. (Mirrors the galleryLazyPostImages / genTabDeferView
  // dark-flag precedent.) No client bundle change is required (the feed already
  // renders any-length image arrays), so this is a pure server behavior flag.
  getAllModelImagesSlim: { availability: [], fliptKey: 'get-all-model-images-slim' },
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
  // Anima ControlNet kill-switch. Default ON (public + fail-open when Flipt is
  // down); the `anima-controlnet` Flipt flag is the lever — flip it OFF to hide
  // the Anima ControlNet input (and strip controlNets server-side) without a
  // deploy if the orchestrator side misbehaves.
  animaControlnet: { availability: ['public'], fliptKey: 'anima-controlnet' },
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
  // Mods get it by default; unlock testers via the `creator-shop` Flipt flag.
  creatorShop: { availability: ['mod'], fliptKey: 'creator-shop' },
  impersonation: isDev ? ['mod'] : ['granted'],
  donationGoals: ['public'],
  creatorComp: ['public'],
  // Creator Controls account card (metric-privacy + donation-goal settings UI).
  // `availability: []` = DARK by default and FAILS CLOSED (empty availability →
  // static eval false when Flipt is absent/down), so the card does NOT render for
  // anyone until the `creator-controls` Flipt flag is created + enabled. This gates
  // ONLY the card render in the account page; the read-side metric-privacy gating
  // (donation-goals-cache / model-metric-privacy resolvers / model.service etc.)
  // stays active regardless so existing user settings keep applying even when the
  // card is hidden. Instant kill-switch / widen lever = the Flipt flag. (Mirrors the
  // `hiddenPrefsCompact` / `genTabDeferView` `availability: []` precedent.)
  creatorControls: { availability: [], fliptKey: 'creator-controls' },
  // Read-time gate for the Creator-Controls metric-privacy RESOLUTION (#3266): the
  // per-request synchronous work that hides a CP member's model/version metrics —
  // the batched `getValidCreatorMembershipMap` (a `subscriptionProductMetadataSchema`
  // Zod parse per subscription), the owner-settings lookups, and the per-item
  // `resolveModel/VersionHiddenMetrics`. Default ON: `availability: ['public']` keeps
  // it enabled for everyone AND fails OPEN (ON) when Flipt is absent/down, so merging
  // + releasing is a pure no-op — the privacy feature keeps working exactly as today.
  // Flipt is authoritative when the `model-metric-privacy-readtime` flag exists:
  // flipping it OFF makes every gated read path SKIP that work entirely and return the
  // RAW (pre-#3266) metrics, for a controlled A/B of its request-path cost. OFF briefly
  // re-exposes CP members' hidden metrics for the test window (accepted, keep it short).
  // NOT `[]`: that would fail CLOSED and default the feature off. (Mirrors the
  // `challengePlatform` / `animaControlnet` `['public']` + fliptKey fail-open precedent.)
  modelMetricPrivacyReadtime: {
    availability: ['public'],
    fliptKey: 'model-metric-privacy-readtime',
  },
  imageIndexFeed: { availability: ['public'], fliptKey: 'image-index-feed' },
  // Rewrite orchestrator blob URLs to the Cloudflare-fronted proxy for RU users
  // (their ISPs DPI-block the bare orchestration origin). `availability: []` =
  // DARK by default and FAILS CLOSED (empty availability → static eval false when
  // Flipt is absent/down), so the rewrite stays OFF unless the `ru-orchestrator-proxy`
  // Flipt flag is enabled — the flag is both the on-switch at rollout AND the
  // instant kill-switch if the proxy misbehaves. The rewrite itself additionally
  // gates on cf-ipcountry === 'RU', so non-RU users are never affected either way.
  // See ClickUp 868kdkv93 / 868ke4d0f. (Mirrors the `creatorControls` /
  // `hiddenPrefsCompact` `availability: []` fail-closed precedent.)
  ruOrchestratorProxy: { availability: [], fliptKey: 'ru-orchestrator-proxy' },
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
  // Platform-wide challenge kill-switch. Flipt is authoritative; availability ['public'] is the
  // Flipt-DOWN / flag-absent fallback (so an outage leaves the platform ON, matching prior behavior).
  challengePlatform: { availability: ['public'], fliptKey: 'challenge-platform-enabled' },
  // Public user-created challenges. Flipt is the on/off kill-switch; availability ['public'] is the
  // Flipt-DOWN / flag-absent fallback (so a Flipt outage — or deploying before the flag exists —
  // leaves it PUBLIC). Create the `user-challenges` Flipt flag DISABLED before this deploys.
  userChallenges: { availability: ['mod'], fliptKey: 'user-challenges' },
  comicCreator: { availability: ['mod'], fliptKey: 'comic-creator' },
  licensingFee: { availability: ['user'], fliptKey: 'licensing-fee' },
  liveMetrics: { availability: ['mod'], fliptKey: 'live-metrics' },
  strikes: ['public'],
  prepaidBuzzTransactions: { availability: ['mod'], fliptKey: 'prepaid-buzz-transactions' },
  buzzTransactionExport: { availability: ['public'], fliptKey: 'buzz-transaction-export' },
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
  // Per-model 3D generator gates, layered UNDER `model3dGenerator` (which gates
  // the whole 3D surface). Let Tripo & Hunyuan3D ship dark and roll out
  // independently of Meshy (PolyGen) via Flipt. Off ⇒ the ecosystem is hidden
  // from the img2model3d picker and rejected on submit (see ecosystem-graph.ts).
  tripoGenerator: { availability: ['mod'], fliptKey: 'tripo-generator' },
  hunyuan3dGenerator: { availability: ['mod'], fliptKey: 'hunyuan3d-generator' },
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
  // App Blocks W13 — dedicated App Store VISIBILITY flag, decoupled from
  // `app-blocks-enabled` (which doubles as the block-runtime kill-switch) so the
  // store catalog can widen to public INDEPENDENTLY of the held block-runtime GA.
  // Store-visibility surfaces gate on `appListings || appBlocks` (client) /
  // `isAppListingsEnabled()` which falls back to `isAppBlocksEnabled()` (server),
  // so while the `app-listings` Flipt flag does not yet exist this resolves via
  // the `availability: ['mod']` Flipt-down fallback (mods only) + the OR-fallback
  // to `app-blocks-enabled` — i.e. ZERO behavior change today (the currently
  // mod+app-dev-testers cohort keeps identical store access).
  appListings: { availability: ['mod'], fliptKey: 'app-listings' },
  // App Blocks W10 — full-page apps (`/apps/run/<slug>`). A SEPARATE dark flag
  // so the page surface enables independently of the master `app-blocks-enabled`
  // gate. The page route + page-token mint require BOTH `appBlocks` AND
  // `appBlocksPages`. Mod-only today; widened (Flipt segment) at W10 launch.
  appBlocksPages: { availability: ['mod'], fliptKey: 'app-blocks-pages-enabled' },
  // App Blocks — "App builders" get-started landing page (`/apps/get-started`).
  // Scope A soft launch: a single marketing/funnel page that explains the
  // platform to would-be app developers. INDEPENDENT of the mod-only `appBlocks`
  // gate — this flag controls ONLY the get-started page + its nav entry, NOT
  // any other `/apps/*` surface (those stay gated on `appBlocks`). Staged
  // mod-only today (like `appBlocks` / `appBlocksPages`) so it deploys dark-to-
  // public and mods can review the page live on prod; widened to `['public']`
  // (a one-line flag change) when launch copy + the real Request-access link
  // land. The Flipt key stays the kill-switch / future-widen lever (flip it off
  // to drop the page + nav entry without a deploy).
  appBlocksGetStarted: { availability: ['mod'], fliptKey: 'app-blocks-get-started' },
  // App Blocks — AUTHOR capability (developer soft-launch, Phase B). Grants the
  // right to SUBMIT apps + use `dev:live` (the author surfaces + the runtime
  // spend gate on a block-token subject). INDEPENDENT of the mod-only
  // marketplace-visibility `appBlocks` flag ON PURPOSE: `appBlocks` widens to
  // `public` at GA, but authoring must stay gated, so the author authz decision
  // keys off THIS flag, never `appBlocks`. Mirrors `appBlocks` shape — staged
  // mod-only today (`['mod']` = the Flipt-down / flag-absent fallback), widened
  // to mods + a curated cohort via the Flipt `app-blocks-author` flag (created
  // AFTER this merges: absent → static mod-only, identical to today).
  appBlocksAuthor: { availability: ['mod'], fliptKey: 'app-blocks-author' },
  // App Blocks — AGENTIC MOD CODE-REVIEW panel (P2). CLIENT gate for the
  // `AgentReviewPanel` in the on-site review modal. `availability: []` = DARK by
  // default and FAILS CLOSED (empty availability → static eval false when Flipt
  // is absent/down), so the panel does NOT render for ANYONE — mods included —
  // until the Flipt `app-blocks-agentic-review` flag is created. This mirrors the
  // server-side `isAppBlocksAgenticReviewEnabled` fail-closed gate on the
  // `blocks.startAgentReview` / `getAgentReview` procs, so the whole feature is
  // inert end-to-end on merge (NOT `['mod']`: that would render the panel for
  // mods the moment this ships, before the flag exists). The Flipt key is the
  // only on-switch + kill-switch. (Mirrors the `hiddenPrefsCompact` /
  // `genTabDeferView` `availability: []` precedent.)
  appBlocksAgenticReview: { availability: [], fliptKey: 'app-blocks-agentic-review' },
  // App Blocks — dedicated per-submission REVIEW PAGE (`/apps/review/<id>`). A
  // flag-gated, deep-linkable full page that re-hosts the existing on-site review
  // body (today a modal on `/apps/review`) so mods can open, share, and refresh a
  // single submission. `availability: ['mod']` (NOT `[]`): mods get the page the
  // moment this ships — the page is a re-host of the already-live review UI (no
  // new capability, no unapproved-code execution beyond what the modal already
  // does), so dogfooding on merge is the intent. A non-mod still fails closed:
  // 'mod' availability → static false for any non-mod segment AND the page's SSR
  // gate additionally requires `isAppReviewer`. The Flipt `app-review-page` flag
  // (created later) is the widen/kill lever; absent → this static mod-only default.
  // Wired like `appBlocksAgenticReview` (client reads `features.appReviewPage`,
  // the route SSR resolver reads the same resolved flag) but staged `['mod']`
  // rather than `[]` because it's a re-host, not a brand-new dark capability.
  appReviewPage: { availability: ['mod'], fliptKey: 'app-review-page' },
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
    // Creator Program membership is recorded as an onboarding-step bit
    // (set on join in creator-program.service, cleared on leave).
    ctx.isInCreatorProgram = String(Flags.hasFlag(user.onboarding, OnboardingSteps.CreatorProgram));
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

/**
 * SINGLE per-key evaluator — the one place that decides whether a flag key is
 * "present" (i.e. `true`) in the sparse FeatureAccess payload. BOTH the eager
 * `computeFeatureFlags` (every key) and the per-flag lazy getter
 * (`getFeatureFlagsLazy`, only accessed keys) call THIS, so the two paths cannot
 * diverge — the lazy per-flag result for key X is provably the same value eager
 * puts at X. Semantics (must match the historical inline `computeFeatureFlags`
 * body exactly):
 *   1. `hasFeature` false ⇒ absent (env/region/host/role + Flipt gating).
 *   2. A toggleable flag whose `default === false` is absent at the base layer —
 *      logged-in users get their stored choice merged client-side (via
 *      user.getFeatureFlags), but anonymous users have no override, so a
 *      default-off toggleable (e.g. postsNavItem) must stay off on bare access.
 *   3. Otherwise present.
 * `fliptContext` is threaded in (built once per compute via buildFliptContext)
 * so a single lazy request reuses one context across every accessed key, exactly
 * as eager reuses it across every key.
 */
function isFeatureFlagKeyPresent(
  key: FeatureFlagKey,
  ctx: FeatureAccessContext,
  fliptContext: Record<string, string>
): boolean {
  if (!hasFeature(key, ctx, fliptContext)) return false;
  const feature = featureFlags[key];
  if (feature.toggleable && feature.default === false) return false;
  return true;
}

function computeFeatureFlags(ctx: FeatureAccessContext): FeatureAccess {
  // Build the Flipt context once and reuse for every flag (was rebuilt per flag).
  const fliptContext = buildFliptContext(ctx.user);
  const keys = Object.keys(featureFlags) as FeatureFlagKey[];
  return keys.reduce<FeatureAccess>((acc, key) => {
    // Delegate the per-key decision to the shared evaluator so eager output is
    // byte-identical to the lazy per-flag path (same code, same order).
    if (isFeatureFlagKeyPresent(key, ctx, fliptContext)) acc[key] = true;
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

/**
 * PER-FLAG lazy FeatureAccess. Accessing `features.X` evaluates ONLY key `X`
 * (via the shared `isFeatureFlagKeyPresent`), instead of forcing a full
 * `computeFeatureFlags` of all ~145 flags on first touch. This is the structural
 * fix for the base tRPC chain (`applyDomainFeature`) reading a single Flipt-free
 * flag (`canViewNsfw`) and paying for up to 64 wasm `evaluateBoolean` calls:
 *   - reading `canViewNsfw` (no fliptKey) now evaluates ZERO Flipt flags;
 *   - reading one fliptKey'd flag evaluates ONLY that flag (still through the
 *     wasm eval cache in flipt/client.ts — no per-eval hit-rate regression).
 *
 * Correctness: the returned value for any key is identical to
 * `getFeatureFlags(ctx)[key]` — both go through `isFeatureFlagKeyPresent`, and
 * `fliptContext` is built once per request (memoized) exactly as eager builds it
 * once per compute. Sparse semantics are preserved: a non-present key reads as
 * `undefined` (property returns `undefined`, not `false`), matching the eager
 * object where absent keys are `undefined`. Per-key results are memoized so
 * repeat reads of the same key within a request are stable and free. Code that
 * reads many keys (e.g. isFlagProtected) simply triggers several per-key
 * computes — each still cheap for Flipt-free keys and eval-cached for Flipt ones.
 *
 * NOTE: unlike the previous implementation, this does NOT populate/read the
 * whole-result cache in `getFeatureFlags` — that cache exists to amortize the
 * full 145-flag compute, which is precisely the work we now avoid. Eager callers
 * (user.getFeatureFlags, the SSR seed) still use that cache directly.
 */
export function getFeatureFlagsLazy(ctx: FeatureAccessContext) {
  const obj = {} as FeatureAccess;
  // Built once on first flag access and reused for every accessed key this
  // request — mirrors eager's "build fliptContext once per compute".
  let fliptContext: Record<string, string> | undefined;
  // Per-key memo so a second read of the same key is stable + free (and can't
  // re-hit Flipt). Stores the raw presence boolean; the getter maps it to the
  // sparse `true | undefined` wire value.
  const memo = new Map<string, boolean>();

  for (const key in featureFlags) {
    Object.defineProperty(obj, key, {
      // Match the previous descriptor: non-enumerable (data-shape-identical to
      // the old lazy object) with only a getter.
      get() {
        let present = memo.get(key);
        if (present === undefined) {
          if (!fliptContext) fliptContext = buildFliptContext(ctx.user);
          present = isFeatureFlagKeyPresent(key as FeatureFlagKey, ctx, fliptContext);
          memo.set(key, present);
        }
        // Sparse semantics: present ⇒ true, absent ⇒ undefined (NOT false), so
        // `features.X === getFeatureFlags(ctx).X` holds for every key.
        return present ? true : undefined;
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
