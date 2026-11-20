import {
  AGENT_REVIEW_SECTIONS,
  isAgentSectionFailureMarker,
  type AgentReviewSection,
} from '~/shared/constants/agent-review-section.constants';
import { OFFLINE_ACCESS_SCOPE } from '~/shared/constants/connect-agent-review.constants';
import {
  isSensitiveTokenScope,
  tokenScopeMaskToList,
} from '~/shared/constants/token-scope.constants';

/**
 * AGENT REVIEW, CONNECT LANE: the parts that are facts, not judgements.
 *
 * The runner's model judges the listing. What Civitai already knows for certain is written here,
 * by code, into the same three report sections, so it is on the report whether or not the model
 * mentions it, gets it wrong or fails:
 *   - whether the app's OAuth client can get refreshable tokens (`offline_access`),
 *   - whether the author linked server source, and whether it was fetched for review,
 *   - that listings carry no privacy-policy field.
 *
 * Every entry written here carries `origin: 'civitai'`. On the callback, the runner's own entries
 * that claim that origin are dropped and the stored ones are put back first, so a prompt-injected
 * runner can neither remove a fact nor forge one. Pure: no DB, no network.
 */

/** Marks a report entry Civitai wrote rather than the runner. */
export const SERVER_FACT_ORIGIN = 'civitai';

/** RFC 8628's grant type. A client holding it gets sliding refresh tokens with no consent line. */
export const DEVICE_CODE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const REFRESH_TOKEN_GRANT = 'refresh_token';

/** Report `version` for a connect review: listing requests have none, and the column is required. */
export const CONNECT_REVIEW_VERSION = '0.0.0';

/** The file in the review bundle that describes the listing. */
export const CONNECT_REVIEW_INPUT_FILE = 'connect-review.json';
/** The fetched source archive, nested unextracted (see `fetchConnectSource`). */
export const CONNECT_REVIEW_SOURCE_FILE = 'source.zip';

export const NO_SOURCE_STATEMENT =
  'No server source was provided with this submission, so the source review and the token ' +
  'storage and exfiltration checks did not run. An empty code review here is not a clean result.';

export type ConnectReviewSubject = {
  publishRequestId: string;
  slug: string;
  changelog: string | null;
  listing: {
    id: string;
    name: string;
    tagline: string | null;
    description: string | null;
    category: string | null;
    externalUrl: string | null;
    sourceRepoUrl: string | null;
    contentRating: string | null;
    requestedScopes: number | null;
    scopeJustifications: Record<string, string> | null;
  };
  client: {
    id: string;
    name: string;
    description: string;
    redirectUris: string[];
    allowedOrigins: string[];
    grants: string[];
    isConfidential: boolean;
    isVerified: boolean;
  };
};

export type ConnectSourceResult =
  | { provided: false }
  | {
      provided: true;
      repoUrl: string;
      fetched: true;
      archiveSha256: string;
      /** The commit the archive was cut from, when the host says (GitHub's redirect does). */
      commitSha: string | null;
      bytes: number;
    }
  | { provided: true; repoUrl: string; fetched: false; reason: string };

export type OfflineAccessPosture = {
  /** The client can obtain a refresh token, so it can act while the user is away. */
  reachable: boolean;
  /** Device-flow client: every chain is offline, with no consent line to untick. */
  alwaysOffline: boolean;
};

export function offlineAccessPosture(grants: readonly string[]): OfflineAccessPosture {
  const alwaysOffline = grants.includes(DEVICE_CODE_GRANT);
  return { reachable: alwaysOffline || grants.includes(REFRESH_TOKEN_GRANT), alwaysOffline };
}

/**
 * The archive URL for a repo link `validateRepositoryUrl` already normalised to
 * `https://<host>/<owner>/<repo>`, plus the hosts its redirects may visit. `null` for a host we
 * do not fetch from: codeberg.org's archive endpoint did not answer when this was built, so it is
 * reported as "linked, not fetched" rather than guessed at.
 */
export function connectSourceArchiveUrl(
  repoUrl: string
): { url: string; hosts: readonly string[] } | null {
  let parsed: URL;
  try {
    parsed = new URL(repoUrl);
  } catch {
    return null;
  }
  const [owner, repo, ...rest] = parsed.pathname.split('/').filter(Boolean);
  if (!owner || !repo || rest.length > 0 || parsed.protocol !== 'https:') return null;
  const o = encodeURIComponent(owner);
  const r = encodeURIComponent(repo);
  switch (parsed.hostname.toLowerCase()) {
    case 'github.com':
      return {
        url: `https://github.com/${o}/${r}/archive/HEAD.zip`,
        hosts: ['github.com', 'codeload.github.com'],
      };
    case 'gitlab.com':
      return {
        url: `https://gitlab.com/${o}/${r}/-/archive/HEAD/${r}-HEAD.zip`,
        hosts: ['gitlab.com'],
      };
    default:
      return null;
  }
}

/** GitHub redirects `archive/HEAD.zip` to `codeload.github.com/<o>/<r>/zip/<sha>`. */
export function commitShaFromArchiveUrl(finalUrl: string): string | null {
  const m = /^https:\/\/codeload\.github\.com\/[^/]+\/[^/]+\/zip\/([0-9a-f]{40})$/.exec(finalUrl);
  return m ? m[1] : null;
}

/** What the runner reads from `connect-review.json`. Holds no secret: the client secret is never loaded. */
export function buildConnectReviewInput(
  subject: ConnectReviewSubject,
  source: ConnectSourceResult
) {
  const { listing, client } = subject;
  const offline = offlineAccessPosture(client.grants);
  const scopes =
    listing.requestedScopes != null ? tokenScopeMaskToList(BigInt(listing.requestedScopes)) : [];
  return {
    reviewKind: 'connect' as const,
    publishRequestId: subject.publishRequestId,
    slug: subject.slug,
    listing: {
      name: listing.name,
      tagline: listing.tagline,
      description: listing.description,
      category: listing.category,
      contentRating: listing.contentRating,
      externalUrl: listing.externalUrl,
      sourceRepoUrl: listing.sourceRepoUrl,
      changelog: subject.changelog,
      // Listings have no privacy-policy field; the agent looks for one in the text and links.
      privacyPolicyUrl: null,
      privacyPolicyFieldExists: false,
    },
    oauthClient: {
      name: client.name,
      description: client.description,
      redirectUris: client.redirectUris,
      allowedOrigins: client.allowedOrigins,
      grants: client.grants,
      isConfidential: client.isConfidential,
      isVerified: client.isVerified,
    },
    requestedScopes: scopes.map((s) => ({
      key: s.key,
      label: s.label,
      sensitive: isSensitiveTokenScope(s.bit),
      justification: listing.scopeJustifications?.[s.key] ?? null,
    })),
    offlineAccess: { scope: OFFLINE_ACCESS_SCOPE, ...offline },
    source:
      source.provided === false
        ? { provided: false as const, statement: NO_SOURCE_STATEMENT }
        : source.fetched
        ? {
            provided: true as const,
            fetched: true as const,
            repoUrl: source.repoUrl,
            commitSha: source.commitSha,
            archiveSha256: source.archiveSha256,
            file: CONNECT_REVIEW_SOURCE_FILE,
          }
        : {
            provided: true as const,
            fetched: false as const,
            repoUrl: source.repoUrl,
            reason: source.reason,
          },
  };
}

type FactEntry = Record<string, unknown> & {
  origin: typeof SERVER_FACT_ORIGIN;
  summaryLine: string;
};

/** The Civitai-written entries for each section, in the list each section keeps them in. */
export type ConnectServerFacts = Record<AgentReviewSection, FactEntry[]>;

/** Which array of a section holds its entries. */
const LIST_KEY: Record<AgentReviewSection, 'scopes' | 'findings'> = {
  scopeVerdicts: 'scopes',
  securityAudit: 'findings',
  codeReview: 'findings',
};

export function connectServerFacts(
  subject: ConnectReviewSubject,
  source: ConnectSourceResult
): ConnectServerFacts {
  const offline = offlineAccessPosture(subject.client.grants);
  const grantsEvidence = `OAuth client grants: ${subject.client.grants.join(', ') || '(none)'}`;
  const offlineLine = offline.alwaysOffline
    ? 'OFFLINE ACCESS: always on. The app uses the device flow, so every token it gets can be ' +
      'refreshed and it can act while the user is away, with no consent line to untick.'
    : offline.reachable
    ? 'OFFLINE ACCESS: reachable. The app can ask for offline_access; once a user approves it, ' +
      'the app holds a refreshable token and can act while the user is away, until they disconnect.'
    : 'Offline access: not reachable. The OAuth client holds no refresh-token or device grant.';

  const scopeVerdicts: FactEntry[] = [
    {
      origin: SERVER_FACT_ORIGIN,
      declared: OFFLINE_ACCESS_SCOPE,
      kind: 'oauth-grant',
      sensitive: offline.reachable,
      evidence: [grantsEvidence],
      notes: offlineLine,
      summaryLine: offlineLine,
    },
  ];

  const securityAudit: FactEntry[] = [];
  if (offline.reachable) {
    securityAudit.push({
      origin: SERVER_FACT_ORIGIN,
      severity: 'medium',
      category: 'oauth-offline-access',
      title: offline.alwaysOffline
        ? 'Always acts while the user is away (device flow)'
        : 'Can act while the user is away (offline_access)',
      detail:
        `${offlineLine} Check that the stated purpose needs background access, and that the ` +
        'scopes it pairs with are ones a user would expect it to use unattended.',
      evidence: [grantsEvidence],
      summaryLine: offlineLine,
    });
  }
  const privacyLine =
    'Privacy policy: none on record. Listings have no privacy-policy field, so the platform ' +
    'holds no privacy-policy URL for this app; look for one in the description and links.';
  securityAudit.push({
    origin: SERVER_FACT_ORIGIN,
    severity: 'info',
    category: 'listing-claims',
    title: 'No privacy-policy URL on record',
    detail: privacyLine,
    evidence: [],
    summaryLine: privacyLine,
  });

  let sourceTitle: string;
  let sourceLine: string;
  const sourceEvidence: string[] = [];
  if (source.provided === false) {
    sourceTitle = 'No server source provided';
    sourceLine = NO_SOURCE_STATEMENT;
  } else if (!source.fetched) {
    sourceTitle = 'Server source linked but not reviewed';
    sourceLine =
      `Server source is linked (${source.repoUrl}) but could not be fetched for review: ` +
      `${source.reason}. The source review and the token storage and exfiltration checks did ` +
      'not run. An empty code review here is not a clean result.';
    sourceEvidence.push(source.repoUrl);
  } else {
    sourceTitle = 'Server source reviewed';
    sourceLine =
      `Server source was reviewed from ${source.repoUrl} at ` +
      `${source.commitSha ? `commit ${source.commitSha}` : 'the default branch head'}. It is ` +
      'the code the author links, not proof of what runs on their server.';
    sourceEvidence.push(source.repoUrl, `archive sha256 ${source.archiveSha256}`);
  }
  const codeReview: FactEntry[] = [
    {
      origin: SERVER_FACT_ORIGIN,
      severity: 'info',
      category: 'source',
      title: sourceTitle,
      detail: sourceLine,
      evidence: sourceEvidence,
      summaryLine: sourceLine,
    },
  ];

  return { scopeVerdicts, securityAudit, codeReview };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isServerFact(v: unknown): boolean {
  return isPlainObject(v) && v.origin === SERVER_FACT_ORIGIN;
}

/** The Civitai-written entries already stored on a report row's sections. */
export function serverFactsFromStored(
  row: Partial<Record<AgentReviewSection, unknown>>
): ConnectServerFacts {
  const out = {} as ConnectServerFacts;
  for (const section of AGENT_REVIEW_SECTIONS) {
    const value = row[section];
    const list = isPlainObject(value) ? value[LIST_KEY[section]] : undefined;
    out[section] = Array.isArray(list) ? (list.filter(isServerFact) as FactEntry[]) : [];
  }
  return out;
}

/**
 * One section with the facts first and the runner's entries after.
 *
 * Returns the facts alone when `value` is absent; returns `value` unchanged when it is a failure
 * marker (the failure must stay visible; the summary header still carries the facts). Otherwise
 * drops every runner entry that claims Civitai's origin, and on the scope list any runner verdict
 * for `offline_access`, whose verdict is Civitai's.
 */
export function withServerFacts(
  section: AgentReviewSection,
  facts: ConnectServerFacts,
  value: unknown
): unknown {
  const key = LIST_KEY[section];
  const seed = facts[section];
  if (value == null) return seedSection(section, seed);
  if (isAgentSectionFailureMarker(value) || !isPlainObject(value)) return value;
  const list = Array.isArray(value[key]) ? (value[key] as unknown[]) : [];
  const runner = list.filter(
    (e) =>
      !isServerFact(e) &&
      !(section === 'scopeVerdicts' && isPlainObject(e) && e.declared === OFFLINE_ACCESS_SCOPE)
  );
  return { ...value, [key]: [...seed, ...runner] };
}

function seedSection(section: AgentReviewSection, seed: FactEntry[]): Record<string, unknown> {
  if (section === 'scopeVerdicts') return { scopes: seed, overBroad: [], underDeclared: [] };
  if (section === 'codeReview') return { findings: seed, priorFindingsReconciled: [] };
  return { findings: seed };
}

export const SERVER_FACTS_HEADING = 'Checked by Civitai, not by the review agent:';

/** The block every connect report's summary starts with. */
export function serverFactsSummary(facts: ConnectServerFacts): string {
  const lines = AGENT_REVIEW_SECTIONS.flatMap((s) => facts[s].map((e) => `- ${e.summaryLine}`));
  // A scope line and a security line can say the same thing; say it once.
  const unique = Array.from(new Set(lines));
  // Plain text: the panel renders `summaryMd` as inert pre-wrapped text, not markdown.
  return `${SERVER_FACTS_HEADING}\n${unique.join('\n')}`;
}

/**
 * Put the stored facts back into a callback's update `data`. A section the runner did not report
 * is left out, so the stored (seeded) value stands.
 */
export function mergeConnectCallbackData(
  facts: ConnectServerFacts,
  data: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...data };
  for (const section of AGENT_REVIEW_SECTIONS) {
    if (out[section] !== undefined) out[section] = withServerFacts(section, facts, out[section]);
  }
  const summary = typeof out.summaryMd === 'string' ? out.summaryMd : '';
  out.summaryMd = summary
    ? `${serverFactsSummary(facts)}\n\n${summary}`
    : serverFactsSummary(facts);
  return out;
}
