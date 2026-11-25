import * as z from 'zod';
import {
  MEMORIAL_BASES,
  MEMORIAL_TRIBUTES_MAX,
  isMemorializedFlags,
  memorialOf,
  type MemorialBasis,
  type MemorialState,
  type MemorialTribute,
} from '@civitai/shared/memorial';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { throwBadRequestError, throwNotFoundError } from '~/server/utils/errorHandling';
import { asJsonbObjectSql } from '~/server/utils/jsonb-object';
import {
  EVENT_POINTS_EXCLUDED_FROM_META_KEY,
  UserFlag,
} from '~/shared/constants/user-flags.constants';

export const memorialBases = MEMORIAL_BASES;

const TRIBUTE_HOSTS = ['civitai.com', 'civitai.red', 'civitai.green'];

export const memorialTributeSchema = z.object({
  label: z.string().trim().min(1).max(80),
  url: z
    .string()
    .trim()
    .url()
    .refine((value) => {
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        return false;
      }
      return (
        url.protocol === 'https:' &&
        TRIBUTE_HOSTS.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))
      );
    }, 'Tribute links must be https links on a Civitai site.'),
});
export const memorialTributesSchema = z.array(memorialTributeSchema).max(MEMORIAL_TRIBUTES_MAX);

/**
 * Why this caller may not memorialize, or null. An impersonation session is refused because the
 * two-person rule compares moderator ids, and impersonating a second moderator would carry theirs.
 */
export function memorialActorRefusal(caller: {
  mayMemorialize: boolean;
  impersonatedBy: number | null | undefined;
}): string | null {
  if (!caller.mayMemorialize)
    return 'Memorializing an account needs the "user.memorialize" moderator permission.';
  if (caller.impersonatedBy != null) return 'Memorialization cannot be done while impersonating.';
  return null;
}

export class MemorializedAccountError extends Error {
  constructor() {
    super('This account is memorialized. Reverse the memorialization before deleting it.');
    this.name = 'MemorializedAccountError';
  }
}

export const isMemorialized = isMemorializedFlags;

/** The only part of the memorial a profile receives: the tributes, once a second moderator has confirmed. */
export function publicMemorial(meta: unknown): { tributes: MemorialTribute[] } | null {
  const memorial = memorialOf(meta);
  if (memorial?.status !== 'active') return null;
  return { tributes: Array.isArray(memorial.tributes) ? memorial.tributes : [] };
}

const MEMORIAL = UserFlag.Memorialized;
const EVENT_EXCLUSION = UserFlag.ExcludeFromEventPoints;

async function readTarget(userId: number) {
  // primary: explains why a write just refused, and the replica may not have the proposal yet.
  const user = await dbWrite.user.findUnique({
    where: { id: userId },
    select: { id: true, username: true, flags: true, meta: true, deletedAt: true, bannedAt: true },
  });
  if (!user) throw throwNotFoundError(`No user with id ${userId}`);
  return { ...user, memorial: memorialOf(user.meta) };
}

export async function getMemorialState(userId: number) {
  const { flags, memorial } = await readTarget(userId);
  return { memorialized: isMemorialized(flags), memorial };
}

export async function proposeMemorial(input: {
  userId: number;
  actorId: number;
  basis: MemorialBasis;
  tributes: MemorialTribute[];
}) {
  const state: MemorialState = {
    status: 'pending',
    basis: input.basis,
    tributes: input.tributes,
    proposedBy: input.actorId,
    proposedAt: new Date().toISOString(),
  };
  const meta = asJsonbObjectSql('meta');
  const updated = await dbWrite.$queryRaw<{ id: number }[]>`
    UPDATE "User"
    SET meta = ${meta} || jsonb_build_object('memorial', ${JSON.stringify(state)}::jsonb)
    WHERE id = ${input.userId}
      AND "deletedAt" IS NULL
      AND "bannedAt" IS NULL
      AND (flags & ${MEMORIAL}) = 0
      AND NOT (${meta} ? 'memorial')
    RETURNING id
  `;
  if (updated.length) return state;

  const target = await readTarget(input.userId);
  if (target.deletedAt) throw throwBadRequestError('This account is deleted.');
  if (target.bannedAt) throw throwBadRequestError('A banned account cannot be memorialized.');
  if (isMemorialized(target.flags) || target.memorial?.status === 'active')
    throw throwBadRequestError('This account is already memorialized.');
  throw throwBadRequestError('A memorialization is already waiting for confirmation.');
}

/** What confirming or reversing reaches outside the database. */
export type MemorialEffects = {
  invalidateSession: (userId: number, caller: 'moderation') => Promise<unknown>;
  /** Re-reads the session shape, so a reversed memorialization's sessions resolve again at once. */
  refreshSession: (userId: number) => Promise<unknown>;
  expireUserApiKeys: (
    userId: number
  ) => Promise<{ expired: number; orchestratorConfirmed: boolean }>;
  bustUserCreator: (userId: number, opts: { usernames: string[] }) => Promise<unknown>;
  /** Re-reads the event-points exclusion into live rosters and hats, as `setEventPointsExclusion` does. */
  syncEventStanding: (userId: number) => Promise<unknown>;
};

/** Refuses the proposer, and any proposal other than `proposedAt`, in the UPDATE itself. */
export async function confirmMemorial(
  input: { userId: number; actorId: number; proposedAt: string },
  effects: MemorialEffects
) {
  const updated = await dbWrite.$queryRaw<{ id: number; username: string | null }[]>`
    UPDATE "User"
    SET flags = flags | ${MEMORIAL} | ${EVENT_EXCLUSION},
        -- A memorial exclusion is whole-season: a start left from an earlier exclusion goes when this
        -- sets the bit itself, and stays when the bit was already set by someone else.
        meta = (CASE WHEN (flags & ${EVENT_EXCLUSION}) = 0
                  THEN meta - ${EVENT_POINTS_EXCLUDED_FROM_META_KEY}::text ELSE meta END)
          || jsonb_build_object(
          'memorial',
          (meta -> 'memorial') || jsonb_build_object(
            'status', 'active',
            'confirmedBy', ${input.actorId}::int,
            'confirmedAt', to_jsonb(now()),
            'setEventExclusion', (flags & ${EVENT_EXCLUSION}) = 0
          )
        )
    WHERE id = ${input.userId}
      AND "deletedAt" IS NULL
      AND "bannedAt" IS NULL
      AND jsonb_typeof(meta) = 'object'
      AND meta -> 'memorial' ->> 'status' = 'pending'
      AND (meta -> 'memorial' ->> 'proposedBy')::int <> ${input.actorId}::int
      AND meta -> 'memorial' ->> 'proposedAt' = ${input.proposedAt}
    RETURNING id, username
  `;
  if (!updated.length) {
    const target = await readTarget(input.userId);
    if (target.deletedAt) throw throwBadRequestError('This account is deleted.');
    if (target.bannedAt) throw throwBadRequestError('A banned account cannot be memorialized.');
    if (target.memorial?.status === 'active')
      throw throwBadRequestError('This account is already memorialized.');
    if (target.memorial?.status !== 'pending')
      throw throwBadRequestError('There is no memorialization waiting for confirmation.');
    if (target.memorial.proposedAt !== input.proposedAt)
      throw throwBadRequestError(
        'The proposal changed since you opened it. Reload the page and review it again.'
      );
    throw throwBadRequestError(
      'A different moderator from the one who proposed it must confirm a memorialization.'
    );
  }

  // Revoked first, ahead of the cache and event work. Each step logs its own failure so one
  // cannot skip the next.
  const sessionsRevoked = await effects
    .invalidateSession(input.userId, 'moderation')
    .then(() => true)
    .catch((error) => {
      logMemorialError('memorial-invalidate-session', input.userId, error);
      return false;
    });
  const keys = await effects.expireUserApiKeys(input.userId).catch((error) => {
    logMemorialError('memorial-expire-api-keys', input.userId, error);
    return null;
  });
  if (keys && !keys.orchestratorConfirmed)
    logMemorialError(
      'memorial-orchestrator-token-revoke',
      input.userId,
      new Error('orchestrator did not confirm token revocation')
    );
  await afterMemorialChanged(input.userId, updated[0].username, effects);
  return {
    sessionsRevoked,
    keysRevoked: keys !== null,
    orchestratorConfirmed: keys?.orchestratorConfirmed ?? false,
  };
}

/** Does not undo what confirming revoked: sessions, API keys, orchestrator tokens. */
export async function reverseMemorial(input: { userId: number }, effects: MemorialEffects) {
  const meta = asJsonbObjectSql('meta');
  const updated = await dbWrite.$queryRaw<{ id: number; username: string | null }[]>`
    UPDATE "User"
    SET flags = flags & ~${MEMORIAL}::int & ~(
          CASE WHEN (${meta} -> 'memorial' ->> 'setEventExclusion')::boolean
            THEN ${EVENT_EXCLUSION}::int ELSE 0 END
        ),
        meta = CASE WHEN (${meta} -> 'memorial' ->> 'setEventExclusion')::boolean
          THEN ${meta} - 'memorial' - ${EVENT_POINTS_EXCLUDED_FROM_META_KEY}::text
          ELSE ${meta} - 'memorial' END
    WHERE id = ${input.userId}
      AND ((${meta} ? 'memorial') OR (flags & ${MEMORIAL}) <> 0)
    RETURNING id, username
  `;
  if (!updated.length) {
    await readTarget(input.userId);
    throw throwBadRequestError('This account is not memorialized.');
  }
  await effects
    .refreshSession(input.userId)
    .catch((error) => logMemorialError('memorial-refresh-session', input.userId, error));
  await afterMemorialChanged(input.userId, updated[0].username, effects);
}

async function afterMemorialChanged(
  userId: number,
  username: string | null,
  effects: MemorialEffects
) {
  await effects
    .syncEventStanding(userId)
    .catch((error) => logMemorialError('memorial-sync-event-standing', userId, error));
  await effects
    .bustUserCreator(userId, { usernames: username ? [username] : [] })
    .catch((error) => logMemorialError('memorial-bust-user-creator', userId, error));
}

function logMemorialError(name: string, userId: number, error: unknown) {
  logToAxiom({
    type: 'error',
    name,
    userId,
    message: (error as Error).message,
    error,
  });
}

export function assertNotMemorialized(user: { flags: number }) {
  if (isMemorialized(user.flags)) throw new MemorializedAccountError();
}

/** The recipients that are memorialized, so a new chat can drop them. */
export async function memorializedAmong(userIds: number[]): Promise<Set<number>> {
  if (!userIds.length) return new Set();
  // primary: memorial status must not lag a confirm.
  const rows = await dbWrite.$queryRaw<{ id: number }[]>`
    SELECT id FROM "User" WHERE id = ANY(${userIds}::int[]) AND (flags & ${MEMORIAL}) <> 0
  `;
  return new Set(rows.map((row) => row.id));
}

/** The SQL for `column` without the memorial record, for a read not limited to `user.memorialize` holders. */
export function metaWithoutMemorialSql(column: string) {
  return `(CASE WHEN jsonb_typeof(${column}) = 'object' THEN ${column} - 'memorial' ELSE ${column} END)`;
}
