import { logToAxiom } from '~/server/logging/client';
import { createHash } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { CacheTTL } from '~/server/common/constants';
import { REDIS_KEYS } from '~/server/redis/client';
import type { FeatureAccess } from '~/server/services/feature-flags.service';
import {
  assertGenerationInputsUsable,
  type GenerationInputEntryPoint,
} from '~/server/services/generation-input-urls';
import { dbRead, dbWrite } from '~/server/db/client';
import { findTeamRemixWaiver } from '~/server/events/team-remix-waiver';
import { getTeamWaiverStanding } from '~/server/services/remix-gallery.service';
import {
  getEnabledRemixApps,
  getRemixAppRegistry,
} from '~/server/services/remix-app-registry.service';
import { assertImageVisibleToViewer } from '~/server/services/image-visibility.service';
import { bustQueriedWorkflowsCache } from '~/server/services/orchestrator/orchestration-new.service';
import {
  buildPresetGraphInput,
  submitPresetImageGen,
  whatIfPresetImageGen,
  type PresetEngine,
} from '~/server/services/orchestrator/preset-image-gen.service';
import { resolveTestingAccess } from '~/server/services/generation/generation.service';
import { getAllowedAccountTypes } from '~/server/utils/buzz-helpers';
import { fetchThroughCache } from '~/server/utils/cache-helpers';
import type { GenerationAspectRatio } from '~/shared/constants/generation.constants';
import {
  TEAM_REMIX_SLUG,
  teamRemixApp,
  type RemixAppDefinition,
} from '~/shared/constants/remix-apps.constants';
import { resolveRemixAppEngine } from '~/shared/utils/remix-apps';
import type { RemixApp, RemixImage, RemixWorkflowRequest } from '~/shared/remix-apps/define';
import { firstAnswer } from '~/shared/remix-apps/mock-host';
import { type RemixLogEntry, RemixReplayError, replayRemixApp } from '~/shared/remix-apps/replay';
import { remixRunTags } from '~/shared/remix-apps/tags';
import {
  getRemixSourceUrl,
  REMIX_FALLBACK_DIMENSIONS,
  type RemixSourceImage,
} from '~/shared/utils/remix-tier';
import type { SessionUser } from '~/types/session';
import { findClosestAspectRatio } from '~/utils/aspect-ratio-helpers';

/** The buckets a `source` aspect ratio snaps to; the graph snaps again to what the engine supports. */
const ASPECT_BUCKETS: GenerationAspectRatio[] = [
  '21:9',
  '16:9',
  '3:2',
  '5:4',
  '4:3',
  '1:1',
  '3:4',
  '4:5',
  '2:3',
  '9:16',
];

/** One source image per run; a cap above it would let a definition change send more. */
const MAX_REFERENCE_IMAGES = 1;

/** Every remix app, disabled ones too, so the tray can name a run of one; the menu lists `enabled`. */
export async function listRemixApps() {
  return (await getRemixAppRegistry()).map(
    ({ slug, name, icon, description, target, enabled, app }) => ({
      slug,
      name,
      icon,
      description,
      target,
      enabled,
      engine: app.engine,
      output: 'image' as const,
    })
  );
}

export function snapAspectRatio(dims: { width?: number | null; height?: number | null }) {
  if (!dims.width || !dims.height) return '1:1' as const;
  return findClosestAspectRatio({ width: dims.width, height: dims.height }, ASPECT_BUCKETS);
}

/**
 * Everything a run or a quote submits, from the definition and the server-loaded source row.
 * Throws when the source may not reach any of the app's engines.
 */
export function buildRemixAppRun({
  app,
  image,
  viewer,
}: {
  app: RemixAppDefinition;
  image: RemixSourceImage;
  viewer: { isGreen: boolean; showNsfw: boolean };
}) {
  const resolved = resolveRemixAppEngine(app, image, viewer);
  if ('refusal' in resolved) throw new TRPCError({ code: 'FORBIDDEN', message: resolved.refusal });
  const { tier, engine } = resolved;

  const width = image.width || REMIX_FALLBACK_DIMENSIONS.width;
  const height = image.height || REMIX_FALLBACK_DIMENSIONS.height;
  const aspectRatio =
    app.params.aspectRatio === 'source' ? snapAspectRatio(image) : app.params.aspectRatio;
  const modelConfig: PresetEngine = { ...engine, maxReferenceImages: MAX_REFERENCE_IMAGES };
  const sourceUrl = getRemixSourceUrl(image);

  return {
    tier,
    aspectRatio,
    sourceUrl,
    submit: {
      prompt: app.prompt,
      aspectRatio,
      quantity: app.params.quantity,
      images: [{ url: sourceUrl, width, height }],
      modelConfig,
    },
  };
}

/**
 * The graph input for one workflow a runtime app asks for. Throws when the source may not reach
 * the app's engines, for an upscale too: the app's mature rule covers every step it runs.
 */
export function buildRuntimeRequest({
  app,
  image,
  request,
  viewer,
}: {
  app: Pick<RemixApp, 'name' | 'engine'>;
  image: RemixSourceImage;
  request: RemixWorkflowRequest;
  viewer: { isGreen: boolean; showNsfw: boolean };
}) {
  const resolved = resolveRemixAppEngine(app, image, viewer);
  if ('refusal' in resolved) throw new TRPCError({ code: 'FORBIDDEN', message: resolved.refusal });
  const { tier, engine } = resolved;
  const sized = ({ url, width, height }: RemixImage) => ({
    url,
    width: width || REMIX_FALLBACK_DIMENSIONS.width,
    height: height || REMIX_FALLBACK_DIMENSIONS.height,
  });

  if (request.kind === 'upscale') {
    const input = sized(request.image);
    return {
      tier,
      // The upscaler prices by the output size, so by the input's.
      shape: `upscale:${request.scale}:${input.width}x${input.height}`,
      inputUrls: [input.url],
      graphInput: {
        workflow: 'img2img:upscale',
        images: [input],
        upscaleSelection: { type: 'multiplier', multiplier: request.scale },
      },
    };
  }

  const aspectRatio =
    request.aspectRatio === 'source' ? snapAspectRatio(image) : request.aspectRatio;
  const images = request.images.map(sized);
  return {
    tier,
    // An edit prices by its output, which the snapped aspect ratio sizes, not by its inputs.
    shape: ['image', aspectRatio, request.quantity, images.length].join(':'),
    inputUrls: images.map((i) => i.url),
    graphInput: buildPresetGraphInput({
      prompt: request.prompt,
      aspectRatio,
      quantity: request.quantity,
      images,
      ecosystem: engine.ecosystem,
      versionId: engine.versionId,
    }),
  };
}

/** The first workflow the app runs, through any asks before it on their first answers; `null` if none is reached. */
export async function firstRuntimeRequest(app: RemixApp, image: RemixSourceImage) {
  const log: RemixLogEntry[] = [];
  // Bounded: an app that only ever asks has no first workflow to price.
  for (let asked = 0; asked <= 8; asked++) {
    const outcome = await replayRemixApp(app, runtimeSourceOf(image), log).catch((error) => {
      if (error instanceof RemixReplayError) return null;
      throw error;
    });
    if (outcome?.status !== 'effect') return null;
    const { effect } = outcome;
    if (effect.type === 'workflow') return effect.request;
    log.push({ type: 'ask', answer: firstAnswer(effect.spec) });
  }
  return null;
}

export function runtimeSourceOf(image: RemixSourceImage) {
  return {
    imageId: image.id,
    url: getRemixSourceUrl(image),
    width: image.width || REMIX_FALLBACK_DIMENSIONS.width,
    height: image.height || REMIX_FALLBACK_DIMENSIONS.height,
  };
}

/** A repeat of the same tap (same nonce) names the same workflow, which the orchestrator dedupes. */
export function remixAppExternalId(args: {
  userId: number;
  slug: string;
  imageId: number;
  nonce: string;
}) {
  const digest = createHash('sha256')
    .update(JSON.stringify([args.userId, args.slug, args.imageId, args.nonce]))
    .digest('hex')
    .slice(0, 32);
  // The orchestrator only accepts [A-Za-z0-9_-] in an externalId.
  return `remix-app_${digest}`;
}

/** One tap (one nonce) is one run, so a repeated start finds the run it already made. */
export function remixRunId(args: { userId: number; slug: string; imageId: number; nonce: string }) {
  const digest = createHash('sha256')
    .update(JSON.stringify([args.userId, args.slug, args.imageId, args.nonce]))
    .digest('hex')
    .slice(0, 20);
  return `r${digest}`;
}

export type RemixAppCaller = {
  user: SessionUser;
  token: string;
  features: FeatureAccess;
  /** The request's domain colour is green: no mature output, no mature tier. */
  isGreenDomain: boolean;
  isApiCaller: boolean;
  track?: unknown;
};

/** What every remix submit sends for the caller: who pays, in what, and what it may show. */
/** What a what-if needs from the caller, so it prices exactly what the submit will charge. */
export function remixWhatIfArgs(
  caller: RemixAppCaller,
  currencies: ReturnType<typeof getAllowedAccountTypes>
) {
  return { user: caller.user, token: caller.token, currencies, flags: caller.features };
}

export function remixSubmitArgs(
  caller: RemixAppCaller,
  tags: string[],
  currencies: ReturnType<typeof getAllowedAccountTypes>
) {
  return {
    ...remixWhatIfArgs(caller, currencies),
    tags: caller.isGreenDomain ? ['green', ...tags] : tags,
    isGreen: caller.features.isGreen,
    allowMatureContent: caller.isGreenDomain || !caller.user.showNsfw ? false : undefined,
    track: caller.track,
  };
}

export const viewerOf = (caller: Pick<RemixAppCaller, 'isGreenDomain' | 'user'>) => ({
  isGreen: caller.isGreenDomain,
  showNsfw: !!caller.user.showNsfw,
});

/** `image.get`'s visibility and owner-block check. Returns the owner. */
function assertVisible(imageId: number, caller: RemixAppCaller, confirmBlockOnPrimary: boolean) {
  return assertImageVisibleToViewer({
    id: imageId,
    userId: caller.user.id,
    isModerator: caller.user.isModerator,
    confirmBlockOnPrimary,
  });
}

/** The visibility check, then only the fields a remix reads. */
export async function loadSource(
  imageId: number,
  caller: RemixAppCaller,
  confirmBlockOnPrimary: boolean
) {
  await assertVisible(imageId, caller, confirmBlockOnPrimary);
  return readSource(imageId);
}

async function readSource(imageId: number) {
  const image = await dbRead.image.findUnique({
    where: { id: imageId },
    select: {
      id: true,
      url: true,
      type: true,
      nsfwLevel: true,
      width: true,
      height: true,
      ingestion: true,
      blockedFor: true,
      minor: true,
      poi: true,
    },
  });
  if (!image) throw new TRPCError({ code: 'NOT_FOUND', message: 'Image not found' });
  return image as RemixSourceImage;
}

export async function assertInputsUsable(
  urls: string[],
  caller: RemixAppCaller,
  entry: GenerationInputEntryPoint
) {
  // The preset submit skips the input gate ('checked-by-caller'), so it runs here.
  await assertGenerationInputsUsable({
    urls,
    userId: caller.user.id,
    entry,
    isApiCaller: caller.isApiCaller,
  });
}

/** Prices every system app this source can run, from one source load. */
export async function quoteRemixApps({
  imageId,
  caller,
}: {
  imageId: number;
  caller: RemixAppCaller;
}) {
  const image = await loadSource(imageId, caller, false);
  await assertInputsUsable([getRemixSourceUrl(image)], caller, 'remixAppQuote');
  const pricing = await pricingFor(caller);

  const apps = (await getEnabledRemixApps()).filter((entry) => entry.target === 'image.remix');
  const prices = await Promise.all(
    apps.map(({ app }) => quoteRuntimeApp(app, image, caller, pricing))
  );
  return { prices };
}

/**
 * The per-caller inputs a price depends on beyond the user row. Testing access is per user (Flipt
 * testers), and it opens gate rules the graph prices against.
 */
export async function pricingFor(caller: Pick<RemixAppCaller, 'user' | 'features'>) {
  return {
    currencies: getAllowedAccountTypes(caller.features, ['blue']),
    hasTestingAccess: await resolveTestingAccess(caller.user),
  };
}

/**
 * The graph prices with the caller's flags (engine and model gates among them), so every enabled
 * flag is part of the quote's key: a flag added later cannot be missed.
 */
function featureDigest(features: Partial<FeatureAccess>) {
  const enabled = Object.keys(features)
    .filter((flag) => features[flag as keyof FeatureAccess])
    .sort();
  return createHash('sha256').update(enabled.join(',')).digest('hex').slice(0, 12);
}

type Pricing = Awaited<ReturnType<typeof pricingFor>>;
/** What a quote prices: `shape` is everything in `submit` the price can depend on, minus urls. */
type BuiltRun = {
  tier: string;
  shape: string;
  submit: ReturnType<typeof buildRemixAppRun>['submit'] | { graphInput: Record<string, unknown> };
};

async function quoteApp(
  app: RemixAppDefinition,
  image: RemixSourceImage,
  caller: RemixAppCaller,
  pricing: Pricing
) {
  const resolved = resolveRemixAppEngine(app, image, viewerOf(caller));
  if ('refusal' in resolved) return { slug: app.slug, refusal: resolved.refusal };
  const { tier, aspectRatio, submit } = buildRemixAppRun({ app, image, viewer: viewerOf(caller) });
  return {
    slug: app.slug,
    ...(await quoteBuiltRun(app.slug, { tier, shape: aspectRatio, submit }, caller, pricing)),
  };
}

async function quoteRuntimeApp(
  app: RemixApp,
  image: RemixSourceImage,
  caller: RemixAppCaller,
  pricing: Pricing
) {
  const resolved = resolveRemixAppEngine(app, image, viewerOf(caller));
  if ('refusal' in resolved) return { slug: app.slug, refusal: resolved.refusal };
  const request = await firstRuntimeRequest(app, image);
  if (!request) return { slug: app.slug, refusal: PRICE_UNAVAILABLE };
  const { tier, shape, graphInput } = buildRuntimeRequest({
    app,
    image,
    request,
    viewer: viewerOf(caller),
  });
  const run = { tier, shape, submit: { graphInput } };
  return {
    slug: app.slug,
    ...(await quoteBuiltRun(`${app.slug}@${app.version}`, run, caller, pricing)),
  };
}

const PRICE_UNAVAILABLE = 'Price unavailable';

/** `key` names what was built; the quote is shared across users and images. */
async function quoteBuiltRun(
  key: string,
  run: BuiltRun,
  caller: RemixAppCaller,
  { currencies, hasTestingAccess }: Pricing
): Promise<{ cost: number; ready: boolean } | { refusal: string }> {
  const cacheKey = [
    key,
    run.tier,
    run.shape,
    caller.user.tier ?? 'free',
    caller.user.isModerator ? 'mod' : 'user',
    currencies.join('+'),
    hasTestingAccess ? 'tester' : 'public',
    featureDigest(caller.features),
  ].join(':');
  try {
    return await fetchThroughCache(
      `${REDIS_KEYS.CACHES.REMIX_APP_QUOTE}:${cacheKey}`,
      () =>
        whatIfPresetImageGen({
          ...run.submit,
          ...remixWhatIfArgs(caller, currencies),
        }),
      { ttl: CacheTTL.sm, lockTTL: 4 }
    );
  } catch (error) {
    logToAxiom({
      name: 'remix-app-quote',
      type: 'error',
      message: (error as Error).message,
      key,
    }).catch(() => undefined);
    return { refusal: PRICE_UNAVAILABLE };
  }
}

/**
 * The team remix this viewer is offered on this visible image, or why not. Offered exactly when the
 * gallery would take the result free under its team waiver today. `getTeamWaiverStanding` is the
 * submit modal's own read: the gallery open, the owner's hat on their own image, viewer and owner
 * joined the same team, and free team submits left today. The team is read from the joins, never
 * from the client.
 */
async function resolveTeamRemix(
  imageId: number,
  caller: Pick<RemixAppCaller, 'user'>,
  { onPrimary }: { onPrimary: boolean }
) {
  const { userId: ownerId } = await assertImageVisibleToViewer({
    id: imageId,
    userId: caller.user.id,
    isModerator: caller.user.isModerator,
    confirmBlockOnPrimary: onPrimary,
  });
  // Before a charge, the team rule again on the primary: a hat taken off or a join made seconds
  // ago is seen. The standing (and its count) is the replica's; the submit re-decides under lock.
  if (onPrimary) {
    const waiver = await findTeamRemixWaiver({
      placerId: caller.user.id,
      ownerId,
      hostImageId: imageId,
      db: dbWrite,
    });
    if (!waiver) return { refusal: TEAM_REMIX_UNAVAILABLE };
  }
  const standing = await getTeamWaiverStanding({ hostImageId: imageId, placerId: caller.user.id });
  if (!standing) return { refusal: TEAM_REMIX_UNAVAILABLE };
  if (standing.remaining <= 0) return { refusal: TEAM_SUBMITS_SPENT };
  return { team: standing.team, app: teamRemixApp(standing.team) };
}

/** Not on the creator's team, the hat taken off, or the gallery closed. */
const TEAM_REMIX_UNAVAILABLE = 'Team remix is not available on this image right now.';
const TEAM_SUBMITS_SPENT =
  "You have used today's free team submits, so you can't remix this image for your team until they reset.";

/**
 * `null` = no button. Eligibility first, so the orchestrator token and the price are only fetched
 * for an image the viewer can remix for their team; an image they cannot see throws as usual.
 */
export async function quoteTeamRemix({
  imageId,
  caller,
  getToken,
}: {
  imageId: number;
  caller: Omit<RemixAppCaller, 'token'>;
  getToken: () => Promise<string>;
}) {
  const offer = await resolveTeamRemix(imageId, caller, { onPrimary: false });
  if ('refusal' in offer) return null;
  const full: RemixAppCaller = { ...caller, token: await getToken() };
  const image = await readSource(imageId);
  await assertInputsUsable([getRemixSourceUrl(image)], full, 'remixAppQuote');
  const price = await quoteApp(offer.app, image, full, await pricingFor(caller));
  return { team: offer.team, price };
}

/** Refuses a step that now costs more than the price the viewer tapped. */
export function assertWithinQuote(cost: number, quote: number) {
  if (cost > quote)
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: `The price changed to ${cost.toLocaleString()} Buzz. Check it and run again.`,
    });
}

/** `quote`: the price the viewer tapped; a run that now costs more is refused before it submits. */
export async function runRemixApp({
  slug,
  imageId,
  nonce,
  quote,
  caller,
}: {
  slug: string;
  imageId: number;
  nonce: string;
  quote: number;
  caller: RemixAppCaller;
}) {
  let app: RemixAppDefinition;
  let image: RemixSourceImage;
  if (slug === TEAM_REMIX_SLUG) {
    const offer = await resolveTeamRemix(imageId, caller, { onPrimary: true });
    if ('refusal' in offer) throw new TRPCError({ code: 'FORBIDDEN', message: offer.refusal });
    app = offer.app;
    image = await readSource(imageId);
  } else {
    // Every menu app runs through `start` now; a page loaded before that change still calls this.
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Remix apps were updated. Reload the page and run it again.',
    });
  }
  const run = buildRemixAppRun({ app, image, viewer: viewerOf(caller) });
  await assertInputsUsable([run.sourceUrl], caller, 'remixAppRun');
  const currencies = getAllowedAccountTypes(caller.features, ['blue']);
  const priced = await whatIfPresetImageGen({
    ...run.submit,
    ...remixWhatIfArgs(caller, currencies),
  });
  assertWithinQuote(priced.cost, quote);

  // A one-segment run, so the tray lists it beside the runtime apps' runs.
  const runId = remixRunId({ userId: caller.user.id, slug, imageId: image.id, nonce });
  const tags = remixRunTags({ slug: app.slug, runId, segment: 0, runtime: false });
  const result = await submitPresetImageGen({
    ...run.submit,
    ...remixSubmitArgs(caller, tags, currencies),
    remixOfId: image.id,
    externalId: remixAppExternalId({ userId: caller.user.id, slug, imageId: image.id, nonce }),
  });

  bustQueriedWorkflowsCache(caller.user.id).catch(() => null);

  return { workflowId: result.id, tier: run.tier, cost: result.cost?.total ?? 0 };
}
