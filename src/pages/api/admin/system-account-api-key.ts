import type { AxiomAPIRequest } from '@civitai/next-axiom';
import type { NextApiResponse } from 'next';
import * as z from 'zod';
import { isModerationAccountUser, isSystemAccountMeta } from '@civitai/auth';
import { TokenScope, TokenScopePresets } from '@civitai/auth/token-scope';
import { env } from '~/env/server';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { addApiKey, deleteApiKeys } from '~/server/services/api-key.service';
import { trackModActivity } from '~/server/services/moderator.service';
import { HeaderTokenSecuredEndpoint } from '~/server/utils/endpoint-helpers';
import { generateKey, generateSecretHash } from '~/server/utils/key-generator';

/**
 * Issues an API key for a system account (see create-system-account). The key is returned once, in
 * this response, and never again; a second call with the same name replaces it.
 */

const SYSTEM_ACTOR_ID = -1;
const MAX_EXPIRY_DAYS = 365;

const READ_SCOPES = Object.fromEntries(
  Object.entries(TokenScope).filter(
    ([, bit]) => bit !== 0 && (TokenScopePresets.ReadOnly & bit) === bit
  )
) as Record<string, number>;

const DEFAULT_SCOPE = TokenScope.UserRead | TokenScope.ModelsRead | TokenScope.MediaRead;

const schema = z.object({
  userId: z.coerce.number().int().positive(),
  name: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[\w.-]+$/)
    .default('system'),
  scopes: z
    .array(z.string())
    .min(1)
    .refine((names) => names.every((name) => Object.hasOwn(READ_SCOPES, name)), {
      message: `scopes must be read scopes: ${Object.keys(READ_SCOPES).join(', ')}`,
    })
    .optional(),
  expiresInDays: z.coerce
    .number()
    .int()
    .positive()
    .max(MAX_EXPIRY_DAYS, { message: `expiresInDays may be at most ${MAX_EXPIRY_DAYS}` })
    .default(MAX_EXPIRY_DAYS),
  actorUserId: z.preprocess(
    (v) => (v === null || v === '' ? undefined : v),
    z.coerce.number().int().positive().optional()
  ),
});

async function refusal(userId: number): Promise<{ status: number; error: string } | null> {
  const user = await dbWrite.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      username: true,
      meta: true,
      deletedAt: true,
      bannedAt: true,
      isModerator: true,
      roles: { select: { role: true } },
    },
  });
  if (!user) return { status: 404, error: 'User not found' };
  if (!isSystemAccountMeta(user.meta)) return { status: 403, error: 'Not a system account' };
  if (user.deletedAt || user.bannedAt) return { status: 403, error: 'Account is not active' };
  if (isModerationAccountUser(user, env.CIVITAI_MODERATION_USER_ID) || user.isModerator)
    return { status: 403, error: 'Account has moderator access' };

  const roles = user.roles.map(({ role }) => role);
  if (roles.includes('moderator:admin'))
    return { status: 403, error: 'Account has moderator access' };
  if (roles.length) {
    const held = await dbWrite.appPageAccess.findFirst({
      where: { app: 'moderator', roles: { hasSome: roles } },
      select: { path: true },
    });
    if (held) return { status: 403, error: 'Account has moderator access' };
  }
  return null;
}

export default HeaderTokenSecuredEndpoint(
  () => env.SYSTEM_ACCOUNT_KEY_TOKEN,
  async function (req: AxiomAPIRequest, res: NextApiResponse) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    res.setHeader('Cache-Control', 'no-store');

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const { userId, name, scopes, expiresInDays, actorUserId } = parsed.data;

    const refused = await refusal(userId);
    if (refused) return res.status(refused.status).json({ error: refused.error });

    const tokenScope = scopes
      ? scopes.reduce((mask, scope) => mask | READ_SCOPES[scope], 0)
      : DEFAULT_SCOPE;

    // Generated here so that a failure inside the insert can still be revoked by hash.
    const key = generateKey();
    const hash = generateSecretHash(key);
    const inserted = await addApiKey({
      userId,
      name,
      tokenScope,
      type: 'User',
      maxAge: expiresInDays * 24 * 60 * 60,
      key,
    }).then(
      () => null,
      (error: Error) => error
    );
    const minted =
      inserted ??
      (await dbWrite.apiKey
        .findUniqueOrThrow({ where: { key: hash }, select: { id: true, expiresAt: true } })
        .catch((error: Error) => error));

    // The key is live from the insert on, whether or not this request returns it.
    const keyId = minted instanceof Error ? null : minted.id;
    logToAxiom(
      {
        type: 'error',
        name: 'system-account-api-key-minted',
        details: { userId, keyId, name, tokenScope, asserted_actor: actorUserId ?? null },
      },
      'moderation'
    ).catch(() => null);
    const auditRecorded = await trackModActivity(SYSTEM_ACTOR_ID, {
      entityType: 'user',
      activity: 'mintSystemAccountApiKey',
      entityId: userId,
    })
      .then(() => true)
      .catch(() => false);

    // Never throws. The outcome is read from the table rather than from deleteApiKeys' result.
    const revoke = async (reason: string) => {
      await deleteApiKeys({ key: hash }).catch(() => null);
      const remaining = await dbWrite.apiKey.count({ where: { key: hash } }).catch(() => null);
      const outcome =
        remaining !== 0 ? 'revoke-failed' : inserted ? 'revoke-unconfirmed' : 'revoked';
      logToAxiom(
        {
          type: 'error',
          name: `system-account-api-key-${outcome}`,
          details: { userId, keyId, name, reason },
        },
        'moderation'
      ).catch(() => null);
    };

    try {
      if (minted instanceof Error) throw minted;

      // Again after the insert: access granted between the first check and the insert is seen here.
      const late = await refusal(userId);
      if (late) {
        await revoke(late.error);
        return res.status(late.status).json({ error: late.error });
      }
    } catch (error) {
      await revoke('failed after insert');
      throw new Error(`System account key issue failed (${(error as Error).name})`);
    }

    // Older keys only, so of two concurrent mints the later one keeps its key.
    const rotated = await deleteApiKeys({ userId, name, type: 'User', id: { lt: minted.id } }).then(
      ({ count }) => count,
      () => {
        logToAxiom(
          {
            type: 'error',
            name: 'system-account-api-key-rotation-failed',
            details: { userId, keyId, name },
          },
          'moderation'
        ).catch(() => null);
        return null;
      }
    );

    return res.status(201).json({
      userId,
      keyId: minted.id,
      name,
      tokenScope,
      expiresAt: minted.expiresAt,
      rotated,
      auditRecorded,
      key,
    });
  }
);
