import * as z from 'zod';
import {
  MEMORIAL_BASES,
  MEMORIAL_TRIBUTES_MAX,
  memorialOf,
  type MemorialBasis,
  type MemorialState,
  type MemorialTribute,
} from '@civitai/shared/memorial';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { throwBadRequestError, throwNotFoundError } from '~/server/utils/errorHandling';
import { asJsonbObjectSql } from '~/server/utils/jsonb-object';
import { UserFlag } from '~/shared/constants/user-flags.constants';
import { Flags } from '~/shared/utils/flags';

export const memorialBases = MEMORIAL_BASES;

const TRIBUTE_HOSTS = ['civitai.com', 'civitai.red', 'civitai.green'];

export const memorialTributeSchema = z.object({
  label: z.string().trim().min(1).max(80),
  url: z
    .string()
    .trim()
    .url()
    .refine((value) => {
      const { protocol, hostname } = new URL(value);
      return (
        protocol === 'https:' &&
        TRIBUTE_HOSTS.some((host) => hostname === host || hostname.endsWith(`.${host}`))
      );
    }, 'Tribute links must be https links on a Civitai site.'),
});
export const memorialTributesSchema = z.array(memorialTributeSchema).max(MEMORIAL_TRIBUTES_MAX);

export class MemorializedAccountError extends Error {
  constructor() {
    super('This account is memorialized. Reverse the memorialization before deleting it.');
    this.name = 'MemorializedAccountError';
  }
}

export const isMemorialized = (flags: number | null | undefined) =>
  Flags.hasFlag(flags ?? 0, UserFlag.Memorialized);

/** `User.meta` never reaches a public payload; this is all of the memorial that does. What a profile shows: tributes once a second moderator has confirmed, nothing before. */
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

/**
 * The second moderator's step. The two-person rule is a predicate on the write itself, so a
 * proposer cannot confirm their own proposal by any route, and two concurrent confirms set it once.
 */
/** What a memorialization reaches outside the database: sessions, keys and the creator-card cache. */
export type MemorialEffects = {
  invalidateSession: (userId: number, caller: 'moderation') => Promise<unknown>;
  expireUserApiKeys: (
    userId: number
  ) => Promise<{ expired: number; orchestratorConfirmed: boolean }>;
  bustUserCreator: (userId: number, opts: { usernames: string[] }) => Promise<unknown>;
};

const defaultEffects: MemorialEffects = {
  invalidateSession: async (userId, caller) =>
    (await import('~/server/auth/session-invalidation')).invalidateSession(userId, caller),
  expireUserApiKeys: async (userId) =>
    (await import('~/server/services/api-key.service')).expireUserApiKeys(userId),
  bustUserCreator: async (userId, opts) =>
    (await import('~/server/services/user-creator.service')).bustUserCreator(userId, opts),
};

export async function confirmMemorial(
  input: { userId: number; actorId: number },
  effects: MemorialEffects = defaultEffects
) {
  const updated = await dbWrite.$queryRaw<{ id: number; username: string | null }[]>`
    UPDATE "User"
    SET flags = flags | ${MEMORIAL} | ${EVENT_EXCLUSION},
        meta = meta || jsonb_build_object(
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
      AND jsonb_typeof(meta) = 'object'
      AND meta -> 'memorial' ->> 'status' = 'pending'
      AND (meta -> 'memorial' ->> 'proposedBy')::int <> ${input.actorId}::int
    RETURNING id, username
  `;
  if (!updated.length) {
    const target = await readTarget(input.userId);
    if (target.deletedAt) throw throwBadRequestError('This account is deleted.');
    if (target.memorial?.status === 'active')
      throw throwBadRequestError('This account is already memorialized.');
    if (target.memorial?.status !== 'pending')
      throw throwBadRequestError('There is no memorialization waiting for confirmation.');
    throw throwBadRequestError(
      'A different moderator from the one who proposed it must confirm a memorialization.'
    );
  }

  await afterMemorialChanged(input.userId, updated[0].username, effects);
  // The account change has committed; each step logs its own failure so one cannot skip the next.
  await effects
    .invalidateSession(input.userId, 'moderation')
    .catch((error) => logMemorialError('memorial-invalidate-session', input.userId, error));
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
  return {
    keysExpired: keys?.expired ?? null,
    orchestratorConfirmed: keys?.orchestratorConfirmed ?? false,
  };
}

/** Cancels a pending proposal or lifts an active memorialization. Sessions are not restored. */
export async function reverseMemorial(
  input: { userId: number },
  effects: MemorialEffects = defaultEffects
) {
  const meta = asJsonbObjectSql('meta');
  const updated = await dbWrite.$queryRaw<{ id: number; username: string | null }[]>`
    UPDATE "User"
    SET flags = flags & ~${MEMORIAL}::int & ~(
          CASE WHEN (${meta} -> 'memorial' ->> 'setEventExclusion')::boolean
            THEN ${EVENT_EXCLUSION}::int ELSE 0 END
        ),
        meta = ${meta} - 'memorial'
    WHERE id = ${input.userId}
      AND ((${meta} ? 'memorial') OR (flags & ${MEMORIAL}) <> 0)
    RETURNING id, username
  `;
  if (!updated.length) {
    await readTarget(input.userId);
    throw throwBadRequestError('This account is not memorialized.');
  }
  await afterMemorialChanged(input.userId, updated[0].username, effects);
}

async function afterMemorialChanged(
  userId: number,
  username: string | null,
  effects: MemorialEffects
) {
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

/** For a caller holding the row: refuses a memorialized account. */
export function assertNotMemorialized(user: { flags: number }) {
  if (isMemorialized(user.flags)) throw new MemorializedAccountError();
}

/** The recipients that are memorialized, so a new chat can drop them. */
export async function memorializedAmong(userIds: number[]): Promise<Set<number>> {
  if (!userIds.length) return new Set();
  const rows = await dbWrite.$queryRaw<{ id: number }[]>`
    SELECT id FROM "User" WHERE id = ANY(${userIds}::int[]) AND (flags & ${MEMORIAL}) <> 0
  `;
  return new Set(rows.map((row) => row.id));
}
