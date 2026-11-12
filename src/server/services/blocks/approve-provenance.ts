/**
 * Provenance on the platform's approve commit and its version tag.
 *
 * Pure module (no env, Prisma or I/O), so the message and tag rules are table-tested without
 * the approve harness.
 *
 * An approve writes one snapshot commit into the app's platform repository. Its message carries
 * git trailers that map the snapshot back to what was reviewed and to the developer's own
 * source, and the approved commit gets an annotated `v<version>` tag.
 *
 * The trailer values come from three trust levels, and the keys say which:
 * - `Publish-Request`, `App-Version`: the platform's own record of the approval.
 * - `Pushed-Commit`: the commit a developer pushed to the platform repository, for a
 *   push-originated request. A fact the platform observed.
 * - `Source-Commit`, `Source-Dirty`, `Source-Repo`: what the SUBMITTING CLIENT reported. Never
 *   verified. `Source-Commit` is never filled from the pushed commit, so the two cannot be
 *   confused.
 */

/** Longest value a trailer may carry. Longer values are dropped rather than truncated. */
export const MAX_TRAILER_VALUE_LENGTH = 512;

// The subset of characters a trailer value may contain: printable ASCII without spaces. Every
// value written here is an id, a sha, a semver or a URL, none of which needs anything else, and
// excluding whitespace and control characters is what stops a value from starting a new line
// and forging another trailer.
const SAFE_TRAILER_VALUE = /^[\x21-\x7e]+$/;

const COMMIT_SHA = /^[0-9a-f]{40}$/;

// Semantic versioning 2.0.0, which the manifest's `version` must satisfy. Every string it
// accepts is a valid git tag name once prefixed with `v` (no `..`, `~`, `^`, `:`, `?`, `*`, `[`,
// `\`, space or control character; cannot end in `.lock` or `/`).
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

// The platform's own ids (ULIDs today). Anything else is not tagged.
const PUBLISH_REQUEST_ID = /^[0-9A-Za-z_-]{1,64}$/;

export type ApproveProvenanceInput = {
  publishRequestId: string;
  slug: string;
  version: string;
  /** Client-reported commit the bundle was built from (zip submit). Null/undefined = not reported. */
  sourceCommit?: string | null;
  /** Client-reported dirty flag. Null/undefined = unknown, which is NOT the same as false. */
  sourceDirty?: boolean | null;
  /** The manifest's `repository` field (a display link the developer wrote). */
  sourceRepo?: unknown;
  /** The developer's pushed commit, for a push-originated request only. */
  pushedCommit?: string | null;
};

/** A trailer value, or null when it must be omitted. */
export function safeTrailerValue(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (value.length === 0 || value.length > MAX_TRAILER_VALUE_LENGTH) return null;
  return SAFE_TRAILER_VALUE.test(value) ? value : null;
}

/** The trailers, in their fixed order. Exported for tests that assert the parsed set. */
export function approveTrailers(input: ApproveProvenanceInput): Array<[string, string]> {
  const trailers: Array<[string, string]> = [];
  const add = (key: string, value: unknown) => {
    const safe = safeTrailerValue(value);
    if (safe !== null) trailers.push([key, safe]);
  };
  add('Publish-Request', input.publishRequestId);
  add('App-Version', input.version);
  const pushed = input.pushedCommit;
  if (typeof pushed === 'string' && COMMIT_SHA.test(pushed)) add('Pushed-Commit', pushed);
  const source = input.sourceCommit;
  if (typeof source === 'string' && COMMIT_SHA.test(source)) {
    add('Source-Commit', source);
    // Dirty is meaningful only about a reported commit, and unknown is omitted, never `false`.
    if (typeof input.sourceDirty === 'boolean')
      add('Source-Dirty', input.sourceDirty ? 'true' : 'false');
  }
  if (typeof input.sourceRepo === 'string' && /^https:\/\//.test(input.sourceRepo))
    add('Source-Repo', input.sourceRepo);
  return trailers;
}

/**
 * The approve commit message: the subject the platform has always written, a blank line, then
 * the trailers. Control characters are stripped from the subject's interpolated parts so a
 * value can never end the subject line early (they are validated upstream; this is the floor).
 */
export function buildApproveCommitMessage(input: ApproveProvenanceInput): string {
  const oneLine = (v: string) =>
    Array.from(v)
      .filter((ch) => {
        const code = ch.charCodeAt(0);
        return code >= 0x20 && code !== 0x7f && code !== 0x2028 && code !== 0x2029;
      })
      .join('');
  const subject = `Approved publish request ${oneLine(input.publishRequestId)} — ${oneLine(
    input.slug
  )} v${oneLine(input.version)}`;
  const trailers = approveTrailers(input);
  if (trailers.length === 0) return subject;
  return `${subject}\n\n${trailers.map(([k, v]) => `${k}: ${v}`).join('\n')}\n`;
}

// One git trailer line as buildApproveCommitMessage writes it: `Key: value`, no spaces in the value.
const TRAILER_LINE = /^([A-Za-z0-9-]+): ([\x21-\x7e]+)$/;

/**
 * The publish request an approve commit's message names, or null when the message is not in the
 * shape buildApproveCommitMessage writes. The git-push webhook uses this to recognise the
 * platform's own approve commit (it also checks who pushed it: a message alone is text anyone with
 * write access can type).
 *
 * Strict on purpose: the subject must name the request, the message's final paragraph must be all
 * trailer lines, and it must carry exactly one `Publish-Request` equal to the subject's id. A
 * message that is merely close is not an approve commit.
 */
export function approveCommitRequestId(message: unknown): string | null {
  if (typeof message !== 'string') return null;
  const lines = message.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n');
  const lastBlank = lines.lastIndexOf('');
  // A subject, at least one blank line, then a non-empty trailer paragraph.
  if (lastBlank < 1 || lastBlank === lines.length - 1) return null;
  const ids: string[] = [];
  for (const line of lines.slice(lastBlank + 1)) {
    const m = TRAILER_LINE.exec(line);
    if (!m) return null;
    if (m[1] === 'Publish-Request') ids.push(m[2]);
  }
  if (ids.length !== 1) return null;
  const [id] = ids;
  if (!PUBLISH_REQUEST_ID.test(id)) return null;
  if (!lines[0].startsWith(`Approved publish request ${id} — `)) return null;
  return id;
}

/** The version tag for an approved version, or null when the version cannot name a tag. */
export function versionTagName(version: string): string | null {
  return SEMVER.test(version) ? `v${version}` : null;
}

/** The per-approval tag used when the version tag already names a different commit. */
export function approvalTagName(publishRequestId: string): string | null {
  return PUBLISH_REQUEST_ID.test(publishRequestId) ? `approved-${publishRequestId}` : null;
}

export type ExistingTag = { commitSha: string } | null;

/**
 * What to do with the version tag for this approval.
 *
 * DECISION: a `v<version>` tag is never moved or deleted. It names the FIRST approved commit of
 * that version. A same-version re-submit (the retry path) that is approved again lands on a
 * different commit; it is tagged `approved-<publishRequestId>` instead, so every approved commit
 * stays addressable by a tag and the `Publish-Request` trailer names the request either way.
 *
 * Why not move it: git refuses to update a tag a clone already has (`git fetch` reports
 * "would clobber existing tag" and exits non-zero), so moving a published tag breaks every
 * developer clone that fetched it, and the old commit loses its only name.
 */
export function decideVersionTag(args: {
  version: string;
  publishRequestId: string;
  approvedSha: string;
  existingVersionTag: ExistingTag;
}):
  | { action: 'create'; tag: string }
  | { action: 'exists'; tag: string }
  | { action: 'fallback'; tag: string; versionTag: string; versionTagSha: string }
  | { action: 'skip'; reason: string } {
  const versionTag = versionTagName(args.version);
  if (!versionTag)
    return { action: 'skip', reason: `version ${JSON.stringify(args.version)} is not semver` };
  const existing = args.existingVersionTag;
  if (!existing) return { action: 'create', tag: versionTag };
  if (existing.commitSha === args.approvedSha) return { action: 'exists', tag: versionTag };
  const fallback = approvalTagName(args.publishRequestId);
  if (!fallback) return { action: 'skip', reason: 'publish request id cannot name a tag' };
  return { action: 'fallback', tag: fallback, versionTag, versionTagSha: existing.commitSha };
}
