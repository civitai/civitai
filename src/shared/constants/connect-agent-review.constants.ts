import {
  OFFLINE_ACCESS_JUSTIFICATION_KEY,
  offlineAccessJustification,
} from '~/shared/constants/token-scope.constants';

/**
 * The agent review's two LANES, and the flag that opens the connect one.
 *
 * The on-site lane reviews an `AppBlockPublishRequest` (a hosted bundle). The connect lane
 * reviews an `AppListingPublishRequest` for an OAuth-connect listing: its requested scopes, its
 * listing claims and, when the author links one, its public server source. Both run on the same
 * dispatcher, runner and report row; only the subject they load differs.
 *
 * Client-safe (no zod, Prisma or server imports): the flag key is read by the server gate and
 * registered as a client `fliptKey`, the `knightsApp` shape `.claude/rules/server.md` names.
 */

/**
 * Flipt flag for the connect lane. Mod-segmented like `app-blocks-agentic-review`, created
 * base OFF; absent or unreachable evaluates false, so the lane is dark until it exists.
 */
export const APP_LISTINGS_AGENTIC_REVIEW_FLAG = 'app-listings-agentic-review';

export type AgentReviewLane = 'onsite' | 'connect';

/** `AppListingPublishRequest` ids are `alpr_<ULID>` (`newAppListingPublishRequestId`). */
export const CONNECT_PUBLISH_REQUEST_ID_PREFIX = 'alpr_';

/**
 * Which lane a publish-request id belongs to, from its prefix. Everything that is not a listing
 * request id is the on-site lane, so every id the on-site lane accepted before keeps its lane.
 */
export function agentReviewLaneFor(publishRequestId: string): AgentReviewLane {
  return publishRequestId.startsWith(CONNECT_PUBLISH_REQUEST_ID_PREFIX) ? 'connect' : 'onsite';
}

/** The OAuth scope name an app asks for to get a refresh token (phase 1 of the token work). */
export const OFFLINE_ACCESS_SCOPE = OFFLINE_ACCESS_JUSTIFICATION_KEY;

/**
 * A connect listing's offline-access declaration, read from its justification map: declared ⇔ the
 * `offline_access` key carries a non-empty rationale. A listing from before declarations existed
 * has no key, and reads as not declared.
 */
export function offlineAccessDeclaration(
  justifications: Record<string, string> | null | undefined
): { declared: boolean; justification: string | null } {
  // The shared rule (`offlineAccessJustification`), so the hub's offline-grant check agrees.
  const text = offlineAccessJustification(justifications);
  return text ? { declared: true, justification: text } : { declared: false, justification: null };
}

// ---------------------------------------------------------------------------
// What Civitai checks itself (server-written, rendered in the "Checked by Civitai" block)
// ---------------------------------------------------------------------------

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

/**
 * Stored in `AppReviewAgentReportCheck.checks`: written by the dispatch only. The runner's callback
 * has no path to that table, so nothing it reports can appear in, edit or imitate this block.
 */
export type ConnectCivitaiChecks = {
  /**
   * `declared`: the listing's own declaration. Absent on checks stored before declarations
   * existed; those render as before, with no mismatch line.
   */
  offlineAccess: OfflineAccessPosture & { grants: string[]; declared?: boolean };
  source: ConnectSourceResult;
};

/** What the panel shows for a connect report's checks: `checks` plus whether they are stale. */
export type ConnectCivitaiChecksView = {
  checks: ConnectCivitaiChecks;
  /** The listing (scopes, justifications, text, links, grants) changed after this review. */
  stale: boolean;
};

export const NO_SOURCE_STATEMENT =
  'No server source was provided with this submission, so the source review and the token ' +
  'storage and exfiltration checks did not run. An empty code review is not a clean result.';

/**
 * A listed client that could refresh but whose listing does not declare offline access. With the
 * hub's enforcement it cannot get offline access at all: no "Stay connected" line, no refresh token.
 */
export const UNDECLARED_NO_OFFLINE_STATEMENT =
  'Offline access: NOT DECLARED, so this app cannot get it. Its OAuth client could get refresh ' +
  'tokens, but because the listing does not declare offline access, the sign-in screen does not ' +
  'offer "Stay connected" and no refresh token is issued. Until offline access is a separate ' +
  'grant on the sign-in service, every app still receives refresh tokens.';

export const STALE_REVIEW_STATEMENT = 'Stale — the listing changed after this review.';

export type CivitaiCheckLine = { tone: 'warn' | 'info'; text: string };

/** The block's lines, in order. Pure and client-safe: the panel renders exactly these. */
export function civitaiCheckLines(checks: ConnectCivitaiChecks): CivitaiCheckLine[] {
  const { offlineAccess: o, source: s } = checks;
  const lines: CivitaiCheckLine[] = [];
  // The hub offers offline access to a listed connect client only when its APPROVED listing
  // declares it (auth hub, listing-offline.ts, while offline access is its own grant). So a client
  // that could refresh but whose listing does not declare it simply cannot get it; that is the
  // line, not a "reachable" warning. The device flow is not gated there, so it stays ALWAYS.
  const undeclaredSoBlocked = o.declared === false && o.reachable && !o.alwaysOffline;
  lines.push(
    o.alwaysOffline
      ? {
          tone: 'warn',
          text:
            'Offline access: ALWAYS. The app uses the device flow, so every token it gets can be ' +
            'refreshed and it can act while the user is away, with no consent line to untick.',
        }
      : undeclaredSoBlocked
      ? { tone: 'warn', text: UNDECLARED_NO_OFFLINE_STATEMENT }
      : o.reachable
      ? {
          tone: 'warn',
          text:
            'Offline access: REACHABLE. The app can ask for offline_access; once a user approves it, ' +
            'the app holds a refreshable token and can act while the user is away, until they disconnect.',
        }
      : {
          tone: 'info',
          text: 'Offline access: not reachable. The OAuth client holds no refresh-token or device grant.',
        }
  );
  // The declaration against what the client can do. Mismatches are flagged; a match is stated so
  // the reviewer knows the justification is the thing left to judge.
  if (o.declared === true && !o.reachable)
    lines.push({
      tone: 'warn',
      text:
        'Declaration MISMATCH: the listing declares offline access, but its OAuth client cannot ' +
        'get refresh tokens. The declaration does not describe this client.',
    });
  else if (o.declared === false && o.alwaysOffline)
    lines.push({
      tone: 'warn',
      text:
        'Declaration MISMATCH: the app uses the device flow, which always gets refresh tokens, but ' +
        'the listing does NOT declare offline access.',
    });
  else if (o.declared === true && o.reachable)
    lines.push({
      tone: 'info',
      text: 'Offline access is declared and reachable. Judge the stated justification.',
    });
  if (!s.provided) lines.push({ tone: 'warn', text: NO_SOURCE_STATEMENT });
  else if (!s.fetched)
    lines.push({
      tone: 'warn',
      text:
        `Server source is linked (${s.repoUrl}) but was not reviewed: ${s.reason}. The source ` +
        'review and the token storage and exfiltration checks did not run. An empty code review ' +
        'is not a clean result.',
    });
  else
    lines.push({
      tone: 'info',
      text:
        `Server source reviewed from ${s.repoUrl} at ` +
        `${
          s.commitSha ? `commit ${s.commitSha}` : 'the default branch head'
        }. It is the code the ` +
        'author links, not proof of what runs on their server.',
    });
  return lines;
}
