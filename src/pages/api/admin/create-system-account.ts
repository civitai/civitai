import type { AxiomAPIRequest } from '@civitai/next-axiom';
import type { NextApiResponse } from 'next';
import * as z from 'zod';
import { OnboardingComplete } from '~/server/common/enums';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { usernameInputSchema } from '~/server/schema/user.schema';
import { trackModActivity } from '~/server/services/moderator.service';
import { isUsernamePermitted } from '~/server/services/username-permitted';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { isPrismaUniqueViolation } from '~/server/utils/errorHandling';

/**
 * Creates an account for an internal system user (e.g. a review agent) from an email, with no
 * sign-up flow. The row mirrors what the auth hub inserts for a new sign-in, minus everything a
 * real person gets on first login and onboarding: no Buzz bonus, referral, notification or
 * registration event. Roles and API keys are granted separately.
 *
 * Idempotent: the same email + username returns the existing account with `created: false`.
 */

const SYSTEM_ACCOUNT_EMAIL_DOMAIN = 'civitai.com';
const SYSTEM_ACTOR_ID = -1;

const schema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email()
    .refine((email) => email.split('@')[1] === SYSTEM_ACCOUNT_EMAIL_DOMAIN, {
      message: `email must be on ${SYSTEM_ACCOUNT_EMAIL_DOMAIN}`,
    }),
  username: usernameInputSchema,
  actorUserId: z.preprocess(
    (v) => (v === null || v === '' ? undefined : v),
    z.coerce.number().int().positive().optional()
  ),
});

type Resolution =
  | { kind: 'existing'; userId: number; username: string }
  | { kind: 'conflict'; error: string }
  | { kind: 'available' };

async function resolve(email: string, username: string): Promise<Resolution> {
  const select = { id: true, username: true, deletedAt: true } as const;
  const [byEmail, byUsername] = await Promise.all([
    dbWrite.user.findUnique({ where: { email }, select }),
    dbWrite.user.findUnique({ where: { username }, select }),
  ]);

  if (byEmail) {
    if (!byEmail.deletedAt && byEmail.username?.toLowerCase() === username.toLowerCase())
      return { kind: 'existing', userId: byEmail.id, username: byEmail.username };
    return { kind: 'conflict', error: 'Email belongs to another account' };
  }
  if (byUsername) return { kind: 'conflict', error: 'Username is taken' };
  return { kind: 'available' };
}

export default WebhookEndpoint(async function (req: AxiomAPIRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { email, username, actorUserId } = parsed.data;

  const respond = (resolution: Exclude<Resolution, { kind: 'available' }>) =>
    resolution.kind === 'existing'
      ? res
          .status(200)
          .json({ userId: resolution.userId, username: resolution.username, created: false })
      : res.status(409).json({ error: resolution.error });

  const existing = await resolve(email, username);
  if (existing.kind !== 'available') return respond(existing);

  if (!(await isUsernamePermitted(username)))
    return res.status(400).json({ error: 'Username is not permitted' });

  let userId: number;
  try {
    const user = await dbWrite.user.create({
      data: {
        email,
        emailVerified: new Date(),
        username,
        // Marks onboarding done without running it: the Buzz bonus is granted only by the
        // onboarding handler, and an incomplete account would be refused by the onboarded gate.
        onboarding: OnboardingComplete,
        excludeFromLeaderboards: true,
        rewardsEligibility: 'Ineligible',
        meta: { systemAccount: true },
      },
      select: { id: true },
    });
    userId = user.id;
  } catch (e) {
    if (!isPrismaUniqueViolation(e)) throw e;
    const raced = await resolve(email, username);
    return respond(
      raced.kind === 'available' ? { kind: 'conflict', error: 'Email or username is taken' } : raced
    );
  }

  const actor = actorUserId ?? SYSTEM_ACTOR_ID;
  logToAxiom(
    {
      type: 'info',
      name: 'system-account-created',
      details: { userId, username, emailDomain: SYSTEM_ACCOUNT_EMAIL_DOMAIN, actorUserId: actor },
    },
    'moderation'
  ).catch(() => null);
  const auditRecorded = await trackModActivity(actor, {
    entityType: 'user',
    activity: 'createSystemAccount',
    entityId: userId,
  })
    .then(() => true)
    .catch(() => false);

  return res.status(201).json({ userId, username, created: true, auditRecorded });
});
