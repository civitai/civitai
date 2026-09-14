import { TRPCError } from '@trpc/server';
import type { Prisma } from '@prisma/client';
import { getEdgeUrl } from '~/client-utils/edge-url';
import { dbRead, dbWrite } from '~/server/db/client';
import { throwOnBlockedUserContent } from '~/server/services/blocklist.service';
import { BLOCK_PUBLISHED_APP_ID_META_KEY } from '~/server/services/blocks/block-image-upload.service';
import { isAllowedOutputHost } from '~/server/services/blocks/block-image-upload.logic';
import { classifyGatedImageForViewer } from '~/server/services/blocks/block-gated-images.logic';
import { blockWorkflowOwnedByAppUser } from '~/server/services/blocks/block-workflows.service';
import { appBlockTag, projectAppWorkflow } from '~/server/services/blocks/workflow.service';
import {
  BLOCK_POST_MAX_IMAGES,
  BLOCK_POST_MAX_TAGS,
  isTerminalBlockPostWorkflowStatus,
  normalizeBlockPostTagNames,
  resolveWorkflowOutputSelection,
  validateBlockPostText,
  type BlockPostPreview,
  type BlockPostSource,
} from '~/server/services/blocks/block-post.logic';
import { ModelStatus, TagTarget, TagType } from '~/shared/utils/prisma/enums';
import { Availability } from '~/shared/utils/prisma/enums';

/**
 * App Blocks → a REAL Civitai Post (`blocks.createPostFromApp` /
 * `CREATE_POST_FROM_APP`) — the IMPURE half: ownership proofs, provenance reads,
 * the self-dealing guard, and the transactional write. The pure decisions (text
 * bounds, tag normalisation, source selection) are `block-post.logic.ts`.
 *
 * ## What this is, relative to `publishGenerationOutputs`
 *
 * That op makes a BARE `Image` row: no post, no gallery, no feed, no reward, no
 * notification. This one makes PUBLIC, feed-visible, reward-earning content under
 * the VIEWER'S byline. Everything below follows from that difference, and it is
 * why this is a SIBLING rather than a flag on the existing op:
 *
 *   - a different SCOPE (`posts:write:self`, consent-gated + sensitive) rather
 *     than `ai:write:budgeted`;
 *   - a different CONSENT SENTENCE — the publish confirm says the images "become
 *     visible to other viewers of this app", which is FALSE for a profile post,
 *     and that sentence is the security control;
 *   - a different RATE BUCKET (posts, not images);
 *   - ATOMIC rather than best-effort-per-image: a partially-created post is a
 *     public artefact the viewer never agreed to.
 *
 * ## The two-phase shape, and why it is not optional
 *
 * `previewPostFromApp` (read-only) resolves EVERYTHING the consent dialog renders
 * — the exact title/detail, the tag names that will ACTUALLY be applied, the
 * host-fetched model/version names, and real image thumbnails — and
 * `createPostFromApp` re-derives all of it and writes. The preview exists because
 * the block is sandboxed and untrusted: a confirm rendering block-supplied text
 * or block-supplied thumbnails could show one thing and publish another, which is
 * precisely the failure `collectionFollowGate.ts` documents for the follow bridge
 * ("IT MUST STAY HOST-FETCHED. Do NOT add a block-supplied `name` to the wire and
 * render it").
 *
 * 🔴 THE PREVIEW IS NOT A TOKEN AND CONFERS NOTHING. `createPostFromApp` re-runs
 * every guard from scratch; a caller that skips the preview entirely gets the
 * same refusals. The preview is a RENDERING aid, so a preview/commit divergence
 * is a UX bug, never an authorization hole.
 *
 * ## What this path does NOT do, deliberately
 *
 *   - It does NOT go through `createPost` (`post.service.ts`). That function
 *     calls `findOrCreateTagsByName`, which CREATES global site tags with no cap
 *     and no blocklist check — see `resolveExistingPostTags` below for why a
 *     block must never reach it. It also cannot write `Post.metadata`, which is
 *     the whole point of the attribution marker.
 *   - It does NOT go through `addPostImage`. That function CREATES an Image; it
 *     cannot adopt one. Calling it with an existing row's uuid `url` would create
 *     a SECOND Image pointing at the same stored object and orphan the first.
 *     Adoption here is a bounded `updateMany` whose matched COUNT is the
 *     ownership+provenance proof (see `adoptImagesIntoPost`).
 */

/** The verified token facts this service needs. Never widened to the whole claims object. */
export type BlockPostActor = {
  /** Token subject — the post's author. Never a client value. */
  userId: number;
  /** `claims.appId` = the OauthClient id. The provenance marker's value. */
  appId: string;
  /** `claims.appBlockId` — the workflow-ownership binding. */
  appBlockId: string;
  /** The viewer's resolved browsing ceiling, for the published-image clamp. */
  browsingLevel: number;
};

/** One resolved image, ready to be adopted or materialised. */
type ResolvedSourceImage =
  | { kind: 'workflow'; url: string; width: number | null; height: number | null }
  | {
      kind: 'published';
      imageId: number;
      url: string;
      width: number | null;
      height: number | null;
    };

function badRequest(message: string): never {
  throw new TRPCError({ code: 'BAD_REQUEST', message });
}
function forbidden(message: string): never {
  throw new TRPCError({ code: 'FORBIDDEN', message });
}

// ─────────────────────────────────────────────────────────────────────────────
// TAGS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve requested tag names to EXISTING `Tag` rows. Unmatched names are
 * DROPPED, never created.
 *
 * 🔴 THIS IS THE ONE COPY MITIGATION WITH NO UNDO ON THE OTHER SIDE, WHICH IS WHY
 * IT REFUSES RATHER THAN SANITISES. The native path calls
 * `findOrCreateTagsByName` (`tag.service.ts`), which `createMany`s a
 * `TagType.UserGenerated` row for every unmatched name — with no count cap, no
 * length cap, and no blocklist check (`throwOnBlockedUserContent` at
 * `post.service.ts` screens `[title, detail]` only; tags are never screened). A
 * sandboxed third-party app reaching that function writes into the GLOBAL,
 * cross-surface tag namespace under the viewer's name, permanently. A bad title
 * can be edited; a minted tag is site-wide and there is no per-tag undo in the
 * post flow.
 *
 * So: existing tags only. The decision is REFUSE-BY-DROP rather than
 * REFUSE-BY-THROW because a novel tag is a benign authoring mistake, not an
 * attack, and throwing would make a working app break the day someone renames a
 * tag. The dropped names are RETURNED and the host confirm renders the RESOLVED
 * list — so the viewer agrees to the tags that will actually be applied, and an
 * author debugging a missing tag sees it in the preview rather than guessing.
 *
 * Additionally excluded even when the name DOES resolve:
 *   - `adminOnly` — moderator-controlled labels;
 *   - `TagType.Moderation` / `TagType.System` — these drive moderation and
 *     platform behaviour, not description. A block applying `minor` or a
 *     TOS-class label to a viewer's post would be handing a third party a
 *     moderation lever.
 *   - tags whose `target` does not include `Post` — that is the population
 *     `findOrCreateTagsByName` itself creates for posts, so it is the right set;
 *     anything else is not a post tag.
 *
 * ⚠️ Reading the exclusions above as "safe" would over-claim: `unlisted` is NOT
 * excluded, because an unlisted tag is a display decision, not a capability, and
 * excluding it would silently drop legitimate tags.
 */
export async function resolveExistingPostTags(
  requested: string[]
): Promise<{ tagIds: number[]; names: string[]; dropped: string[] }> {
  const names = normalizeBlockPostTagNames(requested);
  if (names.length === 0) return { tagIds: [], names: [], dropped: [] };

  const rows = await dbRead.tag.findMany({
    where: {
      name: { in: names },
      adminOnly: false,
      type: { in: [TagType.UserGenerated, TagType.Label] },
      target: { has: TagTarget.Post },
    },
    select: { id: true, name: true },
  });

  // `Tag.name` is citext, so the DB match is already case-insensitive; lowercase
  // both sides anyway so the returned display names and the dropped set are
  // computed from ONE normalisation rather than two that could disagree.
  const found = new Map(rows.map((r) => [r.name.toLowerCase(), r.id]));
  const tagIds: number[] = [];
  const resolved: string[] = [];
  const dropped: string[] = [];
  for (const name of names) {
    const id = found.get(name);
    if (id == null) {
      dropped.push(name);
      continue;
    }
    if (tagIds.length >= BLOCK_POST_MAX_TAGS) break;
    tagIds.push(id);
    resolved.push(name);
  }
  return { tagIds, names: resolved, dropped };
}

// ─────────────────────────────────────────────────────────────────────────────
// MODEL-VERSION GALLERY TARGET
// ─────────────────────────────────────────────────────────────────────────────

export type ResolvedGalleryTarget = {
  modelVersionId: number;
  modelId: number;
  modelName: string;
  versionName: string;
};

/**
 * Gate + resolve a `modelVersionId` gallery attach.
 *
 * THAT THIS PATH EXISTS IN THE FIRST RELEASE IS AN OPERATOR DECISION, not a
 * requirement of the feature: an app-created post may attach to a model
 * gallery via `modelVersionId`. The alternative that was weighed was DEFERRING
 * gallery attach to a later, separately-gated phase — ship profile posts only,
 * add galleries once the path has run in production. It was rejected because a
 * post that cannot reach the gallery is not the thing app authors asked for, and
 * a second gated phase would have to re-litigate the same guards. The price of
 * taking it now is the self-dealing exposure below, which is why that guard is
 * part of this function rather than a later hardening pass.
 *
 * 🔴 THIS IS STRICTLY STRICTER THAN NATIVE, ON PURPOSE, AND NATIVE IS THE REASON.
 * `createPost` performs NO ownership, status, or permission check on
 * `modelVersionId` whatsoever — it reads only `model.availability`, never throws,
 * and writes a nonexistent id straight onto the row. The native UI's
 * "published versions only" constraint is a client-side `<Select>` filter
 * (`excludeUnpublished` on `posts/create.tsx`), trivially bypassed by editing the
 * URL. That hole is pre-existing and natively reachable; this feature would be
 * its first PROGRAMMATIC, third-party-driven caller, which is a different risk
 * profile even though it is the same hole. Fixing it natively is a separate
 * change with a much larger blast radius (every `/posts/create?modelVersionId=`
 * link, the review flow, the resource-review editor), so it is NOT a prerequisite
 * here — but shipping a block path no stricter than native would be.
 *
 * Because every check here is an ADDITION over native, none of it can break a
 * native flow: this function is only ever called from the block path.
 *
 * ### The self-dealing guard
 *
 * `imagePostedToModelReward` pays **50 blue Buzz to the MODEL OWNER** per distinct
 * `(posterId, modelVersionId)` pair, all-time, capped at 5,000 per version and
 * 50,000/month per owner, and its only self-post guard is
 * `modelOwnerId === posterId`. An app author who also owns models can therefore
 * build an app that routes every viewer's post at their own model versions and
 * collect 50 Buzz per viewer per version — in policy, at scale, with the reward
 * system unable to see that the post came from an app at all (no suppression
 * signal exists: `getKey` receives only `{modelId, modelVersionId, posterId}`).
 *
 * 🔴 REFUSING `Model.userId === <the app publisher>` IS THE ONLY CONTROL THAT
 * REMOVES THE PAYOFF. Rate limits, trust gates and audit rows all raise the cost;
 * this one takes the money off the table. It must not be relaxed into a warning.
 *
 * ⚠️ WHAT IT DOES NOT CLOSE, stated plainly so nobody reads it as complete: a
 * COLLUDING PAIR (app author + a second account owning the models) defeats it
 * entirely, and no code control can catch that. What makes collusion *detectable*
 * is `Post.metadata.blockPublishedAppId` plus the `block_scope_invocations` row —
 * i.e. the attribution marker is doing anti-fraud work, not decoration.
 */
export async function resolveGalleryTarget(input: {
  modelVersionId: number;
  /**
   * The token subject — the post's author.
   *
   * ⚠️ DELIBERATELY NOT COMPARED AGAINST THE MODEL OWNER, and that is a decision
   * rather than an omission. A viewer posting to their OWN model is legitimate;
   * `imagePostedToModelReward`'s own `modelOwnerId === posterId` guard already
   * declines to pay in that case, and refusing it here would break a normal flow
   * to fix nothing. The self-dealing hazard is the APP PUBLISHER owning the
   * model, which is what the check below tests. The field is carried so the
   * actor is visible at the call site and so a future rule that DOES need the
   * poster has it; `void` marks the non-use as intentional to a reader and to
   * the linter.
   */
  posterUserId: number;
  /** `claims.appId`; the publisher is resolved from it here, never passed in. */
  appId: string;
}): Promise<ResolvedGalleryTarget> {
  const { modelVersionId, posterUserId, appId } = input;
  void posterUserId;

  const version = await dbRead.modelVersion.findUnique({
    where: { id: modelVersionId },
    select: {
      id: true,
      name: true,
      status: true,
      modelId: true,
      model: {
        select: {
          id: true,
          name: true,
          userId: true,
          status: true,
          deletedAt: true,
          availability: true,
        },
      },
    },
  });

  // Existence is reported as a plain BAD_REQUEST rather than NOT_FOUND: the ids
  // are public and enumerable either way, so there is no existence bit to
  // protect, and a uniform refusal keeps the block from using the status code to
  // distinguish "gone" from "not allowed".
  if (!version || !version.model) badRequest('gallery target is not available');
  if (version.model.deletedAt) badRequest('gallery target is not available');
  if (version.status !== ModelStatus.Published) badRequest('gallery target is not available');
  if (version.model.status !== ModelStatus.Published) badRequest('gallery target is not available');
  if (version.model.availability !== Availability.Public) {
    badRequest('gallery target is not available');
  }

  // SELF-DEALING. Resolved from the token's OWN appId → OauthClient.userId; the
  // block supplies neither side of this comparison.
  const client = await dbRead.oauthClient.findUnique({
    where: { id: appId },
    select: { userId: true },
  });
  // FAIL CLOSED on an unresolvable client: without the publisher id this guard
  // cannot be evaluated, and "cannot evaluate" must not mean "allow". A block
  // token whose OauthClient has vanished has bigger problems than this refusal.
  if (!client) forbidden('cannot verify app publisher for a gallery attach');
  if (client.userId === version.model.userId) {
    forbidden('this app may not attach posts to its own publisher’s models');
  }

  return {
    modelVersionId: version.id,
    modelId: version.model.id,
    modelName: version.model.name,
    versionName: version.name,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SOURCE RESOLUTION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ownership + app-tag proof for ONE workflow, returning the SAME ordered
 * projection `queryAppWorkflows` hands the block — so the block's `imageIndexes`
 * line up with what it saw.
 *
 * The first two guards are copied from `publishGenerationOutputs` verbatim in
 * intent and order, and for the same reason: (a) `blockWorkflowOwnedByAppUser` is
 * the durable (user, app, workflow) binding the orchestrator lacks and is the
 * load-bearing user check; (b) the orchestrator's own record must carry the
 * `app-block:<appId>` tag, as defence in depth. Either fails → FORBIDDEN, and
 * nothing is fetched.
 *
 * (c) is NOT inherited from the publish path and is specific to posting: the
 * workflow must be TERMINAL. A publish is a one-shot grid write with no consent
 * screen behind it, so a running workflow gaining an output costs nothing there;
 * a post is confirmed against a specific set of thumbnails, so it costs the
 * accuracy of the confirm. See `BLOCK_POST_TERMINAL_WORKFLOW_STATUSES`.
 *
 * 🔴 `blockWorkflowOwnedByAppUser` FAILS CLOSED BY RETURNING FALSE, NOT BY
 * THROWING — a DB error reads as "not owned". That is the correct trade for a
 * security guard and is inherited deliberately; do not "improve" it into a throw
 * that a caller might catch.
 */
export async function resolveOwnedWorkflowOutputs(input: {
  userId: number;
  appId: string;
  appBlockId: string;
  workflowId: string;
  getWorkflow: (workflowId: string) => Promise<unknown>;
}): Promise<Array<{ url: string; width: number | null; height: number | null }>> {
  const owned = await blockWorkflowOwnedByAppUser({
    userId: input.userId,
    appBlockId: input.appBlockId,
    workflowId: input.workflowId,
  });
  if (!owned) forbidden('workflow is not in this app subqueue');

  const workflow = (await input.getWorkflow(input.workflowId)) as Parameters<
    typeof projectAppWorkflow
  >[0];
  if (!(workflow.tags ?? []).includes(appBlockTag(input.appId))) {
    forbidden('workflow is not tagged for this app');
  }

  const projected = projectAppWorkflow(workflow);

  // 🔴 TERMINALITY GATE — the invariant that makes the preview and the write
  // agree on WHICH IMAGES. A still-running workflow can gain an output between
  // the two phases, so the viewer confirms N thumbnails and gets N+1 images. This
  // refuses the GENERATOR of that divergence rather than detecting the symptom
  // afterwards: a terminal workflow's output set is frozen, so both phases must
  // see the same set. Free — `projectAppWorkflow` already computed the status on
  // the projection this function was reading anyway — and it binds every caller,
  // including any future one that renders no dialog.
  //
  // BAD_REQUEST, not FORBIDDEN: nothing about the caller is unauthorised. The
  // workflow is simply not finished, and the message says so because the app's
  // correct response is to wait and retry, which it cannot infer from a refusal
  // that reads as a permission problem. See
  // `BLOCK_POST_TERMINAL_WORKFLOW_STATUSES` for which statuses count and why
  // `failed`/`expired`/`canceled` are admitted.
  if (!isTerminalBlockPostWorkflowStatus(projected.status)) {
    badRequest('workflow is still running — wait for it to finish before posting');
  }

  // Re-validate every url against the output-host allowlist HERE, not only at
  // fetch time. These urls are handed to the HOST to render as consent
  // thumbnails, so an off-allowlist url would be an image request the host makes
  // to an arbitrary origin on the block's behalf — a different exposure from the
  // server-side fetch the persist path already bounds.
  return projected.images.filter((img) => isAllowedOutputHost(img.url));
}

/** The gated edge-url width used for consent thumbnails + the published-image read. */
const POST_PREVIEW_EDGE_WIDTH = 450;

/**
 * Resolve `published` source ids to images this app published FOR THIS VIEWER and
 * that are still adoptable.
 *
 * FOUR conjuncts, each closing a different hole, none of them redundant:
 *   - `userId = <token subject>` — the post author must own the image. The
 *     sibling cross-user grid read (`block-gated-images.service.ts`) deliberately
 *     does NOT have this conjunct, because that read is BY DESIGN cross-user;
 *     copying it here unchanged would have let a block pull ANOTHER viewer's
 *     image of the same app into this viewer's post.
 *   - `metadata->>'blockPublishedAppId' = <token appId>` — the app may only
 *     re-use what IT published, never another app's images.
 *   - `postId IS NULL` — an image already in a post is not adoptable. This also
 *     makes double-posting impossible without a second check.
 *   - `classifyGatedImageForViewer` — terminally `Scanned`, unflagged, and within
 *     the viewer's ceiling.
 *
 * 🔴 THE `postId IS NULL` CONJUNCT HAS A PRODUCT CONSEQUENCE THE SDK MUST
 * DOCUMENT: the app's own grid read (`blocks.getImagesByIds`) is scoped the same
 * way, so ADOPTING AN IMAGE INTO A POST REMOVES IT FROM THE APP'S OWN SHARED
 * GRID. An app cannot both keep an image in its grid and let the viewer post it.
 * That is accepted rather than worked around: relaxing the conjunct on the READ
 * side would re-open the post-deletion-orphan case it was added to prevent.
 *
 * Unresolvable ids are REFUSED, not skipped — the viewer is shown thumbnails and
 * agrees to that set, so silently posting fewer images than were confirmed would
 * make the confirm inaccurate.
 *
 * ⚠️ TIMING, because it is the first thing an app author will hit and it reads as
 * a bug: an image published through the grid bridge is NOT immediately postable.
 * That bridge returns its ids before any scan has run, and the clamp above
 * requires a terminal `Scanned` — so an app that publishes and posts in the same
 * breath gets a refusal. It must poll the existing scan gate first, exactly as it
 * already does before displaying the image. (That wait also makes replica lag a
 * non-issue for this `dbRead`: seconds have passed by the time the id is usable.)
 */
export async function resolveAppPublishedImages(input: {
  imageIds: number[];
  userId: number;
  appId: string;
  browsingLevel: number;
}): Promise<Array<{ imageId: number; url: string; width: number | null; height: number | null }>> {
  const ids = [...new Set(input.imageIds)].filter((n) => Number.isInteger(n) && n > 0);
  if (ids.length === 0) badRequest('no valid image ids in a published source');

  const rows = await dbRead.$queryRaw<
    Array<{
      id: number;
      url: string;
      nsfwLevel: number;
      ingestion: string;
      width: number | null;
      height: number | null;
      needsReview: string | null;
      poi: boolean | null;
      minor: boolean | null;
      tosViolation: boolean | null;
      acceptableMinor: boolean | null;
      blockedFor: string | null;
    }>
  >`
    SELECT
      i."id", i."url", i."nsfwLevel", i."ingestion", i."width", i."height",
      i."needsReview", i."poi", i."minor", i."tosViolation", i."acceptableMinor", i."blockedFor"
    FROM "Image" i
    WHERE i."id" = ANY(${ids}::int[])
      AND i."userId" = ${input.userId}
      AND i."postId" IS NULL
      AND i."metadata"->>(${BLOCK_PUBLISHED_APP_ID_META_KEY}::text) = ${input.appId}
  `;

  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: Array<{ imageId: number; url: string; width: number | null; height: number | null }> =
    [];
  for (const id of ids) {
    const row = byId.get(id);
    // ONE refusal message for "not yours" / "not this app's" / "already posted" /
    // "does not exist", so the reply cannot be used to probe which it was.
    if (!row) badRequest('an image is not available to post');
    const verdict = classifyGatedImageForViewer(
      {
        ingestion: row.ingestion,
        nsfwLevel: row.nsfwLevel,
        needsReview: row.needsReview,
        poi: row.poi,
        minor: row.minor,
        tosViolation: row.tosViolation,
        acceptableMinor: row.acceptableMinor,
        blockedFor: row.blockedFor,
      },
      input.browsingLevel
    );
    if (verdict.status !== 'visible') badRequest('an image is not available to post');
    out.push({
      imageId: row.id,
      // The raw storage key never leaves the server.
      url: getEdgeUrl(row.url, { width: POST_PREVIEW_EDGE_WIDTH }),
      width: row.width,
      height: row.height,
    });
  }
  return out;
}

/**
 * Walk `sources[]` in order and resolve every one, enforcing the image cap as a
 * REFUSAL rather than a truncation.
 *
 * ⚠️ THE CAP IS A REFUSAL HERE AND A SILENT `break` IN `publishGenerationOutputs`,
 * AND THE DIVERGENCE IS DELIBERATE. Truncating a grid publish costs you tiles;
 * truncating a POST would publish a different set than the one the viewer saw
 * thumbnails of and clicked Publish on. A confirm that can be right about the
 * content and wrong about the set is not a consent screen.
 */
export async function resolveBlockPostSources(input: {
  sources: BlockPostSource[];
  actor: BlockPostActor;
  getWorkflow: (workflowId: string) => Promise<unknown>;
}): Promise<ResolvedSourceImage[]> {
  const out: ResolvedSourceImage[] = [];
  for (const source of input.sources) {
    if (source.kind === 'workflow') {
      const outputs = await resolveOwnedWorkflowOutputs({
        userId: input.actor.userId,
        appId: input.actor.appId,
        appBlockId: input.actor.appBlockId,
        workflowId: source.workflowId,
        getWorkflow: input.getWorkflow,
      });
      if (outputs.length === 0) badRequest('workflow has no available outputs to post');
      const selection = resolveWorkflowOutputSelection({
        requested: source.imageIndexes,
        availableCount: outputs.length,
        // Ask for one MORE than the remaining budget so an over-cap request is
        // visible as an over-cap request and refused below, rather than silently
        // clipped to exactly the budget.
        maxCount: BLOCK_POST_MAX_IMAGES - out.length + 1,
      });
      if (selection.length === 0) badRequest('no valid output indexes to post');
      for (const idx of selection) {
        const o = outputs[idx];
        out.push({ kind: 'workflow', url: o.url, width: o.width, height: o.height });
      }
    } else {
      const images = await resolveAppPublishedImages({
        imageIds: source.imageIds,
        userId: input.actor.userId,
        appId: input.actor.appId,
        browsingLevel: input.actor.browsingLevel,
      });
      for (const img of images) out.push({ kind: 'published', ...img });
    }
    if (out.length > BLOCK_POST_MAX_IMAGES) {
      badRequest(`a post may contain at most ${BLOCK_POST_MAX_IMAGES} images`);
    }
  }
  if (out.length === 0) badRequest('a post needs at least one image');
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// PREVIEW (read-only)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve the full host-rendered consent payload for a request, WITHOUT writing
 * anything. Every field returned is server-derived. See the module docblock for
 * why this phase exists and why it confers no authority.
 */
export async function previewBlockPost(input: {
  actor: BlockPostActor;
  sources: BlockPostSource[];
  title?: string | null;
  detail?: string | null;
  tags?: string[];
  modelVersionId?: number;
  getWorkflow: (workflowId: string) => Promise<unknown>;
}): Promise<BlockPostPreview> {
  const text = validateBlockPostText({ title: input.title, detail: input.detail });
  if (!text.ok) badRequest(text.reason);

  const tags = await resolveExistingPostTags(input.tags ?? []);
  // Screen title, detail AND the RESOLVED tag names. The native path screens
  // `[title, detail]` only — tags are never screened there — so including them is
  // another place this path is deliberately stricter than native.
  await throwOnBlockedUserContent([text.title, text.detail, ...tags.names], { surface: 'post' });

  const gallery =
    input.modelVersionId != null
      ? await resolveGalleryTarget({
          modelVersionId: input.modelVersionId,
          posterUserId: input.actor.userId,
          appId: input.actor.appId,
        })
      : null;

  const resolved = await resolveBlockPostSources({
    sources: input.sources,
    actor: input.actor,
    getWorkflow: input.getWorkflow,
  });

  return {
    title: text.title,
    detail: text.detail,
    tags: tags.names,
    droppedTags: tags.dropped,
    images: resolved.map((r) => ({ url: r.url, width: r.width, height: r.height })),
    gallery: gallery
      ? {
          modelVersionId: gallery.modelVersionId,
          modelName: gallery.modelName,
          versionName: gallery.versionName,
        }
      : null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// WRITE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `Post.metadata` key carrying the publishing app's `OauthClient.id`.
 *
 * SERVER-AUTHORITATIVE BY CONSTRUCTION: no post input schema has a `metadata`
 * field (`postCreateSchema` / `postUpdateSchema` both omit it), so no client —
 * block, browser or API — can set or forge it, and the server writes it
 * unconditionally on this path so a block cannot suppress it either. The one
 * native path that mutates `Post.metadata` (`updatePost`'s anti-bump raw UPDATE)
 * uses targeted key-deletes, so adding a key here is safe.
 *
 * Same key name and same value semantics as the `Image` precedent
 * (`BLOCK_PUBLISHED_APP_ID_META_KEY`) so ONE moderation sweep can read both.
 *
 * 🔴 THE BADGE MUST RENDER FROM THIS COLUMN, NOT FROM THE COPY. A block can write
 * "made with X" into `title`/`detail` and be lying; it cannot write this.
 */
export const BLOCK_POST_APP_ID_META_KEY = 'blockPublishedAppId' as const;

export type CreatedBlockPost = {
  postId: number;
  url: string;
  imageIds: number[];
  modelVersionId: number | null;
  tagNames: string[];
};

/**
 * Adopt already-existing `Image` rows into `postId`, and assert that EVERY
 * requested row moved.
 *
 * 🔴 THE MATCHED COUNT **IS** THE OWNERSHIP + PROVENANCE GUARD, ENFORCED
 * ATOMICALLY. The `where` repeats every conjunct `resolveAppPublishedImages`
 * checked — owner, provenance marker, and `postId IS NULL` — so a row that
 * changed underneath us between the read and the write (another concurrent post
 * adopting it, an ownership transfer, a moderation action) simply does not match,
 * the count comes back short, and the whole transaction rolls back. A read-then-
 * write that trusted the earlier SELECT would be a TOCTOU window; this has none.
 *
 * It is NOT `addPostImage`: that function CREATES an Image and has no adopt path.
 * Handing it an existing row's uuid `url` creates a SECOND row pointing at the
 * same stored object and orphans the first — a silent double-count, and the trap
 * to avoid rather than a route to use.
 */
async function adoptImagesIntoPost(
  tx: Prisma.TransactionClient,
  input: { imageIds: number[]; postId: number; userId: number; appId: string; startIndex: number }
): Promise<void> {
  if (input.imageIds.length === 0) return;
  // `index` is per-image, so this cannot be one `updateMany`. Each row is still
  // gated by the full conjunct set, and the whole loop is inside the caller's
  // transaction — a short count on ANY row aborts everything.
  for (let i = 0; i < input.imageIds.length; i++) {
    const id = input.imageIds[i];
    const res = await tx.image.updateMany({
      where: {
        id,
        userId: input.userId,
        postId: null,
        metadata: { path: [BLOCK_PUBLISHED_APP_ID_META_KEY], equals: input.appId },
      },
      data: { postId: input.postId, index: input.startIndex + i },
    });
    if (res.count !== 1) {
      throw new TRPCError({ code: 'CONFLICT', message: 'an image is no longer available to post' });
    }
  }
}

/**
 * Create the Post, attach its images, publish it, and stamp the attribution
 * marker — ALL IN ONE TRANSACTION.
 *
 * 🔴 ATOMICITY IS A PRODUCT REQUIREMENT HERE, NOT A STYLE CHOICE. The publish
 * path's best-effort per-image loop is fine for a grid: a dropped image is a
 * missing tile. A partially-written post is a PUBLIC artefact under the viewer's
 * name that they never agreed to, and there is no "half a post" the viewer
 * consented to. Every failure leaves NO Post row.
 *
 * Images are MATERIALISED BEFORE the transaction opens (`materialisedImageIds`),
 * because materialising a workflow output is a network fetch + S3 upload and must
 * never hold a DB transaction open. Those rows are bare, post-less `Image`s — the
 * exact artefact `publishGenerationOutputs` produces — so a transaction failure
 * after materialisation leaves them orphaned rather than half-posted. That is the
 * SAME residue the existing publish path leaves on a partial failure, and it is
 * invisible to the site (a post-less image has no feed presence) and re-readable
 * by the app (its provenance marker and `postId IS NULL` both still hold).
 *
 * `publishedAt` is written INSIDE the create, so the post is never briefly
 * visible as an empty draft.
 */
export async function writeBlockPost(input: {
  actor: BlockPostActor;
  /** Image rows to adopt, in post order. Already materialised + fully guarded. */
  materialisedImageIds: number[];
  title: string | null;
  detail: string | null;
  tagIds: number[];
  tagNames: string[];
  gallery: ResolvedGalleryTarget | null;
}): Promise<CreatedBlockPost> {
  const { actor, materialisedImageIds, gallery } = input;
  const publishedAt = new Date();

  const post = await dbWrite.$transaction(async (tx) => {
    const created = await tx.post.create({
      data: {
        userId: actor.userId,
        title: input.title,
        detail: input.detail,
        publishedAt,
        modelVersionId: gallery?.modelVersionId ?? null,
        // Mirrors `createPost`: a post attached to a model version inherits that
        // model's availability. Resolved here rather than re-read, because
        // `resolveGalleryTarget` already REFUSED anything non-Public — so the
        // value is Public by construction, and pinning it makes that explicit
        // rather than leaving a second, weaker derivation lying around.
        availability: Availability.Public,
        metadata: { [BLOCK_POST_APP_ID_META_KEY]: actor.appId },
        tags:
          input.tagIds.length > 0
            ? { create: input.tagIds.map((tagId) => ({ tagId })) }
            : undefined,
      },
      select: { id: true },
    });

    await adoptImagesIntoPost(tx, {
      imageIds: materialisedImageIds,
      postId: created.id,
      userId: actor.userId,
      appId: actor.appId,
      startIndex: 0,
    });

    return created;
  });

  return {
    postId: post.id,
    url: `/posts/${post.id}`,
    imageIds: materialisedImageIds,
    modelVersionId: gallery?.modelVersionId ?? null,
    tagNames: input.tagNames,
  };
}

/**
 * Everything a NATIVE publish fires, re-issued for a post this path wrote
 * directly.
 *
 * 🔴 WHY THIS FUNCTION EXISTS AT ALL, AND WHY EVERY LINE IS DELIBERATE. The
 * native side effects live in `post.controller.ts`'s create/update handlers, not
 * in `post.service.ts` — so a path that writes the Post row itself inherits NONE
 * of them and silently produces a post that pays no reward, busts no gallery
 * cache and never reaches the search index.
 *
 * 🔴 THE OPERATOR DECISION, IN FULL, BECAUSE IT IS THE REASON REWARDS FIRE HERE
 * AT ALL: an app-created post participates in rewards EXACTLY like a native one.
 * The alternative that was considered and rejected was ATTRIBUTE-BUT-SUPPRESS —
 * mark the post as app-created and pay nothing for it — on the grounds that a
 * post the viewer consented to, under the viewer's own byline, is the viewer's
 * post, and paying it differently would make the reward depend on which client
 * composed it. The consequence to hold in mind when reading the list below is
 * that this path is a real Buzz-spending surface, which is why the rate buckets
 * and the self-dealing guard exist rather than being belt-and-braces.
 *
 * What fires, and the native line it mirrors:
 *   - `firstDailyPostReward`      — 25 blue Buzz, 25/day cap, double-deduped.
 *   - `imagePostedToModelReward`  — ONLY when a gallery target was attached; 50
 *                                   blue Buzz to the MODEL OWNER. Its own
 *                                   `modelOwnerId === posterId` guard handles the
 *                                   self-post case; the SELF-DEALING guard in
 *                                   `resolveGalleryTarget` is what handles the
 *                                   app-publisher case, which that guard cannot see.
 *   - `eventEngine.processEngagement` — the `published` engagement.
 *   - `bustCachesForPosts`        — the `images-modelVersion:` / `images-model:`
 *                                   gallery busts. 🔴 NOT OPTIONAL: the native
 *                                   publish transition never calls it either —
 *                                   `addPostImage` does, at ATTACH time — so a
 *                                   path that adopts by `Image.update` instead of
 *                                   `addPostImage` skips it entirely and the post's
 *                                   images do not appear in the model gallery until
 *                                   some unrelated write busts the cache.
 *   - `images-user:` bust + `preventReplicationLag` + the post/image count caches
 *                                 + `queueImageSearchIndexUpdate`.
 *
 * ⚠️ WHAT DOES **NOT** FIRE, and is not an omission: `sendMessagesToCollaborators`
 * (an app post has no collaborators), collection-item creation (this path never
 * sets `collectionId`), `publishModel3D` (no `model3dId`), and the ClickHouse
 * `track.post` calls — those need the request-scoped tracker and are issued by
 * the ROUTER, which is where `ctx` lives.
 *
 * BEST-EFFORT BY CONSTRUCTION: the post is already committed when this runs, so
 * a failure here must never turn a successful publish into an error the block
 * sees. Each effect is awaited but the whole block is caught by the caller.
 */
export async function applyBlockPostPublishEffects(input: {
  postId: number;
  userId: number;
  imageIds: number[];
  modelVersionId: number | null;
  modelId: number | null;
  ip?: string;
}): Promise<void> {
  const { firstDailyPostReward, imagePostedToModelReward } = await import('~/server/rewards');
  const { eventEngine } = await import('~/server/events');
  const { preventReplicationLag } = await import('~/server/db/db-lag-helpers');
  const { userPostCountCache, userImageVideoCountCaches } = await import('~/server/redis/caches');
  const { bustCacheTag } = await import('~/server/utils/cache-helpers');
  const { bustCachesForPosts } = await import('~/server/services/post.service');
  const { queueImageSearchIndexUpdate } = await import('~/server/services/image.service');
  const { SearchIndexUpdateQueueAction } = await import('~/server/common/enums');

  await preventReplicationLag('post', input.postId);
  await preventReplicationLag('postImages', input.postId);
  await userPostCountCache.refresh(input.userId);
  await userImageVideoCountCaches.refresh(input.userId);
  await bustCacheTag(`images-user:${input.userId}`);
  await bustCachesForPosts(input.postId);
  if (input.imageIds.length > 0) {
    await queueImageSearchIndexUpdate({
      ids: input.imageIds,
      action: SearchIndexUpdateQueueAction.Update,
    });
  }

  await firstDailyPostReward.apply(
    { postId: input.postId, posterId: input.userId },
    { ip: input.ip }
  );
  if (input.modelVersionId != null) {
    await imagePostedToModelReward.apply(
      {
        modelId: input.modelId ?? undefined,
        modelVersionId: input.modelVersionId,
        posterId: input.userId,
      },
      { ip: input.ip }
    );
  }
  await eventEngine.processEngagement({
    userId: input.userId,
    type: 'published',
    entityType: 'post',
    entityId: input.postId,
  });
}
