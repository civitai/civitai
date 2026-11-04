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
import { assertImageVisibleToViewer } from '~/server/services/image-visibility.service';
import { bustQueriedWorkflowsCache } from '~/server/services/orchestrator/orchestration-new.service';
import {
  submitPresetImageGen,
  whatIfPresetImageGen,
  type PresetEngine,
} from '~/server/services/orchestrator/preset-image-gen.service';
import { getAllowedAccountTypes } from '~/server/utils/buzz-helpers';
import { fetchThroughCache } from '~/server/utils/cache-helpers';
import type { GenerationAspectRatio } from '~/shared/constants/generation.constants';
import {
  getSystemRemixApp,
  SYSTEM_REMIX_APPS,
  TEAM_REMIX_SLUG,
  teamRemixApp,
  type RemixAppDefinition,
} from '~/shared/constants/remix-apps.constants';
import { resolveRemixAppEngine } from '~/shared/utils/remix-apps';
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

export function listRemixApps() {
  return SYSTEM_REMIX_APPS.map(({ slug, name, icon, description, output }) => ({
    slug,
    name,
    icon,
    description,
    output,
  }));
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

export type RemixAppCaller = {
  user: SessionUser;
  token: string;
  features: FeatureAccess;
  /** The request's domain colour is green: no mature output, no mature tier. */
  isGreenDomain: boolean;
  isApiCaller: boolean;
  track?: unknown;
};

const viewerOf = (caller: RemixAppCaller) => ({
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
async function loadSource(imageId: number, caller: RemixAppCaller, confirmBlockOnPrimary: boolean) {
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

async function assertSourceUsable(
  sourceUrl: string,
  caller: RemixAppCaller,
  entry: GenerationInputEntryPoint
) {
  // The preset submit skips the input gate ('checked-by-caller'), so it runs here.
  await assertGenerationInputsUsable({
    urls: [sourceUrl],
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
  await assertSourceUsable(getRemixSourceUrl(image), caller, 'remixAppQuote');
  const currencies = getAllowedAccountTypes(caller.features, ['blue']);

  const prices = await Promise.all(
    SYSTEM_REMIX_APPS.map((app) => quoteApp(app, image, caller, currencies))
  );
  return { prices };
}

async function quoteApp(
  app: RemixAppDefinition,
  image: RemixSourceImage,
  caller: RemixAppCaller,
  currencies: ReturnType<typeof getAllowedAccountTypes>
) {
  const resolved = resolveRemixAppEngine(app, image, viewerOf(caller));
  if ('refusal' in resolved) return { slug: app.slug, refusal: resolved.refusal };
  const run = buildRemixAppRun({ app, image, viewer: viewerOf(caller) });
  // Everything the price can vary by; the quote is shared across users and images.
  const key = [
    app.slug,
    run.tier,
    run.aspectRatio,
    caller.user.tier ?? 'free',
    caller.user.isModerator ? 'mod' : 'user',
    currencies.join('+'),
  ].join(':');
  try {
    const quote = await fetchThroughCache(
      `${REDIS_KEYS.CACHES.REMIX_APP_QUOTE}:${key}`,
      () =>
        whatIfPresetImageGen({
          ...run.submit,
          user: caller.user,
          token: caller.token,
          currencies,
          flags: caller.features,
        }),
      { ttl: CacheTTL.sm, lockTTL: 4 }
    );
    return { slug: app.slug, ...quote };
  } catch (error) {
    return { slug: app.slug, refusal: (error as Error).message ?? 'Price unavailable' };
  }
}

/**
 * The team remix this viewer is offered on this visible image, or null: exactly when the gallery's
 * team waiver would take the result free (`findTeamRemixWaiver`: the owner's hat on their own
 * image, and viewer and owner joined the same team). The team is read from the joins, never from
 * the client.
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
  const waiver = await findTeamRemixWaiver({
    placerId: caller.user.id,
    ownerId,
    hostImageId: imageId,
    db: onPrimary ? dbWrite : dbRead,
  });
  return waiver && { team: waiver.team, app: teamRemixApp(waiver.team) };
}

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
  if (!offer) return null;
  const full: RemixAppCaller = { ...caller, token: await getToken() };
  const image = await readSource(imageId);
  await assertSourceUsable(getRemixSourceUrl(image), full, 'remixAppQuote');
  const price = await quoteApp(
    offer.app,
    image,
    full,
    getAllowedAccountTypes(caller.features, ['blue'])
  );
  return { team: offer.team, price };
}

export async function runRemixApp({
  slug,
  imageId,
  nonce,
  caller,
}: {
  slug: string;
  imageId: number;
  nonce: string;
  caller: RemixAppCaller;
}) {
  let app: RemixAppDefinition | undefined;
  let image: RemixSourceImage;
  if (slug === TEAM_REMIX_SLUG) {
    // On the primary, so a hat taken off or a join made seconds ago is seen before the charge.
    app = (await resolveTeamRemix(imageId, caller, { onPrimary: true }))?.app;
    if (!app)
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: "Only a member of the creator's team can remix this image for it.",
      });
    image = await readSource(imageId);
  } else {
    app = getSystemRemixApp(slug);
    if (!app) throw new TRPCError({ code: 'NOT_FOUND', message: 'Remix app not found' });
    image = await loadSource(imageId, caller, true);
  }
  const run = buildRemixAppRun({ app, image, viewer: viewerOf(caller) });
  await assertSourceUsable(run.sourceUrl, caller, 'remixAppRun');

  const tags = [`remix-app:${app.slug}`];
  const result = await submitPresetImageGen({
    ...run.submit,
    user: caller.user,
    token: caller.token,
    flags: caller.features,
    currencies: getAllowedAccountTypes(caller.features, ['blue']),
    tags: caller.isGreenDomain ? ['green', ...tags] : tags,
    isGreen: caller.features.isGreen,
    allowMatureContent: caller.isGreenDomain || !caller.user.showNsfw ? false : undefined,
    track: caller.track,
    remixOfId: image.id,
    externalId: remixAppExternalId({ userId: caller.user.id, slug, imageId: image.id, nonce }),
  });

  bustQueriedWorkflowsCache(caller.user.id).catch(() => null);

  return { workflowId: result.id, tier: run.tier, cost: result.cost?.total ?? 0 };
}
