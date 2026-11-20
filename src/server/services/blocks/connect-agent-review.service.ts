import { createHash } from 'crypto';
import JSZip from 'jszip';
import {
  buildConnectReviewInput,
  commitShaFromArchiveUrl,
  connectServerFacts,
  connectSourceArchiveUrl,
  CONNECT_REVIEW_INPUT_FILE,
  CONNECT_REVIEW_SOURCE_FILE,
  CONNECT_REVIEW_VERSION,
  type ConnectReviewSubject,
  type ConnectServerFacts,
  type ConnectSourceResult,
} from './connect-agent-review.logic';

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
export const CONNECT_SOURCE_TIMEOUT_MS = 30_000;

type ArchiveFetcher = (
  url: string,
  opts: {
    timeoutMs: number;
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
      timeoutMs: CONNECT_SOURCE_TIMEOUT_MS,
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
  if (!request) throw new Error(`listing publish request ${publishRequestId} not found`);
  if (request.status !== 'pending') {
    throw new Error(
      `listing publish request ${publishRequestId} is not pending (status=${request.status})`
    );
  }
  const listing = request.appListing;
  if (!listing || listing.kind !== 'offsite' || !listing.connectClient) {
    throw new Error(
      `listing publish request ${publishRequestId} is not an OAuth-connect listing; only those are reviewed`
    );
  }
  // `source_repo_url` is a manual-apply column: read through the helper that degrades to null.
  const { readListingSourceRepoUrl } = await import('./app-listing-source-repo.service');
  const repo = await readListingSourceRepoUrl(listing.id, dbRead);
  const justifications = listing.connectScopeJustifications;
  return {
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
}

export type PreparedConnectReview = {
  slug: string;
  version: string;
  bundleSha256: string;
  bundleObjectKey: string;
  oauthClientId: string;
  facts: ConnectServerFacts;
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
    facts: connectServerFacts(subject, result),
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
