import { TRPCError } from '@trpc/server';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import { sessionClient } from '~/server/auth/session-client';
import { buildFliptContext } from '~/server/services/feature-flags.service';
import type { SessionUser } from '~/types/session';
import {
  parseSubjectUserId,
  type BlockTokenClaims,
} from '~/server/middleware/block-scope.middleware';
import { assertAppBlocksEnabledForTokenUser } from '~/server/services/blocks/block-token-access.service';
import { recordBlockMediaVerdict } from '~/server/metrics/app-block-runtime.metrics';
import {
  blockMediaUrl,
  openBlockMediaRef,
  openBlockMediaTicket,
  sealBlockMediaTicket,
} from '~/server/services/blocks/block-media-token';
import {
  deriveOutputGate,
  type BlockOutputHiddenReason,
} from '~/server/services/blocks/block-output-gate';
import { readBlobState } from '~/server/services/orchestrator/blobRatings';
import { hasEmptyViewerLevel } from '~/server/services/blocks/block-viewer-ceiling';
import { blockOutputCeilingFromClaims } from '~/server/services/blocks/block-output-restriction';
import type { BlockOutputView } from '~/server/services/blocks/block-output-mint';

/**
 * Off or absent: every App Block media item is paused (hidden), and the poll hands out
 * raw urls as before. Judged for ONE viewer, so a segment rollout reaches its viewers:
 * the user id as entity id plus the full session context, because Flipt segments read
 * either. A viewer that does not resolve, or an evaluation that throws, reads off.
 * Flipt unreachable pauses only a pod whose client never started; a running pod keeps
 * its last-known state.
 */
export async function isBlockMediaServing(viewerId: number | null): Promise<boolean> {
  try {
    const flag = FLIPT_FEATURE_FLAGS.APP_BLOCKS_WORKFLOW_MEDIA_SERVE;
    if (viewerId === null) return await isFlipt(flag);
    const user = (await sessionClient.getSessionUserById(viewerId)) as SessionUser | null;
    if (!user) return false;
    return await isFlipt(flag, String(viewerId), buildFliptContext(user));
  } catch {
    return false;
  }
}

export type BlockMediaFetch =
  | { state: 'redirect'; location: string }
  | { state: 'pending' }
  | { state: 'hidden'; reason: BlockOutputHiddenReason | 'invalid' };

/**
 * One fetch of `/api/v1/blocks/media/<ticket>`: re-judges the blob's current
 * verdict for the viewer the ticket was minted for, so a blob blocked after the
 * ticket was issued is refused at the next cache refresh.
 */
export async function resolveBlockMediaFetch(token: unknown): Promise<BlockMediaFetch> {
  const result = await judgeTicket(token);
  recordBlockMediaVerdict(
    'route',
    result.state === 'redirect' ? 'served' : result.state,
    result.state === 'hidden' ? result.reason : undefined
  );
  return result;
}

async function judgeTicket(token: unknown): Promise<BlockMediaFetch> {
  const ticket = openBlockMediaTicket(token);
  if (!ticket) return { state: 'hidden', reason: 'invalid' };
  if (!(await isBlockMediaServing(ticket.viewerId))) return { state: 'hidden', reason: 'paused' };

  const blob = await readBlobState(ticket.blobId);
  if (blob.verdict === 'pending') return { state: 'pending' };
  // 🔴 A blob HEAD's `NA` is not step-output `na`: it is also what a blob that
  // was never scanned reports, and it never changes, so it hides for good.
  if (!blob.blockedReason && blob.nsfwLevel === 'na') return { state: 'hidden', reason: 'unrated' };

  const gate = deriveOutputGate(
    {
      mediaType: ticket.mediaType,
      nsfwLevel: blob.nsfwLevel,
      blockedReason: blob.blockedReason,
      neverRatedVideoStep: ticket.neverRatedVideoStep,
      privateGen: ticket.privateGen,
      ownerId: ticket.ownerId,
    },
    { userId: ticket.viewerId, browsingLevel: ticket.viewerBrowsingLevel }
  );
  if (gate.state === 'hidden') return gate;
  if (gate.state === 'pending' || !blob.location) return { state: 'pending' };
  return { state: 'redirect', location: blob.location };
}

export type WorkflowMediaItem =
  | { status: 'visible'; url: string }
  | { status: 'pending' }
  | { status: 'hidden'; reason: BlockOutputHiddenReason | 'invalid' };

/**
 * `GET_WORKFLOW_MEDIA`: stored refs → viewer-bound media URLs. Makes no
 * orchestrator call; the verdict is checked when the URL is fetched.
 */
export async function resolveWorkflowMediaRefs(args: {
  refs: string[];
  appBlockId: string;
  viewerId: number | null;
  viewerBrowsingLevel: number;
  /** Users the viewer hid, blocked or is blocked by: their refs do not replay to this viewer. */
  hiddenOwnerIds: ReadonlySet<number>;
}): Promise<WorkflowMediaItem[]> {
  const serving = await isBlockMediaServing(args.viewerId);
  return args.refs.map((token) => {
    const item = judgeRef(token, args, serving);
    recordBlockMediaVerdict(
      'workflow_media',
      item.status === 'visible' ? 'served' : item.status,
      item.status === 'hidden' ? item.reason : undefined
    );
    // The app sees one reason for any ref it may not have, so it cannot learn that the viewer
    // and the owner hid or blocked each other; the specific reason stays in the metric.
    return item.status === 'hidden' && item.reason === 'owner_hidden'
      ? ({ status: 'hidden', reason: 'invalid' } as const)
      : item;
  });
}

function judgeRef(
  token: string,
  viewer: {
    appBlockId: string;
    viewerId: number | null;
    viewerBrowsingLevel: number;
    hiddenOwnerIds: ReadonlySet<number>;
  },
  serving: boolean
): WorkflowMediaItem | { status: 'hidden'; reason: 'owner_hidden' } {
  if (!serving) return { status: 'hidden', reason: 'paused' };

  const ref = openBlockMediaRef(token);
  // A ref is bound to the app that stored it: a fork reading the same cache is refused.
  if (!ref || ref.appBlockId !== viewer.appBlockId) return { status: 'hidden', reason: 'invalid' };
  if (ref.privateGen && ref.ownerId !== viewer.viewerId)
    return { status: 'hidden', reason: 'private' };
  if (ref.ownerId !== viewer.viewerId && viewer.hiddenOwnerIds.has(ref.ownerId))
    return { status: 'hidden', reason: 'owner_hidden' };

  const { exp: _refExp, ...claims } = ref;
  const ticket = sealBlockMediaTicket({
    ...claims,
    viewerId: viewer.viewerId,
    viewerBrowsingLevel: viewer.viewerBrowsingLevel,
  });
  if (!ticket) return { status: 'hidden', reason: 'invalid' };
  return { status: 'visible', url: blockMediaUrl(ticket) };
}

export { WORKFLOW_MEDIA_MAX_REFS } from '~/shared/constants/block-workflow-media.constants';

/**
 * The one body behind `GET_WORKFLOW_MEDIA` and its REST twin. Claims come from an
 * already-verified block token; the viewer, its level and the app are all read
 * from them, never from the request. A signed-out viewer is refused, as
 * `resolveGatedImagesForBlockClaims` refuses one.
 */
export async function resolveWorkflowMediaForBlockClaims(input: {
  claims: Pick<BlockTokenClaims, 'sub' | 'appBlockId' | 'maxBrowsingLevel' | 'viewerBrowsingLevel'>;
  refs: string[];
}): Promise<{ media: WorkflowMediaItem[] }> {
  const userId = parseSubjectUserId(input.claims.sub);
  if (userId == null) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'workflow media read requires an authenticated viewer',
    });
  }
  await assertAppBlocksEnabledForTokenUser(userId);

  const { resolveViewerBrowsingLevel } = await import(
    '~/server/services/blocks/block-gated-images.service'
  );
  if (hasEmptyViewerLevel(input.claims)) {
    return { media: input.refs.map(() => ({ status: 'hidden', reason: 'invalid' } as const)) };
  }

  const { getAllHiddenForUser } = await import('~/server/services/user-preferences.service');
  const hidden = await getAllHiddenForUser({ userId });
  const media = await resolveWorkflowMediaRefs({
    refs: input.refs,
    appBlockId: input.claims.appBlockId,
    viewerId: userId,
    viewerBrowsingLevel: resolveViewerBrowsingLevel(input.claims),
    hiddenOwnerIds: new Set(
      [...hidden.hiddenUsers, ...hidden.blockedUsers, ...hidden.blockedByUsers].map((u) => u.id)
    ),
  });
  return { media };
}

/**
 * The output view for an app-facing workflow read: the token's output ceiling, and a mint
 * context only while serving is on for this viewer. Off, a signed-out subject, or a failed
 * evaluation gives `mint: null`, so the read is exactly what it was before serving existed.
 */
export async function resolveBlockOutputView(
  claims: Pick<BlockTokenClaims, 'sub' | 'appBlockId' | 'maxBrowsingLevel' | 'viewerBrowsingLevel'>
): Promise<BlockOutputView> {
  const ceiling = blockOutputCeilingFromClaims(claims);
  const userId = parseSubjectUserId(claims.sub);
  if (userId == null || !(await isBlockMediaServing(userId))) return { ...ceiling, mint: null };
  return { ...ceiling, mint: { userId, appBlockId: claims.appBlockId } };
}
