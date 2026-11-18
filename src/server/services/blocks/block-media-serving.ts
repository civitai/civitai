import { TRPCError } from '@trpc/server';
import { logToAxiom } from '~/server/logging/client';
import { publicBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import { Flags } from '~/shared/utils/flags';
import { ensureFliptInitialized, FLIPT_FEATURE_FLAGS, isFliptSync } from '~/server/flipt/client';
import { sessionClient } from '~/server/auth/session-client';
import { buildFliptContext } from '~/server/services/feature-flags.service';
import type { SessionUser } from '~/types/session';
import {
  parseSubjectUserId,
  type BlockTokenClaims,
} from '~/server/middleware/block-scope.middleware';
import { assertAppBlocksEnabledForTokenUser } from '~/server/services/blocks/block-token-access.service';
import {
  recordBlockMediaServingDegraded,
  recordBlockMediaVerdict,
} from '~/server/metrics/app-block-runtime.metrics';
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
import {
  isOwnerOnlyMediaType,
  type BlockOutputRules,
  type BlockOutputView,
} from '~/server/services/blocks/block-output-mint';

/**
 * Whether host media serving is on for one viewer. Judged per viewer: Flipt segments read
 * either the entity id or the session context, so both are passed. A signed-out viewer is
 * `off` without asking Flipt. A viewer whose session does not resolve (the auth hub answers
 * "no such user" and every failure alike) is judged by entity id alone and treated as
 * anonymous downstream: the anonymous level, never the owner, nothing offered for pay. No
 * evaluation (an error, or a client that never started) is `unknown`: never served, and an
 * app-facing read restricts every media output rather than handing out raw urls. A running
 * pod that loses Flipt keeps its last-known state.
 */
export type BlockMediaServing = 'on' | 'off' | 'unknown';
export type BlockMediaServingDecision = { serving: BlockMediaServing; anonymous: boolean };

export async function decideBlockMediaServing(
  viewerId: number | null
): Promise<BlockMediaServingDecision> {
  if (viewerId === null) return { serving: 'off', anonymous: true };
  try {
    const flag = FLIPT_FEATURE_FLAGS.APP_BLOCKS_WORKFLOW_MEDIA_SERVE;
    const user = (await sessionClient.getSessionUserById(viewerId)) as SessionUser | null;
    // The sync read, not `isFlipt`: that answers false for an evaluation error or a client
    // that never started, where this needs to tell them apart from off.
    await ensureFliptInitialized();
    const on = user
      ? isFliptSync(flag, String(viewerId), buildFliptContext(user))
      : isFliptSync(flag, String(viewerId));
    if (on === null) throw new Error('no flag evaluation');
    if (!user) logServingDecision('no-session');
    return { serving: on ? 'on' : 'off', anonymous: !user };
  } catch {
    logServingDecision('eval-failed');
    return { serving: 'unknown', anonymous: false };
  }
}

export async function resolveBlockMediaServing(
  viewerId: number | null
): Promise<BlockMediaServing> {
  return (await decideBlockMediaServing(viewerId)).serving;
}

/** Counted after launch: decisions made without a session, or not made at all. */
function logServingDecision(reason: 'no-session' | 'eval-failed') {
  logToAxiom({ type: 'warning', name: 'app-block-media-serving-degraded', reason });
  recordBlockMediaServingDegraded(reason === 'eval-failed' ? 'eval_failed' : 'no_session');
}

/** The level a signed-out viewer browses at, within the token's own ceiling. */
export function anonymousBrowsingLevel(ceiling: number): number {
  return Flags.intersection(ceiling, publicBrowsingLevelsFlag);
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
  // Re-decided at each fetch: a viewer whose session has stopped resolving since the mint is
  // judged as signed out, never the owner.
  const decision = await decideBlockMediaServing(ticket.viewerId);
  if (decision.serving !== 'on') return { state: 'hidden', reason: 'paused' };
  const signedOut = ticket.anonymous || decision.anonymous;

  const blob = await readBlobState(ticket.blobId);
  if (blob.verdict === 'pending') return { state: 'pending' };
  // 🔴 A blob HEAD's `NA` is not step-output `na`: it is also what a blob that
  // was never scanned reports, and it never changes, so it hides for good. Owner-only
  // media is never scanned at all; the gate below shows it to its owner and no one else.
  if (!blob.blockedReason && blob.nsfwLevel === 'na' && !isOwnerOnlyMediaType(ticket.mediaType))
    return { state: 'hidden', reason: 'unrated' };

  const gate = deriveOutputGate(
    {
      mediaType: ticket.mediaType,
      nsfwLevel: blob.nsfwLevel,
      blockedReason: blob.blockedReason,
      neverRatedVideoStep: ticket.neverRatedVideoStep,
      privateGen: ticket.privateGen,
      ownerId: ticket.ownerId,
    },
    signedOut
      ? { userId: null, browsingLevel: anonymousBrowsingLevel(ticket.viewerBrowsingLevel) }
      : { userId: ticket.viewerId, browsingLevel: ticket.viewerBrowsingLevel }
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
  const decision = await decideBlockMediaServing(args.viewerId);
  // A viewer whose session did not resolve replays as signed out, at the anonymous level.
  const viewer = decision.anonymous
    ? {
        ...args,
        ownerView: false,
        viewerBrowsingLevel: anonymousBrowsingLevel(args.viewerBrowsingLevel),
      }
    : { ...args, ownerView: true };
  return args.refs.map((token) => {
    const item = judgeRef(token, viewer, decision.serving === 'on');
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
    /** False for a viewer judged as signed out: never the owner of any ref. */
    ownerView: boolean;
  },
  serving: boolean
): WorkflowMediaItem | { status: 'hidden'; reason: 'owner_hidden' } {
  if (!serving) return { status: 'hidden', reason: 'paused' };

  const ref = openBlockMediaRef(token);
  // A ref is bound to the app that stored it: a fork reading the same cache is refused.
  if (!ref || ref.appBlockId !== viewer.appBlockId) return { status: 'hidden', reason: 'invalid' };
  const isOwner = viewer.ownerView && ref.ownerId === viewer.viewerId;
  if (ref.privateGen && !isOwner) return { status: 'hidden', reason: 'private' };
  if (ref.ownerId !== viewer.viewerId && viewer.hiddenOwnerIds.has(ref.ownerId))
    return { status: 'hidden', reason: 'owner_hidden' };

  const { exp: _refExp, ...claims } = ref;
  const ticket = sealBlockMediaTicket({
    ...claims,
    viewerId: viewer.viewerId,
    viewerBrowsingLevel: viewer.viewerBrowsingLevel,
    ...(viewer.ownerView ? {} : { anonymous: true as const }),
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
 * The output view for an app-facing workflow read: the token's output ceiling, whether
 * serving is on for this viewer, and a mint context only while it is. Off or a signed-out
 * subject gives `serving: false, mint: null`, the read as it was before serving existed. A
 * failed decision adds `servingUnknown`, which restricts every media output.
 */
export async function resolveBlockOutputView(
  claims: Pick<BlockTokenClaims, 'sub' | 'appBlockId' | 'maxBrowsingLevel' | 'viewerBrowsingLevel'>
): Promise<BlockOutputView> {
  const ceiling = blockOutputCeilingFromClaims(claims);
  const userId = parseSubjectUserId(claims.sub);
  const { serving, anonymous } = await decideBlockMediaServing(userId ?? null);
  if (serving === 'unknown')
    return { ...ceiling, serving: false, servingUnknown: true, mint: null };
  if (userId == null || serving === 'off') return { ...ceiling, serving: false, mint: null };
  if (anonymous) {
    // The token's own level is never used for a viewer whose session did not resolve.
    return {
      maxBrowsingLevel: anonymousBrowsingLevel(ceiling.maxBrowsingLevel),
      serving: true,
      anonymous: true,
      mint: { userId, appBlockId: claims.appBlockId, anonymous: true },
    };
  }
  return { ...ceiling, serving: true, mint: { userId, appBlockId: claims.appBlockId } };
}

/**
 * The rules for a server-side read of the viewer's outputs (publish, post, persist): the
 * same ceiling and serving decision as {@link resolveBlockOutputView}, with nothing minted,
 * so these name the same positions as usable as the poll does.
 */
export async function resolveBlockOutputRules(
  claims: Pick<BlockTokenClaims, 'sub' | 'appBlockId' | 'maxBrowsingLevel' | 'viewerBrowsingLevel'>
): Promise<BlockOutputRules> {
  const { mint: _mint, ...rules } = await resolveBlockOutputView(claims);
  return rules;
}
