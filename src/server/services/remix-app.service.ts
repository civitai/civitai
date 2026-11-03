import { createHash } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { getEdgeUrl, videoStillEdgeOptions, MAX_EDGE_WIDTH } from '~/client-utils/edge-url';
import { CacheTTL } from '~/server/common/constants';
import { REDIS_KEYS } from '~/server/redis/client';
import type { FeatureAccess } from '~/server/services/feature-flags.service';
import {
  assertGenerationInputsUsable,
  type GenerationInputEntryPoint,
} from '~/server/services/generation-input-urls';
import { getImage } from '~/server/services/image.service';
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
  type RemixAppDefinition,
} from '~/shared/constants/remix-apps.constants';
import { resolveRemixAppEngine } from '~/shared/utils/remix-apps';
import type { RemixSourceImage } from '~/shared/utils/remix-tier';
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

const FALLBACK_DIMENSIONS = { width: 512, height: 512 };

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

/** The still the engine receives: an mp4's frame 0 for a video, the original file for an image. */
function getSourceUrl(image: RemixSourceImage) {
  return image.type === 'video'
    ? getEdgeUrl(image.url, {
        ...videoStillEdgeOptions,
        width: Math.min(image.width ?? MAX_EDGE_WIDTH, MAX_EDGE_WIDTH),
      })
    : getEdgeUrl(image.url, { original: true });
}

/**
 * Everything a run or a quote submits, from the definition and the server-loaded source row.
 * Throws when the source may not reach any of the app's engines.
 */
export function buildRemixAppRun({
  app,
  image,
  isGreen,
}: {
  app: RemixAppDefinition;
  image: RemixSourceImage;
  isGreen: boolean;
}) {
  const resolved = resolveRemixAppEngine(app, image, { isGreen });
  if ('refusal' in resolved) throw new TRPCError({ code: 'FORBIDDEN', message: resolved.refusal });
  const { tier, engine } = resolved;

  const width = image.width || FALLBACK_DIMENSIONS.width;
  const height = image.height || FALLBACK_DIMENSIONS.height;
  const aspectRatio =
    app.params.aspectRatio === 'source' ? snapAspectRatio(image) : app.params.aspectRatio;
  const modelConfig: PresetEngine = { ...engine, maxReferenceImages: MAX_REFERENCE_IMAGES };
  const sourceUrl = getSourceUrl(image);

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
  return `remix-app:${digest}`;
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

async function prepare({
  slug,
  imageId,
  caller,
  entry,
}: {
  slug: string;
  imageId: number;
  caller: RemixAppCaller;
  entry: GenerationInputEntryPoint;
}) {
  const app = getSystemRemixApp(slug);
  if (!app) throw new TRPCError({ code: 'NOT_FOUND', message: 'Remix app not found' });

  const image = await getImage({
    id: imageId,
    userId: caller.user.id,
    isModerator: caller.user.isModerator,
  });
  const run = buildRemixAppRun({ app, image, isGreen: caller.isGreenDomain });

  // The preset submit skips the input gate ('checked-by-caller'), so it runs here.
  await assertGenerationInputsUsable({
    urls: [run.sourceUrl],
    userId: caller.user.id,
    entry,
    isApiCaller: caller.isApiCaller,
  });

  return { app, image, run, currencies: getAllowedAccountTypes(caller.features, ['blue']) };
}

export async function quoteRemixApp({
  slug,
  imageId,
  caller,
}: {
  slug: string;
  imageId: number;
  caller: RemixAppCaller;
}) {
  const { run, currencies } = await prepare({ slug, imageId, caller, entry: 'remixAppQuote' });
  const key = [slug, run.tier, run.aspectRatio, caller.user.tier ?? 'free', currencies.join('+')];

  const quote = await fetchThroughCache(
    `${REDIS_KEYS.CACHES.REMIX_APP_QUOTE}:${key.join(':')}`,
    () =>
      whatIfPresetImageGen({
        ...run.submit,
        user: caller.user,
        token: caller.token,
        currencies,
        flags: caller.features,
      }),
    { ttl: CacheTTL.sm }
  );
  return { ...quote, tier: run.tier };
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
  const { app, image, run, currencies } = await prepare({
    slug,
    imageId,
    caller,
    entry: 'remixAppRun',
  });
  const tags = [`remix-app:${app.slug}`];

  const result = await submitPresetImageGen({
    ...run.submit,
    user: caller.user,
    token: caller.token,
    flags: caller.features,
    currencies,
    tags: caller.isGreenDomain ? ['green', ...tags] : tags,
    isGreen: caller.features.isGreen,
    allowMatureContent: caller.isGreenDomain ? false : undefined,
    track: caller.track,
    remixOfId: image.id,
    externalId: remixAppExternalId({ userId: caller.user.id, slug, imageId: image.id, nonce }),
  });

  bustQueriedWorkflowsCache(caller.user.id).catch(() => null);

  return { workflowId: result.id, tier: run.tier, cost: result.cost?.total ?? 0 };
}
