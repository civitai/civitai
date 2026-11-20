import { TRPCError } from '@trpc/server';
import { sql } from 'kysely';
import type { NextApiRequest } from 'next';
import { readRequestBearerToken } from '~/server/auth/request-bearer-token';
import { getRequestCredential, type RequestCredential } from '~/server/auth/request-credential';
import { kyselyWrite } from '~/server/db/kyselyDb';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import {
  getBuzzLimitForSubject,
  type BuzzSpendEntry,
  type Subject,
} from '~/server/http/orchestrator/api-key-spend';
import type { BuzzLimit } from '~/server/schema/api-key.schema';

// THE OFFLINE BUZZ CAP (flag `oauth-offline-grant`; the auth hub's apps/auth offline-grant.ts mints
// the tokens it reads).
//
// The rule: Buzz spent through the orchestrator by an OAuth access token the hub minted from a
// refresh grant (`ApiKey.mintOrigin = 'refresh'`, i.e. renewed by the app with no user present) is
// held to the consent's `buzzLimit`. That is the cap the user set on the consent screen's "Stay
// connected while you're away" line, or later in Connected apps, and the same budgets array the
// orchestrator already applies to the app's OAuth subject (`/api/v1/me` hands it out).
//
// How: for such a request the orchestrator gets the caller's own token, so the work is metered and
// capped under the app's subject (`oauth` + client id). When the orchestrator's snapshot for that subject
// already shows a budget spent, the request is refused here with a message that says so, before any
// work is submitted. If the snapshot cannot be read, the orchestrator's own enforcement still applies.
//
// No cap (a null or empty `buzzLimit`) changes nothing: getOrchestratorToken goes on as it does
// today. Null has always meant "no limit" for this column (`buzzLimitSchema`), the user can set one
// at any time, and an app that asks for offline access without proposing one gets none by default
// rather than a number nobody chose.
//
// Flag off, no OAuth subject, or any other mint origin: null, and getOrchestratorToken goes on as
// before. Only flag-on code reads `mintOrigin` (a no-type column, see schema.full.prisma).

export const OFFLINE_BUZZ_CAP_REACHED =
  "This app has used the Buzz limit you set for it while you're away. You can raise it in Connected apps.";

/** What `getServerAuthSession` recorded on the request beside the credential. */
type RequestContext = { buzzLimit?: unknown; session?: { user?: { id?: number } } | null };

/** What the cap rule reads off one request. */
export interface OfflineCapRequest {
  /** The user the orchestrator token is for. */
  userId: number;
  credential: Pick<RequestCredential, 'subject' | 'apiKeyId' | 'apiKeyType'>;
  /** The request's session user; differs from `userId` on a moderator path. */
  sessionUserId: number | undefined;
  /** The consent's cap as the bearer lookup read it (`req.context.buzzLimit`). */
  buzzLimit: BuzzLimit | null;
  /** Read only once the credential is one the cap can apply to. */
  bearerToken: () => string | undefined;
}

/** The rule's reads, passed in so it is testable without the database, Flipt or the orchestrator. */
export interface OfflineCapReads {
  flagOn: () => Promise<boolean>;
  mintOrigin: (apiKeyId: number) => Promise<string | null>;
  /** The orchestrator's spend snapshot for the subject; null when it has none or cannot answer. */
  spend: (userId: number, subject: Subject) => Promise<BuzzSpendEntry | null>;
}

/**
 * The cap rule: the caller's own token when the request is a refresh-minted OAuth token whose
 * consent has a cap, else null. Throws FORBIDDEN when the orchestrator reports a budget spent. The
 * cheap checks run first, so a request the cap cannot apply to reads neither Flipt nor the database.
 */
export async function resolveOfflineCapToken(
  input: OfflineCapRequest,
  reads: OfflineCapReads
): Promise<string | null> {
  const { subject, apiKeyId, apiKeyType } = input.credential;
  if (subject?.type !== 'oauth' || apiKeyId == null || apiKeyType !== 'Access') return null;
  // A moderator path can fetch a token for another user; the cap is the caller's own.
  if (input.sessionUserId !== input.userId) return null;
  if (!input.buzzLimit || input.buzzLimit.length === 0) return null;
  const bearerToken = input.bearerToken();
  if (!bearerToken) return null;
  if (!(await reads.flagOn())) return null;
  if ((await reads.mintOrigin(apiKeyId)) !== 'refresh') return null;

  const snapshot = await reads.spend(input.userId, subject).catch(() => null);
  if (snapshot?.rules.some((rule) => rule.limit > 0 && rule.remaining <= 0)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: OFFLINE_BUZZ_CAP_REACHED });
  }
  return bearerToken;
}

/**
 * The token to send the orchestrator for this request: the caller's own refresh-minted OAuth token when its consent has a cap. Null when the cap does not
 * apply. Throws FORBIDDEN when the orchestrator reports the cap already spent.
 */
export function offlineCapOrchestratorToken(
  userId: number,
  req: NextApiRequest
): Promise<string | null> {
  const context = (req as NextApiRequest & { context?: RequestContext }).context;
  return resolveOfflineCapToken(
    {
      userId,
      credential: getRequestCredential(req),
      sessionUserId: context?.session?.user?.id,
      buzzLimit: (context?.buzzLimit ?? null) as BuzzLimit | null,
      bearerToken: () => readRequestBearerToken(req),
    },
    {
      flagOn: () => isFlipt(FLIPT_FEATURE_FLAGS.OAUTH_OFFLINE_GRANT),
      mintOrigin: readMintOrigin,
      spend: (id, subject) => getBuzzLimitForSubject({ userId: id, subject }),
    }
  );
}

/** The `mintOrigin` of an `Access` key, or null. */
async function readMintOrigin(apiKeyId: number): Promise<string | null> {
  // primary: a refresh mints the token moments before the app first uses it, so a replica can
  // still lack the row, which would read as "no origin" and skip the cap.
  const row = await kyselyWrite
    .selectFrom('ApiKey')
    .select(sql<string | null>`"mintOrigin"`.as('mintOrigin'))
    .where('id', '=', apiKeyId)
    .where('type', '=', 'Access')
    .executeTakeFirst();
  return row?.mintOrigin ?? null;
}
