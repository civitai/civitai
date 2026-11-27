/**
 * Staff ON-BEHALF SUBMIT of a platform update: a moderator files a new version of someone else's
 * app for the normal moderator review, built from the app's approved version with a recorded
 * platform update (`app-platform-update.service.ts`) applied. The pure half (the bundle, the
 * version, the refusal copy) is `app-platform-update-submit.plan.ts`.
 *
 * WHO SUBMITS. The publish request is filed through `submitVersion`, the ordinary submit path, with
 * the MODERATOR as its submitter (`submittedByUserId`), never the owner. `fileSummary.onBehalf`
 * names the update and the owner, and the review UI shows "submitted by <staff> for <owner>".
 *
 * NEVER DISPLACES THE OWNER. The database allows one pending publish request per app
 * (`app_block_publish_requests_one_pending_per_slug`). When one exists, the submit is refused and
 * that request is left exactly as it was: the update stays on its branch and reaches the app
 * through the owner's next submit. Nothing here withdraws or edits a publish request.
 *
 * AUDIT. The publish request itself is the record of the submit: `fileSummary.onBehalf` names the
 * update, and `submittedByUserId` / `createdAt` say who and when. "Already submitted" is read from
 * there ({@link activeSubmission}). A successful submit is also logged.
 *
 * THE UPDATE'S STATUS. A submit leaves it `pending`: the owner's own checkout still has to merge
 * it, or their next submit would ship without it. If the review REJECTS the on-behalf request,
 * `rejectRequest` withdraws the update (`superseded`, by the rejecting moderator), so it is no
 * longer offered to the owner's checkout. An approve leaves it as it is.
 *
 * 🔴 Dark until migration `20271205140000_app_platform_updates` is applied by hand AND the
 * `app-blocks-platform-updates` flag is on (checked at the router).
 */

import { TRPCError } from '@trpc/server';
import JSZip from 'jszip';
import { dbRead, dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import {
  OWNER_PENDING_REFUSAL,
  OnBehalfPlanError,
  STAFF_PENDING_REFUSAL,
  assertAboveApproved,
  onBehalfVersion,
  planOnBehalfFiles,
  withManifestVersion,
} from '~/server/services/blocks/app-platform-update-submit.plan';
import { readRows, resolveApp } from '~/server/services/blocks/app-platform-update.service';
import { MANIFEST_PATH, treeFromMap } from '~/server/services/blocks/app-source-repo.plan';
import { FORGEJO_SOURCE_ORG } from '~/server/services/blocks/forgejo-orgs';
import { Limiter } from '~/server/utils/concurrency-helpers';
import { hasOnBehalfRecord } from '~/shared/utils/publish-request-on-behalf';
import type {
  SubmitVersionParams,
  SubmitVersionResult,
} from '~/server/services/blocks/publish-request.service';

const log = (type: 'info' | 'warning' | 'error', message: string, data: Record<string, unknown>) =>
  logToAxiom({ name: 'app-platform-update', type, message, ...data }, 'webhooks');

const unavailable = () =>
  new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Platform updates are not available' });

export type SubmitOnBehalfDeps = {
  /** `submitVersion`; passed in so its storage-heavy pipeline is not run by this module's tests. */
  submitVersion: (
    params: SubmitVersionParams
  ) => Promise<Pick<SubmitVersionResult, 'publishRequestId' | 'version'>>;
};

const defaultDeps: SubmitOnBehalfDeps = {
  submitVersion: async (params) =>
    (await import('~/server/services/blocks/publish-request.service')).submitVersion(params),
};

export type SubmitOnBehalfResult = {
  updateId: string;
  slug: string;
  publishRequestId: string;
  version: string;
};

/**
 * The pending publish request for `slug` as a refusal, or `null` when there is none. Read on the
 * primary: the owner may have submitted a moment ago.
 */
async function pendingRefusal(slug: string): Promise<TRPCError | null> {
  // primary: guards the submit below; the owner may have submitted a moment ago.
  const pending = await dbWrite.appBlockPublishRequest.findFirst({
    where: { slug, status: 'pending' },
    select: { id: true, fileSummary: true },
  });
  if (!pending) return null;
  return new TRPCError({
    code: 'CONFLICT',
    message: hasOnBehalfRecord(pending.fileSummary) ? STAFF_PENDING_REFUSAL : OWNER_PENDING_REFUSAL,
  });
}

/**
 * The newest on-behalf publish request filed for the update that is still pending or was
 * approved, or `null`. A rejected or withdrawn one does not count: the update may be submitted
 * again. Read on the primary: the last submit may have been a moment ago. Scoped to the update's
 * app, so the JSON filter runs over that app's requests only.
 */
async function activeSubmission(update: {
  id: string;
  appBlockId: string;
}): Promise<{ id: string; status: string } | null> {
  // primary: guards the submit below; a request filed a moment ago may not be on the replica.
  return dbWrite.appBlockPublishRequest.findFirst({
    where: {
      appBlockId: update.appBlockId,
      status: { in: ['pending', 'approved'] },
      fileSummary: { path: ['onBehalf', 'platformUpdateId'], equals: update.id },
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true, status: true },
  });
}

/** Blob reads one submit runs at once. */
const BLOB_READ_CONCURRENCY = 5;

/** The bytes of `paths` in the source repo at `ref`, and the whole tree there. */
async function sourceFilesAt(slug: string, ref: string, paths: readonly string[]) {
  const forgejo = await import('~/server/services/blocks/forgejo.service');
  const tree = await forgejo.listRepoTreeAtRef(slug, ref, FORGEJO_SOURCE_ORG);
  const present = paths.flatMap((path) => {
    const sha = tree.get(path);
    return sha ? [{ path, sha }] : [];
  });
  // One blob per task; `process` flattens each task's array of entries into one list.
  const read = await Limiter({ limit: BLOB_READ_CONCURRENCY, batchSize: 1 }).process(
    present,
    (batch) =>
      Promise.all(
        batch.map(
          async ({ path, sha }) =>
            [path, await forgejo.getBlobContent(slug, sha, FORGEJO_SOURCE_ORG)] as const
        )
      )
  );
  return { tree: treeFromMap(tree), files: new Map<string, Buffer>(read) };
}

/** A ZIP of `files`, deterministic (sorted, zeroed timestamps), as the bundle reconstruct builds. */
async function zipOf(files: ReadonlyMap<string, Buffer>): Promise<Buffer> {
  const zip = new JSZip();
  for (const path of [...files.keys()].sort())
    zip.file(path, files.get(path)!, { date: new Date(0) });
  return Buffer.from(await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
}

/**
 * Submit the app's approved version with platform update `id` applied, for review, on the owner's
 * behalf. Refuses: an account that is not a moderator (re-checked in the database); an unknown or
 * withdrawn update; one already submitted and still pending or approved; an app with a pending
 * publish request; an update that does not apply to the approved version.
 */
export async function submitPlatformUpdateOnBehalf(
  args: { staffUserId: number; id: string },
  deps: SubmitOnBehalfDeps = defaultDeps
): Promise<SubmitOnBehalfResult> {
  const staff = await dbRead.user.findUnique({
    where: { id: args.staffUserId },
    select: { username: true, isModerator: true },
  });
  if (!staff?.isModerator)
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Only Civitai staff can submit updates' });

  // primary: guards the submit below; an update pushed a moment ago may not be on the replica.
  const rows = await readRows({ kind: 'id', id: args.id }, dbWrite);
  if (rows === null) throw unavailable();
  const update = rows[0];
  if (!update) throw new TRPCError({ code: 'NOT_FOUND', message: 'Update not found' });
  if (update.status === 'superseded')
    throw new TRPCError({ code: 'CONFLICT', message: 'This update was withdrawn' });

  const prior = await activeSubmission(update);
  if (prior)
    throw new TRPCError({
      code: 'CONFLICT',
      message: `This update was already submitted (${prior.id}, ${prior.status})`,
    });

  const app = await resolveApp({ appBlockId: update.appBlockId });
  if (!app || typeof app.ownerUserId !== 'number')
    throw new TRPCError({ code: 'NOT_FOUND', message: 'App not found' });
  const ownerUserId = app.ownerUserId;

  // Before any read of the build: the owner's pending request wins, and is left untouched.
  const refusal = await pendingRefusal(app.slug);
  if (refusal) throw refusal;

  const { getPreviousApprovedFiles } = await import(
    '~/server/services/blocks/publish-request.service'
  );
  // primary: the build this submit replaces. A version approved a moment ago may not be on the
  // replica yet, and building on the one before it would roll the app back.
  const approvedList = await getPreviousApprovedFiles(app.slug, undefined, dbWrite);
  if (!approvedList)
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'The app has no approved version to submit an update to',
    });
  const approved = new Map(approvedList.map((f) => [f.path, f.content]));

  const paths = Array.isArray(update.paths) ? update.paths : [];
  const [base, head] = await Promise.all([
    sourceFilesAt(app.slug, update.baseCommitSha, []),
    sourceFilesAt(
      app.slug,
      update.commitSha,
      paths.filter((p) => p.operation !== 'delete').map((p) => p.path)
    ),
  ]);

  let bundleBuffer: Buffer;
  let version: string;
  try {
    const files = planOnBehalfFiles({
      approved,
      baseTree: base.tree,
      paths,
      updateFiles: head.files,
    });
    const manifestFile = files.get(MANIFEST_PATH);
    if (!manifestFile) throw new OnBehalfPlanError(`The approved version has no ${MANIFEST_PATH}`);
    // primary: the version must be above every approved one, even one approved a moment ago.
    const approvedRows = await dbWrite.appBlockPublishRequest.findMany({
      where: { slug: app.slug, status: 'approved' },
      select: { version: true },
    });
    const approvedVersions = approvedRows.map((r) => r.version);
    let manifestVersion: unknown;
    try {
      manifestVersion = (JSON.parse(manifestFile.toString('utf8')) as { version?: unknown })
        .version;
    } catch {
      manifestVersion = null;
    }
    version = onBehalfVersion(manifestVersion, approvedVersions);
    assertAboveApproved(version, approvedVersions);
    files.set(MANIFEST_PATH, withManifestVersion(manifestFile, version));
    bundleBuffer = await zipOf(files);
  } catch (err) {
    if (err instanceof OnBehalfPlanError)
      throw new TRPCError({ code: 'CONFLICT', message: err.message, cause: err });
    throw err;
  }

  const owner = await dbRead.user.findUnique({
    where: { id: ownerUserId },
    select: { username: true },
  });

  let submitted: Pick<SubmitVersionResult, 'publishRequestId' | 'version'>;
  try {
    submitted = await deps.submitVersion({
      bundleBuffer,
      submittedByUserId: args.staffUserId,
      submitterIsModerator: true,
      // Never refused for the app's other unshipped updates (its bundle lacks them by
      // construction); recorded via `on-behalf` instead. `onBehalf` keeps its approve from
      // marking anything shipped.
      submittedOnBehalf: true,
      onBehalf: {
        platformUpdateId: update.id,
        staffUsername: staff.username ?? null,
        ownerUserId,
        ownerUsername: owner?.username ?? null,
      },
    });
  } catch (err) {
    // The owner submitted between the check above and the insert: theirs stands, and says so.
    const raced = await pendingRefusal(app.slug);
    if (raced) throw raced;
    if (err instanceof TRPCError) throw err;
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: err instanceof Error ? err.message : String(err),
      cause: err,
    });
  }

  log('info', 'submitted on behalf', {
    updateId: update.id,
    slug: app.slug,
    publishRequestId: submitted.publishRequestId,
    version: submitted.version,
    staffUserId: args.staffUserId,
    ownerUserId,
  });

  // Best-effort and after the request: an outage costs the notification, never the submit.
  try {
    const [{ createNotification }, { NotificationCategory }] = await Promise.all([
      import('~/server/services/notification.service'),
      import('~/server/common/enums'),
    ]);
    await createNotification({
      userId: ownerUserId,
      category: NotificationCategory.System,
      type: 'app-platform-update-submitted',
      key: `app-platform-update-submitted:${submitted.publishRequestId}`,
      details: {
        slug: app.slug,
        updateId: update.id,
        publishRequestId: submitted.publishRequestId,
        version: submitted.version,
        byUsername: staff.username ?? 'Civitai staff',
        reason: update.reason,
      },
    });
  } catch (err) {
    log('warning', 'owner notification failed', {
      updateId: update.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return {
    updateId: update.id,
    slug: app.slug,
    publishRequestId: submitted.publishRequestId,
    version: submitted.version,
  };
}
