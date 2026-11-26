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
 * AUDIT. A successful submit is recorded on the update row (`submitted_publish_request_id`,
 * `submitted_by_user_id`, `submitted_at`) and logged. The update stays `pending`: the owner's own
 * checkout still has to merge it, or their next submit would ship without it.
 *
 * 🔴 Dark until migrations `20271205140000_app_platform_updates` and
 * `20271206120000_app_platform_update_submissions` are applied by hand AND the
 * `app-blocks-platform-updates` flag is on (checked at the router).
 */

import { TRPCError } from '@trpc/server';
import JSZip from 'jszip';
import { dbRead, dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { isMissingTableError } from '~/server/services/blocks/app-access.service';
import { isMissingColumnError } from '~/server/services/blocks/app-listing-source-repo.service';
import {
  MANIFEST_PATH,
  OWNER_PENDING_REFUSAL,
  OnBehalfPlanError,
  STAFF_PENDING_REFUSAL,
  onBehalfVersion,
  planOnBehalfFiles,
  withManifestVersion,
} from '~/server/services/blocks/app-platform-update-submit.plan';
import { readRows, resolveApp } from '~/server/services/blocks/app-platform-update.service';
import { treeFromMap } from '~/server/services/blocks/app-source-repo.plan';
import { FORGEJO_SOURCE_ORG } from '~/server/services/blocks/forgejo-orgs';
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
  const pending = await dbWrite.appBlockPublishRequest.findFirst({
    where: { slug, status: 'pending' },
    select: { id: true, fileSummary: true },
  });
  if (!pending) return null;
  const onBehalf =
    pending.fileSummary &&
    typeof pending.fileSummary === 'object' &&
    (pending.fileSummary as { onBehalf?: unknown }).onBehalf;
  return new TRPCError({
    code: 'CONFLICT',
    message: onBehalf ? STAFF_PENDING_REFUSAL : OWNER_PENDING_REFUSAL,
  });
}

/** The publish request this update was last submitted as; `undefined` when the columns are missing. */
async function submittedRequestId(updateId: string): Promise<string | null | undefined> {
  try {
    const rows = (await dbWrite.$queryRaw`SELECT "submitted_publish_request_id" AS "id"
        FROM "app_platform_updates" WHERE "id" = ${updateId}`) as Array<{ id: string | null }>;
    return rows[0]?.id ?? null;
  } catch (err) {
    if (isMissingColumnError(err) || isMissingTableError(err)) return undefined;
    throw err;
  }
}

/** The bytes of `paths` in the source repo at `ref`, and the whole tree there. */
async function sourceFilesAt(slug: string, ref: string, paths: readonly string[]) {
  const forgejo = await import('~/server/services/blocks/forgejo.service');
  const tree = await forgejo.listRepoTreeAtRef(slug, ref, FORGEJO_SOURCE_ORG);
  const files = new Map<string, Buffer>();
  for (const path of paths) {
    const sha = tree.get(path);
    if (sha) files.set(path, await forgejo.getBlobContent(slug, sha, FORGEJO_SOURCE_ORG));
  }
  return { tree: treeFromMap(tree), files };
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

  const rows = await readRows({ kind: 'id', id: args.id }, dbWrite);
  if (rows === null) throw unavailable();
  const update = rows[0];
  if (!update) throw new TRPCError({ code: 'NOT_FOUND', message: 'Update not found' });
  if (update.status === 'superseded')
    throw new TRPCError({ code: 'CONFLICT', message: 'This update was withdrawn' });

  const previous = await submittedRequestId(update.id);
  if (previous === undefined) throw unavailable();
  if (previous) {
    const prior = await dbWrite.appBlockPublishRequest.findUnique({
      where: { id: previous },
      select: { status: true },
    });
    if (prior && (prior.status === 'pending' || prior.status === 'approved'))
      throw new TRPCError({
        code: 'CONFLICT',
        message: `This update was already submitted (${previous}, ${prior.status})`,
      });
  }

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
  const approvedList = await getPreviousApprovedFiles(app.slug);
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
    const approvedVersions = (
      await dbRead.appBlockPublishRequest.findMany({
        where: { slug: app.slug, status: 'approved' },
        select: { version: true },
      })
    ).map((r) => r.version);
    let manifestVersion: unknown;
    try {
      manifestVersion = (JSON.parse(manifestFile.toString('utf8')) as { version?: unknown })
        .version;
    } catch {
      manifestVersion = null;
    }
    version = onBehalfVersion(manifestVersion, approvedVersions);
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

  try {
    await dbWrite.$executeRaw`UPDATE "app_platform_updates"
        SET "submitted_publish_request_id" = ${submitted.publishRequestId},
            "submitted_by_user_id" = ${args.staffUserId},
            "submitted_at" = now(), "updated_at" = now()
      WHERE "id" = ${update.id}`;
  } catch (err) {
    // The request is filed and names the update itself (`fileSummary.onBehalf`); only the
    // update-side link is lost.
    log('error', 'submit recorded on the request but not on the update', {
      updateId: update.id,
      publishRequestId: submitted.publishRequestId,
      error: err instanceof Error ? err.message : String(err),
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
