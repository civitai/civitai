import { TRPCError } from '@trpc/server';
import { dbWrite } from '~/server/db/client';
import { logToAxiom, safeError } from '~/server/logging/client';
import type { ImageSchema } from '~/server/schema/image.schema';
import { createImage } from '~/server/services/image.service';
import { checkFileExists, getImageUploadBackend } from '~/utils/s3-utils';

/**
 * Shared resolution of an entity's cover image ("give me the `Image.id` to store").
 *
 * ## Why this exists
 *
 * The delete side of the image lifecycle is url-aware and refcounted:
 * `deleteImageFromS3` looks up every other `Image` row sharing the same `url` before it
 * removes the underlying object. The create side was url-BLIND: every cover call site did
 * `coverImage.id ?? createImage({ ...coverImage, userId })`, i.e. a bare row insert with no
 * check that the object the row points at still exists.
 *
 * That asymmetry is a bug with a live symptom. A cover upload hands the client a bare object
 * key with NO `Image.id` yet; some editors persist that draft client-side with no expiry, so a
 * long-abandoned draft can be replayed weeks later. By then the object may be gone (its
 * original row was deleted, taking the object with it), and the replay happily minted a fresh
 * `Image` row pointing at nothing — a permanent 404 for every reader, with no error shown to
 * the person who caused it.
 *
 * ## What this does
 *
 * - `id` present  → the caller's own ownership rule runs (unchanged per call site) and we
 *   return it. 🔴 No url lookup and no bucket round-trip: this is the overwhelmingly common
 *   path and must stay free.
 * - `id` absent   → (a) reuse an existing, safely-reusable `Image` row for the same url, else
 *   (b) verify the object is actually in the uploads bucket before inserting a row, and reject
 *   with an actionable message when it definitively is not.
 *
 * ## What this deliberately does NOT do
 *
 * It does not decide ownership. Each call site keeps its own rule (article: skip when the cover
 * is unchanged, else `isImageOwner`; user challenges: must own the row; moderator paths: no
 * check) and passes it in as `assertOwnership`. Centralising those would be a behaviour change
 * well beyond the bug.
 */

/** Shown to the user when the uploaded object is definitively gone. Keep it actionable. */
export const COVER_IMAGE_UNAVAILABLE_MESSAGE =
  'This cover image is no longer available. Please re-upload it.';

/**
 * The subset of an `Image` row needed to decide whether it can be safely re-pointed at a new
 * entity. Attachment counts come from the relation `_count`s.
 */
export type ReusableCoverImageCandidate = {
  id: number;
  postId: number | null;
  /** `Article.coverId` is `@unique` — a row already covering an article cannot cover another. */
  article: { id: number } | null;
  _count: {
    connections: number;
    challengesCover: number;
    challengeEventCovers: number;
  };
};

/**
 * Can this existing row be handed to a (possibly different) entity as its cover?
 *
 * 🔴 Reuse is NOT free, which is why this predicate is narrow. Two concrete hazards:
 *
 *  1. `Article.coverId` carries a UNIQUE constraint. Re-using a row that already covers some
 *     other article would fail the write outright.
 *  2. Cover images are owned by their entity: deleting an article deletes its cover `Image`
 *     row. Sharing one row across two entities therefore lets deleting one break the other —
 *     trading the bug being fixed here for a different broken image.
 *
 * So a row is reusable only when it is either (a) the entity's CURRENT cover — trivially safe,
 * it is already exactly this pointer — or (b) unattached as far as the FIVE relations checked
 * below are concerned: `postId`, `article`, `connections`, `challengesCover`,
 * `challengeEventCovers`.
 *
 * 🔴 That list is PARTIAL, not exhaustive. `Image` carries many more relations than these —
 * profile pictures, club covers, collection items, comic panels, app-listing assets, challenge
 * wins, … — and a row attached only through one of those will still be accepted here. The five
 * are the ones a cover-image reuse can actually collide with today; treat the predicate as
 * "not attached to anything a cover can conflict with", NOT as "attached to nothing at all".
 * Anyone extending cover reuse to a new surface must widen this list deliberately.
 */
export function isReusableCoverImage(
  candidate: ReusableCoverImageCandidate,
  currentCoverId?: number | null
) {
  if (currentCoverId != null && candidate.id === currentCoverId) return true;

  return (
    candidate.postId == null &&
    candidate.article == null &&
    candidate._count.connections === 0 &&
    candidate._count.challengesCover === 0 &&
    candidate._count.challengeEventCovers === 0
  );
}

export type CoverImageDeps = {
  /**
   * An existing row for this url that is safe to reuse, or `null`. Scoped to `userId` by the
   * production implementation — see the note there.
   */
  findReusableImageId: (args: {
    url: string;
    userId: number;
    currentCoverId?: number | null;
  }) => Promise<number | null>;
  /** `true` present · `false` definitively absent · `null` bucket could not be consulted. */
  objectExists: (url: string) => Promise<boolean | null>;
  createImage: (args: ImageSchema & { userId: number }) => Promise<{ id: number }>;
  /**
   * Called when the existence check came back indeterminate and we therefore proceeded
   * unverified. Must not throw and must not block — it exists purely to make the fail-open
   * no-op measurable.
   */
  logExistenceUnknown: (args: { userId: number }) => void;
};

/** Reused rows must belong to the caller — see `findReusableImageId` below for why. */
async function findReusableImageId({
  url,
  userId,
  currentCoverId,
}: {
  url: string;
  userId: number;
  currentCoverId?: number | null;
}) {
  // An equality probe over a handful of rows — the same object key is only ever shared by
  // re-saves of the same upload, and the result is capped at 5.
  //
  // 🔴 This lookup relies on an index on `Image.url` that is NOT declared in the Prisma schema
  // and is created in no migration in this repo, so it must not be assumed present in a fresh
  // or local database. On a database without it this is a sequential scan of `Image`; keep that
  // in mind before adding a call site on a hotter path than "the user saved a cover with no id".
  //
  // 🔴 Scoped to `userId` on purpose. `Image.url` is the bare object key and it is visible in
  // every public image URL, so an unscoped url→row reuse would let anyone attach somebody
  // else's (possibly unpublished, blocked or moderated) image as their own cover just by
  // reading a key off the site. Scoping to the caller keeps the outcome identical to what
  // `createImage` would have produced — a row owned by the caller — minus the duplicate.
  const candidates = await dbWrite.image.findMany({
    where: { url, userId },
    select: {
      id: true,
      postId: true,
      article: { select: { id: true } },
      _count: { select: { connections: true, challengesCover: true, challengeEventCovers: true } },
    },
    orderBy: { id: 'desc' },
    take: 5,
  });

  return (
    candidates.find((c: ReusableCoverImageCandidate) => isReusableCoverImage(c, currentCoverId))
      ?.id ?? null
  );
}

/**
 * How long the existence probe may take before we give up and treat the answer as unknown.
 *
 * 🔴 This runs on the user-facing save path. The uploads client is built with SDK-default
 * retries and no request timeout, so without a bound a degraded backend turns a
 * bounded-latency guard into an unbounded one — the save just hangs. 2s matches the
 * `AbortSignal.timeout(2000)` already used for the best-effort image-cacher invalidation in
 * `image.service`. Timing out is an "unknown", never an "absent": it falls through to the
 * same fail-open path as any other unreachable-bucket outcome.
 */
export const COVER_IMAGE_EXISTS_TIMEOUT_MS = 2000;

/** Structured-log name for both indeterminate branches. Query this to measure the no-op. */
export const COVER_IMAGE_EXISTS_UNKNOWN_LOG = 'cover-image-exists-unknown';

async function objectExistsInUploads(url: string): Promise<boolean | null> {
  try {
    const { s3, bucket } = await getImageUploadBackend();
    return await checkFileExists(url, {
      s3,
      bucket,
      abortSignal: AbortSignal.timeout(COVER_IMAGE_EXISTS_TIMEOUT_MS),
    });
  } catch (e) {
    // Credentials absent (local/dev) or the client could not even be constructed. Unknown, not
    // absent — see the fail-open note in `resolveCoverImageId`.
    //
    // 🔴 Logged because failing open is SILENT by construction: a period in which this check is
    // doing nothing is otherwise indistinguishable from "working fine, no bad drafts". `reason`
    // separates this branch (could not build the client) from the one inside `checkFileExists`
    // (the bucket was consulted and did not give a definitive answer).
    logToAxiom({
      type: 'warning',
      name: COVER_IMAGE_EXISTS_UNKNOWN_LOG,
      message: 'cover image existence check could not consult the uploads bucket',
      reason: 'client-unavailable',
      error: safeError(e),
    }).catch(() => {
      // swallow — best-effort logging must never break the save it is observing
    });
    return null;
  }
}

function logExistenceUnknown({ userId }: { userId: number }) {
  logToAxiom({
    type: 'warning',
    name: COVER_IMAGE_EXISTS_UNKNOWN_LOG,
    message: 'cover image created without a verified object — existence check was indeterminate',
    reason: 'proceeded-unverified',
    userId,
  }).catch(() => {
    // swallow — best-effort logging must never break the save it is observing
  });
}

export const productionCoverImageDeps: CoverImageDeps = {
  findReusableImageId,
  objectExists: objectExistsInUploads,
  logExistenceUnknown,
  // 🔴 Wrapped, not referenced directly. Reading `createImage` here would read it at MODULE
  // LOAD, and this module is now in the import graph of the article + challenge services —
  // so every existing test that wholesale-`vi.mock`s `image.service` without re-stubbing
  // `createImage` would fail to even import ("No 'createImage' export is defined on the mock"),
  // taking the whole test file down. Deferring the read to call time keeps those suites intact.
  createImage: (args) => createImage(args),
};

export async function resolveCoverImageId(
  {
    coverImage,
    userId,
    currentCoverId,
    assertOwnership,
  }: {
    coverImage: ImageSchema;
    userId: number;
    /** The entity's existing `coverId`, when the caller already has it loaded. */
    currentCoverId?: number | null;
    /** The call site's own ownership rule for an `id` the client supplied. Must throw to deny. */
    assertOwnership?: (id: number) => Promise<void>;
  },
  deps: CoverImageDeps = productionCoverImageDeps
): Promise<number> {
  const { id, ...image } = coverImage;

  // Hot path: the client round-tripped a real row. Ownership is the caller's business; nothing
  // here should cost a url lookup or a bucket round-trip.
  if (id != null) {
    await assertOwnership?.(id);
    return id;
  }

  const reusableId = await deps.findReusableImageId({ url: image.url, userId, currentCoverId });
  if (reusableId != null) return reusableId;

  const exists = await deps.objectExists(image.url);
  // 🔴 Only a DEFINITIVE `false` rejects. `null` means the bucket could not be consulted, and
  // failing closed there would break every upload the moment credentials rotate or the network
  // blips — an infrastructure hiccup must not look like a bad request to the user.
  if (exists === false) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: COVER_IMAGE_UNAVAILABLE_MESSAGE });
  }

  if (exists === null) {
    // 🔴 The fail-open branch is a SILENT no-op by construction: while it is taken, this whole
    // guard is off, and "the check found nothing bad" looks identical to "the check did not
    // run". Emit it so the difference is measurable — a sustained rate here means covers are
    // being minted unverified again, which is precisely the pre-fix behaviour.
    //
    // Deliberately no url/key and no image fields: the decision is what needs counting, and the
    // object key is the one piece of the payload worth not scattering through the log stream.
    deps.logExistenceUnknown({ userId });
  }

  const created = await deps.createImage({ ...image, userId });
  return created.id;
}
