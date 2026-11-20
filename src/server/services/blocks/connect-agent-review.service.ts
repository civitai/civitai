import { createHash } from 'crypto';
import JSZip from 'jszip';
import {
  buildConnectReviewInput,
  commitShaFromArchiveUrl,
  connectCivitaiChecks,
  connectListingFingerprint,
  connectSourceArchiveUrl,
  CONNECT_REVIEW_INPUT_FILE,
  CONNECT_REVIEW_SOURCE_FILE,
  CONNECT_REVIEW_VERSION,
  type ConnectReviewSubject,
} from './connect-agent-review.logic';
import type {
  ConnectCivitaiChecks,
  ConnectCivitaiChecksView,
  ConnectSourceResult,
} from '~/shared/constants/connect-agent-review.constants';

/**
 * AGENT REVIEW, CONNECT LANE: load the listing request and stage what the runner reads.
 *
 * `startAgentReview` (agent-review.service) is the one dispatcher for both lanes; this file only
 * supplies the connect lane's subject. The runner pulls ONE presigned ZIP, as on-site: here it
 * holds `connect-review.json` (the listing, its OAuth client's public settings, the requested
 * scopes and the offline-access posture) and, when the author links public server source that
 * could be fetched, `source.zip`.
 *
 * The archive is nested, not extracted: unpacking an author-supplied ZIP on a web pod is a
 * decompression-bomb surface, and the review sandbox is where untrusted bytes belong.
 */

/** Cap on the fetched source archive. Bigger repos are reported as "linked, not fetched". */
export const CONNECT_SOURCE_MAX_BYTES = 25 * 1024 * 1024;
/** ONE deadline for the whole source fetch: every hop and the body read, together. */
export const CONNECT_SOURCE_DEADLINE_MS = 30_000;

type ArchiveFetcher = (
  url: string,
  opts: {
    timeoutMs: number;
    deadlineMs: number;
    maxBytes: number;
    allowedContentTypes: readonly string[];
    maxRedirects: number;
    allowUrl: (u: URL) => boolean;
  }
) => Promise<{ finalUrl: string; bytes: Buffer }>;

/**
 * Fetch the linked source archive through `safeFetch` (SSRF-hardened, size- and time-capped), with
 * every redirect hop held to the forge's own hosts. Never throws: a failure is a result the report
 * states plainly.
 */
export async function fetchConnectSource(
  repoUrl: string | null,
  fetcher?: ArchiveFetcher
): Promise<{ result: ConnectSourceResult; archive: Buffer | null }> {
  if (!repoUrl) return { result: { provided: false }, archive: null };
  const target = connectSourceArchiveUrl(repoUrl);
  if (!target) {
    return {
      result: {
        provided: true,
        repoUrl,
        fetched: false,
        reason: 'source from this host is not fetched automatically',
      },
      archive: null,
    };
  }
  try {
    const doFetch: ArchiveFetcher =
      fetcher ?? (await import('~/server/utils/safe-fetch')).safeFetch;
    const res = await doFetch(target.url, {
      timeoutMs: CONNECT_SOURCE_DEADLINE_MS,
      deadlineMs: CONNECT_SOURCE_DEADLINE_MS,
      maxBytes: CONNECT_SOURCE_MAX_BYTES,
      allowedContentTypes: [
        'application/zip',
        'application/x-zip-compressed',
        'application/octet-stream',
      ],
      maxRedirects: 2,
      allowUrl: (u) => target.hosts.includes(u.hostname.toLowerCase()),
    });
    return {
      result: {
        provided: true,
        repoUrl,
        fetched: true,
        archiveSha256: createHash('sha256').update(res.bytes).digest('hex'),
        commitSha: commitShaFromArchiveUrl(res.finalUrl),
        bytes: res.bytes.length,
      },
      archive: res.bytes,
    };
  } catch (err) {
    const code = (err as { code?: unknown })?.code;
    const reason =
      code === 'too_large'
        ? `the archive is larger than ${CONNECT_SOURCE_MAX_BYTES / (1024 * 1024)} MB`
        : code === 'bad_status'
        ? 'the host did not return an archive (is the repository public?)'
        : code === 'timeout'
        ? 'the download timed out'
        : 'the download failed';
    return { result: { provided: true, repoUrl, fetched: false, reason }, archive: null };
  }
}

/** Load a PENDING OAuth-connect listing request, or throw naming why it cannot be reviewed. */
export async function loadConnectReviewSubject(
  publishRequestId: string
): Promise<ConnectReviewSubject> {
  const read = await readConnectRequest(publishRequestId);
  if (!read) throw new Error(`listing publish request ${publishRequestId} not found`);
  if (read.status !== 'pending') {
    throw new Error(
      `listing publish request ${publishRequestId} is not pending (status=${read.status})`
    );
  }
  if (!read.subject) {
    throw new Error(
      `listing publish request ${publishRequestId} is not an OAuth-connect listing; only those are reviewed`
    );
  }
  return read.subject;
}

/**
 * The request's status and, when it is an OAuth-connect listing, the subject as it is now. No
 * status check: the stale check reads it for decided requests too. `null` when the request is gone.
 */
export async function readConnectRequest(
  publishRequestId: string
): Promise<{ status: string; subject: ConnectReviewSubject | null } | null> {
  const { dbRead } = await import('~/server/db/client');
  const request = await dbRead.appListingPublishRequest.findUnique({
    where: { id: publishRequestId },
    select: {
      id: true,
      kind: true,
      slug: true,
      status: true,
      changelog: true,
      appListing: {
        select: {
          id: true,
          kind: true,
          name: true,
          tagline: true,
          description: true,
          category: true,
          externalUrl: true,
          contentRating: true,
          connectRequestedScopes: true,
          connectScopeJustifications: true,
          // The client SECRET is never selected: nothing here may reach the runner.
          connectClient: {
            select: {
              id: true,
              name: true,
              description: true,
              redirectUris: true,
              allowedOrigins: true,
              grants: true,
              isConfidential: true,
              isVerified: true,
            },
          },
        },
      },
    },
  });
  if (!request) return null;
  const listing = request.appListing;
  if (!listing || listing.kind !== 'offsite' || !listing.connectClient) {
    return { status: request.status, subject: null };
  }
  // `source_repo_url` is a manual-apply column: read through the helper that degrades to null.
  const { readListingSourceRepoUrl } = await import('./app-listing-source-repo.service');
  const repo = await readListingSourceRepoUrl(listing.id, dbRead);
  const justifications = listing.connectScopeJustifications;
  const subject: ConnectReviewSubject = {
    publishRequestId,
    slug: request.slug,
    changelog: request.changelog ?? null,
    listing: {
      id: listing.id,
      name: listing.name,
      tagline: listing.tagline ?? null,
      description: listing.description ?? null,
      category: listing.category ?? null,
      externalUrl: listing.externalUrl ?? null,
      sourceRepoUrl: repo.available ? repo.value : null,
      contentRating: listing.contentRating ?? null,
      requestedScopes: listing.connectRequestedScopes ?? null,
      scopeJustifications:
        justifications && typeof justifications === 'object' && !Array.isArray(justifications)
          ? (justifications as Record<string, string>)
          : null,
    },
    client: {
      id: listing.connectClient.id,
      name: listing.connectClient.name,
      description: listing.connectClient.description,
      redirectUris: listing.connectClient.redirectUris,
      allowedOrigins: listing.connectClient.allowedOrigins,
      grants: listing.connectClient.grants,
      isConfidential: listing.connectClient.isConfidential,
      isVerified: listing.connectClient.isVerified,
    },
  };
  return { status: request.status, subject };
}

export type PreparedConnectReview = {
  slug: string;
  version: string;
  bundleSha256: string;
  bundleObjectKey: string;
  oauthClientId: string;
  checks: ConnectCivitaiChecks;
  fingerprint: string;
};

/** Build the review ZIP for a loaded subject and stage it where the runner pulls from. */
export async function stageConnectReviewBundle(
  subject: ConnectReviewSubject,
  fetcher?: ArchiveFetcher
): Promise<PreparedConnectReview> {
  const { result, archive } = await fetchConnectSource(subject.listing.sourceRepoUrl, fetcher);
  const zip = new JSZip();
  // Fixed dates so the same inputs give the same bytes (and the same sha).
  zip.file(
    CONNECT_REVIEW_INPUT_FILE,
    JSON.stringify(buildConnectReviewInput(subject, result), null, 2),
    {
      date: new Date(0),
    }
  );
  if (archive) zip.file(CONNECT_REVIEW_SOURCE_FILE, archive, { date: new Date(0) });
  const buf = Buffer.from(await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
  const bundleSha256 = createHash('sha256').update(buf).digest('hex');
  const { agentReviewBundleKey, stageBundleObject } = await import('~/utils/bundle-s3');
  const bundleObjectKey = agentReviewBundleKey(subject.publishRequestId, bundleSha256);
  await stageBundleObject(bundleObjectKey, buf);
  return {
    slug: subject.slug,
    version: CONNECT_REVIEW_VERSION,
    bundleSha256,
    bundleObjectKey,
    oauthClientId: subject.client.id,
    checks: connectCivitaiChecks(subject, result),
    fingerprint: connectListingFingerprint(subject),
  };
}

/**
 * Whether the listing request is still pending, read on the PRIMARY: a moderator may have decided
 * it while a slow start was fetching source. The dispatch asks before and after inserting the
 * running row, and the callback asks before storing a report.
 */
export async function isConnectRequestStillPending(publishRequestId: string): Promise<boolean> {
  const { dbWrite } = await import('~/server/db/client');
  // primary: the decision this guards against is a write that may not have reached the replica.
  const row = await dbWrite.appListingPublishRequest.findFirst({
    where: { id: publishRequestId, status: 'pending' },
    select: { id: true },
  });
  return row != null;
}

/**
 * A review whose request was decided before it could run or report: mark any running row
 * `torn-down` (so nothing is stored into it) and delete the staged ZIP. Never throws.
 */
export async function abandonDecidedConnectReview(publishRequestId: string): Promise<void> {
  try {
    const { dbWrite } = await import('~/server/db/client');
    await dbWrite.appReviewAgentReport.updateMany({
      where: { publishRequestId, status: 'running' },
      data: {
        status: 'torn-down',
        completedAt: new Date(),
        summaryMd: 'The submission was decided before this review finished, so it was not stored.',
      },
    });
  } catch {
    // Best-effort; the stale-running sweep is the backstop for the row.
  }
  const { deleteStagedBundle } = await import('~/utils/bundle-s3');
  await deleteStagedBundle(publishRequestId);
}

/** Store the checks for a just-inserted connect report. Only the dispatch writes this table. */
export async function writeConnectChecks(args: {
  reportId: string;
  publishRequestId: string;
  checks: ConnectCivitaiChecks;
  fingerprint: string;
}): Promise<void> {
  const { dbWrite } = await import('~/server/db/client');
  await dbWrite.appReviewAgentReportCheck.create({
    data: {
      reportId: args.reportId,
      publishRequestId: args.publishRequestId,
      checks: args.checks,
      fingerprint: args.fingerprint,
    },
  });
}

/**
 * The "Checked by Civitai" view of a connect report: its stored checks, and whether the live
 * listing still has the fingerprint the review recorded. `null` when the report has no checks
 * row (or the table is not there yet). A listing that can no longer be read counts as changed.
 */
export async function getConnectChecksView(
  reportId: string,
  publishRequestId: string
): Promise<ConnectCivitaiChecksView | null> {
  const { dbRead } = await import('~/server/db/client');
  let row: { checks: unknown; fingerprint: string } | null;
  try {
    row = await dbRead.appReviewAgentReportCheck.findUnique({
      where: { reportId },
      select: { checks: true, fingerprint: true },
    });
  } catch {
    return null;
  }
  if (!row) return null;
  const live = await readConnectRequest(publishRequestId).catch(() => null);
  const liveFingerprint = live?.subject ? connectListingFingerprint(live.subject) : null;
  return {
    checks: row.checks as ConnectCivitaiChecks,
    stale: liveFingerprint !== row.fingerprint,
  };
}

/**
 * After an off-site request is approved, rejected or withdrawn: stop any agent review still
 * running for it, mark its row `torn-down` and delete its staged ZIP — the same teardown the
 * on-site decisions run. Cheap when no review ran (one indexed read). Never throws.
 */
export async function teardownConnectAgentReview(publishRequestId: string): Promise<void> {
  try {
    const { teardownAgentReviewForRequest } = await import('./publish-request.service');
    await teardownAgentReviewForRequest(publishRequestId);
  } catch {
    // Best-effort, like the on-site teardown: the decision has already landed.
  }
}
