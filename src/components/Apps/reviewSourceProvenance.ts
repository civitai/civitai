/**
 * The moderator review's SOURCE lines (pure, React-free): what the submitting client CLAIMED about
 * its commit, and the GitHub Actions run the server CHECKED, on two separate, labelled lines.
 *
 * 🔴 TWO TRUST LEVELS, NEVER MERGED. `claimedCommit` / `claimedDirty` are whatever the client sent;
 * the server checked their shape only. `actionsRun` comes from an OIDC token GitHub signed and the
 * server verified. One line never fills in for the other: a request with a claim and no run shows
 * "none" on the run line, not the claim.
 *
 * 🔴 WHAT "VERIFIED" COVERS. The run's repository, tag and commit. Not the bundle: the developer's
 * workflow built and uploaded it, so the run line carries a note saying so.
 */

import type { ReviewSourceProvenance } from '~/server/schema/blocks/actions-run-source.schema';

export type ReviewProvenanceLine = {
  key: 'claimed' | 'actions-run';
  heading: string;
  value: string;
  links: { label: string; href: string }[];
  note?: string;
};

export const CLAIMED_COMMIT_LABEL = 'Claimed commit (sent by the client, not checked)';
export const ACTIONS_RUN_LABEL = 'GitHub-signed Actions run';
export const ACTIONS_RUN_NOTE =
  "GitHub signed this run's repository, tag and commit. The run uploaded the bundle itself, so this does not show the bundle was built from that commit.";

const REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const RUN_ID_RE = /^\d+$/;
const TAG_REF_PREFIX = 'refs/tags/';

function claimedValue(p: ReviewSourceProvenance): string {
  if (!p.claimedCommit) return 'none sent';
  const sha7 = p.claimedCommit.slice(0, 7);
  if (p.claimedDirty === true) return `${sha7} · uncommitted changes`;
  if (p.claimedDirty === false) return `${sha7} · clean tree`;
  return `${sha7} · tree state not sent`;
}

/**
 * The manifest's `repository`, as the review header shows it.
 *
 * 🔴 AUTHOR-DECLARED AND UNCHECKED. Nothing ties this URL to the bundle under review, so it is
 * labelled as the developer's claim and never as "verified" (that word belongs to the
 * GitHub-signed Actions run alone). The commit beside it is the client's claim, labelled so.
 *
 * 🔴 A LINK ONLY FOR `https:` ON A KNOWN CODE HOST. `javascript:`, `data:`, `http:`, a bare
 * `github.com/a/b`, credentials in the URL or any other host stay PLAIN TEXT. The host list is
 * the three public forges developers actually declare; a one-click link from a moderator's
 * session to an arbitrary author-chosen host is the affordance a hostile submission wants, and
 * any other host is still readable as text. The link text is the PARSED URL (`URL.href`), the
 * same string as the `href`, so what the moderator reads is where the click goes.
 */
export const DECLARED_REPOSITORY_LABEL = 'Repository (declared by the developer, not checked)';
export const DECLARED_REPOSITORY_HOSTS: ReadonlySet<string> = new Set([
  'github.com',
  'gitlab.com',
  'codeberg.org',
]);

export type DeclaredRepository = {
  /** What to show: the parsed URL when it links, else the value as the developer wrote it. */
  text: string;
  /** Only set for an `https:` URL on a host in `DECLARED_REPOSITORY_HOSTS`. */
  href: string | null;
  /** The client-claimed commit, shortened; `null` when none was sent. */
  claimedCommit: string | null;
  /** `<repo>/commit/<sha>`, only for a github.com `owner/repo` URL and a full 40-hex claim. */
  claimedCommitHref: string | null;
};

export function declaredRepository(
  repository: unknown,
  claimedCommit?: string | null
): DeclaredRepository | null {
  if (typeof repository !== 'string' || repository.trim() === '') return null;
  const raw = repository.trim();
  const sha =
    typeof claimedCommit === 'string' && SHA_RE.test(claimedCommit) ? claimedCommit : null;
  const out: DeclaredRepository = {
    text: raw,
    href: null,
    claimedCommit: sha ? sha.slice(0, 7) : null,
    claimedCommitHref: null,
  };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return out;
  }
  if (url.protocol !== 'https:') return out;
  if (url.username || url.password) return out;
  const host = url.hostname.toLowerCase();
  if (!DECLARED_REPOSITORY_HOSTS.has(host)) return out;
  out.text = url.href;
  out.href = url.href;
  if (sha && host === 'github.com') {
    const ownerRepo = url.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '');
    if (REPOSITORY_RE.test(ownerRepo)) {
      out.claimedCommitHref = `https://github.com/${ownerRepo}/commit/${sha}`;
    }
  }
  return out;
}

/** The two lines, claim first. Empty when the request carries no provenance block at all. */
export function reviewProvenanceLines(
  p: ReviewSourceProvenance | null | undefined
): ReviewProvenanceLine[] {
  if (!p) return [];
  const lines: ReviewProvenanceLine[] = [
    { key: 'claimed', heading: CLAIMED_COMMIT_LABEL, value: claimedValue(p), links: [] },
  ];
  const run = p.actionsRun;
  if (!run) {
    lines.push({ key: 'actions-run', heading: ACTIONS_RUN_LABEL, value: 'none', links: [] });
    return lines;
  }
  const tag = run.ref.startsWith(TAG_REF_PREFIX) ? run.ref.slice(TAG_REF_PREFIX.length) : run.ref;
  const visibility =
    run.repositoryVisibility === 'public' ? '' : ` · ${run.repositoryVisibility} repository`;
  const links: ReviewProvenanceLine['links'] = [];
  // Links only from shape-checked values (they were checked at submit; checked again here
  // because this builds URLs).
  if (REPOSITORY_RE.test(run.repository)) {
    if (SHA_RE.test(run.sha)) {
      links.push({
        label: 'commit',
        href: `https://github.com/${run.repository}/commit/${run.sha}`,
      });
    }
    if (RUN_ID_RE.test(run.runId)) {
      links.push({
        label: 'run',
        href: `https://github.com/${run.repository}/actions/runs/${run.runId}`,
      });
    }
  }
  lines.push({
    key: 'actions-run',
    heading: ACTIONS_RUN_LABEL,
    value: `${run.repository} @ ${tag} (${run.sha.slice(0, 7)})${visibility}`,
    links,
    note: ACTIONS_RUN_NOTE,
  });
  return lines;
}
