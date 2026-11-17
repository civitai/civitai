import type { BlockWorkflowOutput } from '~/server/schema/blocks/workflow.schema';
import type { BlockOutputCeiling } from '~/server/services/blocks/block-output-restriction';
import {
  blockMediaUrl,
  sealBlockMediaRef,
  sealBlockMediaTicket,
  type BlockMediaClaims,
  type BlockMediaType,
} from '~/server/services/blocks/block-media-token';
import { getConsumerBlobId } from '~/shared/orchestrator/blob-url';

/**
 * Who a poll's media is minted for, present only while host media serving is on for
 * that viewer. Every surface that mints reads the viewer's OWN workflows, so the viewer
 * is the owner.
 */
export type BlockMediaMint = { userId: number; appBlockId: string };

/**
 * The viewer's output ceiling plus whether host media serving is on for them. With
 * `serving`, outputs the media route would refuse are restricted on every path (poll,
 * publish, post, persist), so all of them name the same positions as usable.
 */
export type BlockOutputRules = BlockOutputCeiling & { serving: boolean };

/**
 * What every workflow producer takes: the rules, and the mint context, present only for
 * an app-facing read while serving is on. Server-side reads (publish, post, persist) that
 * fetch the media themselves pass `mint: null` and keep the orchestrator url.
 */
export type BlockOutputView = BlockOutputRules & { mint: BlockMediaMint | null };

/** The facts one output position contributes to its ticket. */
export type BlockOutputMintSlot = {
  url: string;
  type: string | null;
  nsfwLevel: string | null;
};

export type BlockOutputMintStep = {
  workflowId: string;
  privateGen: boolean;
  /** `isBlockNeverRatedVideoStep` for the producing step. */
  neverRatedVideoStep: boolean;
};

const MINTABLE_TYPES: ReadonlySet<string> = new Set(['image', 'video', 'audio', 'model3d']);

/**
 * While serving is on, restricts what the media route would refuse, so no path calls it
 * usable:
 *   - a video from a never-rated engine step: the route hides it on the step flag alone;
 *   - an output rated `na`: the route reads a blob `NA` as never scanned and hides it.
 */
export function applyServingRules(
  output: BlockWorkflowOutput,
  slot: BlockOutputMintSlot,
  step: Pick<BlockOutputMintStep, 'neverRatedVideoStep'>
): BlockWorkflowOutput {
  if (!('url' in output)) return output;
  if (mediaTypeOf(slot.type) === 'video' && step.neverRatedVideoStep) return UNRATED;
  if (slot.nsfwLevel?.trim().toLowerCase() === 'na') return UNRATED;
  return output;
}

/**
 * One classified output, as the app receives it while serving is on: after
 * {@link applyServingRules}, a `{ url }` entry becomes a ticket url plus a `mediaRef`.
 * An orchestrator url with no consumer blob id, an unknown media type, or a seal that
 * fails is restricted: no ticket can be issued. The ticket's level is the poll's own
 * ceiling, so one number decides both.
 */
export function mintBlockOutput(
  classified: BlockWorkflowOutput,
  slot: BlockOutputMintSlot,
  step: BlockOutputMintStep,
  view: BlockOutputView & { mint: BlockMediaMint }
): BlockWorkflowOutput {
  const output = applyServingRules(classified, slot, step);
  if (!('url' in output)) return output;

  const mediaType = mediaTypeOf(slot.type);
  if (!mediaType) return UNRECOGNISED;

  const blobId = getConsumerBlobId(slot.url);
  if (!blobId) return UNRECOGNISED;

  const claims: BlockMediaClaims = {
    blobId,
    workflowId: step.workflowId,
    ownerId: view.mint.userId,
    appBlockId: view.mint.appBlockId,
    mediaType,
    privateGen: step.privateGen,
    neverRatedVideoStep: step.neverRatedVideoStep,
  };
  const ticket = sealBlockMediaTicket({
    ...claims,
    viewerId: view.mint.userId,
    viewerBrowsingLevel: view.maxBrowsingLevel,
  });
  const mediaRef = sealBlockMediaRef(claims);
  if (!ticket || !mediaRef) return UNRECOGNISED;

  return { ...output, url: blockMediaUrl(ticket), mediaRef };
}

/** A slot with no blob type is an image, as `classifyBlockOutput` reads it. */
function mediaTypeOf(type: string | null): BlockMediaType | undefined {
  if (type === null || type === '') return 'image';
  return MINTABLE_TYPES.has(type) ? (type as BlockMediaType) : undefined;
}

/** `isPrivateGeneration`, read where the site's generator reads it. */
export function isPrivateGenerationWorkflow(
  workflow: { metadata?: unknown },
  step: { metadata?: unknown }
): boolean {
  const read = (m: unknown) =>
    m && typeof m === 'object'
      ? (m as { isPrivateGeneration?: unknown }).isPrivateGeneration
      : undefined;
  return !!(read(workflow.metadata) ?? read(step.metadata));
}

const UNRATED: BlockWorkflowOutput = { restricted: true, reason: 'unrated' };
const UNRECOGNISED: BlockWorkflowOutput = { restricted: true, reason: 'unrecognised_url' };
