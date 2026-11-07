import { createHash } from 'node:crypto';
import type { Tracker } from '~/server/clickhouse/client';
import { TRPCError } from '@trpc/server';
import { dbWrite } from '~/server/db/client';
import { stageGenerationOutputImage } from '~/server/services/blocks/block-image-upload.service';
import { bustQueriedWorkflowsCache } from '~/server/services/orchestrator/orchestration-new.service';
import {
  submitPresetImageGen,
  whatIfPresetImageGen,
} from '~/server/services/orchestrator/preset-image-gen.service';
import { recordMintedUploadKey } from '~/server/services/image-upload-action.service';
import { getWorkflow } from '~/server/services/orchestrator/workflows';
import { outputImages } from '~/server/services/remix-app-run.service';
import {
  assertInputsUsable,
  assertWithinQuote,
  buildRemixAppRun,
  remixSubmitArgs,
  remixWhatIfArgs,
  viewerOf,
  type RemixAppCaller,
} from '~/server/services/remix-app.service';
import { getAllowedAccountTypes } from '~/server/utils/buzz-helpers';
import { isMature } from '~/shared/constants/orchestrator.constants';
import {
  ARTICLE_REFRAME,
  ARTICLE_REFRAME_TAG,
  centreCropBox,
  getReframeRefusal,
  type ArticleReframeTarget,
} from '~/shared/utils/article-reframe';
import type { RemixSourceImage } from '~/shared/utils/remix-tier';

const targetTag = (target: ArticleReframeTarget) => `${ARTICLE_REFRAME_TAG}:${target}`;

/**
 * The author's own saved image, with the fields the remix refusals read. From the primary: the
 * button shows right after a save, before a replica has the row.
 */
async function readOwnSource(imageId: number, userId: number) {
  const image = await dbWrite.image.findFirst({
    where: { id: imageId, userId },
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

async function buildRun(imageId: number, target: ArticleReframeTarget, caller: RemixAppCaller) {
  const image = await readOwnSource(imageId, caller.user.id);
  const refusal = getReframeRefusal(target, image);
  if (refusal) throw new TRPCError({ code: 'FORBIDDEN', message: refusal });
  const run = buildRemixAppRun({
    app: ARTICLE_REFRAME[target].app,
    image,
    viewer: viewerOf(caller),
  });
  await assertInputsUsable([run.sourceUrl], caller, 'articleReframe');
  const currencies = getAllowedAccountTypes(caller.features, ['blue']);
  return { image, run, currencies };
}

export async function quoteArticleReframe({
  imageId,
  target,
  caller,
}: {
  imageId: number;
  target: ArticleReframeTarget;
  caller: RemixAppCaller;
}) {
  const { run, currencies } = await buildRun(imageId, target, caller);
  return whatIfPresetImageGen({ ...run.submit, ...remixWhatIfArgs(caller, currencies) });
}

/** Charges for one take. Nothing is attached to the article: `keepArticleReframe` returns the image. */
export async function submitArticleReframe({
  imageId,
  target,
  quote,
  nonce,
  caller,
}: {
  imageId: number;
  target: ArticleReframeTarget;
  /** The price the author was shown; a take that now costs more is refused before it submits. */
  quote: number;
  nonce: string;
  caller: RemixAppCaller;
}) {
  const { image, run, currencies } = await buildRun(imageId, target, caller);
  const priced = await whatIfPresetImageGen({
    ...run.submit,
    ...remixWhatIfArgs(caller, currencies),
  });
  assertWithinQuote(priced.cost, quote);

  const digest = createHash('sha256')
    .update(JSON.stringify([caller.user.id, target, image.id, nonce]))
    .digest('hex')
    .slice(0, 32);
  const result = await submitPresetImageGen({
    ...run.submit,
    ...remixSubmitArgs(caller, [ARTICLE_REFRAME_TAG, targetTag(target)], currencies),
    remixOfId: image.id,
    // The orchestrator only accepts [A-Za-z0-9_-] in an externalId.
    externalId: `article-reframe_${digest}`,
  });
  bustQueriedWorkflowsCache(caller.user.id).catch(() => null);

  return { workflowId: result.id as string, cost: result.cost?.total ?? 0 };
}

/**
 * Crops the author's own take to the target's shape and stores it. Returns the same shape an
 * upload gives the form, so the article's normal save creates the Image row and scans it.
 */
export async function keepArticleReframe({
  workflowId,
  target,
  caller,
}: {
  workflowId: string;
  target: ArticleReframeTarget;
  caller: RemixAppCaller;
}) {
  // The token is the author's, so another user's workflow is not found.
  const workflow = await getWorkflow({ token: caller.token, path: { workflowId } });
  if (!workflow?.tags?.includes(targetTag(target)))
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Take not found' });
  if (workflow.status !== 'succeeded')
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'This take has not finished.' });

  const [output] = outputImages(workflow);
  if (!output?.url)
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'This take has no image to keep.' });
  // Fails closed: an output not rated yet is not kept, and a mature one only by a viewer shown it.
  if (output.nsfwLevel == null)
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'This take is still being checked. Try again in a moment.',
    });
  if (isMature(output.nsfwLevel) && (caller.isGreenDomain || !caller.user.showNsfw))
    throw new TRPCError({ code: 'FORBIDDEN', message: 'This take cannot be used here.' });

  const { keepAspect } = ARTICLE_REFRAME[target];
  const staged = await stageGenerationOutputImage({
    imageUrl: output.url,
    width: null,
    height: null,
    source: `article-reframe:${target}`,
    transform: (bytes) => cropToAspect(bytes, keepAspect),
  });
  // The article save takes this as a client upload, and refuses a key not issued to the author.
  await recordMintedUploadKey(staged.url, caller.user.id, caller.track as Tracker | undefined);
  return staged;
}

export async function cropToAspect(bytes: Buffer, aspect: number) {
  const { default: sharp } = await import('sharp');
  const image = sharp(bytes);
  const { width, height } = await image.metadata();
  if (!width || !height)
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'This take has no dimensions.' });
  return image.extract(centreCropBox(width, height, aspect)).toBuffer();
}
