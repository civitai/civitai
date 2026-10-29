import type { AxiomAPIRequest } from '@civitai/next-axiom';
import type { NextApiResponse } from 'next';
import * as z from 'zod';
import { isSystemAccountMeta } from '@civitai/auth';
import { env } from '~/env/server';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { chatDmPolicy } from '~/server/schema/chat.schema';
import { displayName } from '~/server/schema/moderator/user';
import { trackModActivity } from '~/server/services/moderator.service';
import { forceUpdateUserIdentity, patchUserSettings } from '~/server/services/user.service';
import { HeaderTokenSecuredEndpoint } from '~/server/utils/endpoint-helpers';

/**
 * Sets a system account's display name and chat DM policy (see create-system-account). Fields that
 * already hold the requested value are left alone; a call that changes nothing writes nothing.
 */

const SYSTEM_ACTOR_ID = -1;

const schema = z
  .object({
    userId: z.coerce.number().int().positive(),
    name: displayName.optional(),
    settings: z
      .object({ chat: z.object({ dmPolicy: chatDmPolicy }).strict() })
      .strict()
      .optional(),
    actorUserId: z.preprocess(
      (v) => (v === null || v === '' ? undefined : v),
      z.coerce.number().int().positive()
    ),
  })
  .strict();

const asObject = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export default HeaderTokenSecuredEndpoint(
  () => env.SYSTEM_ACCOUNT_PROFILE_TOKEN,
  async function (req: AxiomAPIRequest, res: NextApiResponse) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    res.setHeader('Cache-Control', 'no-store');

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const { userId, name, settings, actorUserId } = parsed.data;
    const dmPolicy = settings?.chat.dmPolicy;
    if (name === undefined && dmPolicy === undefined)
      return res.status(400).json({ error: 'Send name or settings.chat.dmPolicy' });

    const user = await dbWrite.user.findUnique({
      where: { id: userId },
      select: { id: true, meta: true, deletedAt: true, bannedAt: true, name: true, settings: true },
    });
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!isSystemAccountMeta(user.meta))
      return res.status(403).json({ error: 'Not a system account' });
    if (user.deletedAt || user.bannedAt)
      return res.status(403).json({ error: 'Account is not active' });

    const changed: string[] = [];
    if (name !== undefined && name !== user.name) {
      await forceUpdateUserIdentity({ userId, name });
      changed.push('name');
    }
    if (dmPolicy !== undefined && asObject(asObject(user.settings).chat).dmPolicy !== dmPolicy) {
      await patchUserSettings(userId, {
        mergeInto: { chat: { dmPolicy } },
        location: 'admin/system-account-profile',
      });
      changed.push('settings.chat.dmPolicy');
    }
    if (!changed.length) return res.status(200).json({ userId, changed, auditRecorded: false });

    logToAxiom(
      {
        type: 'error',
        name: 'system-account-profile-set',
        details: { userId, changed, asserted_actor: actorUserId },
      },
      'moderation'
    ).catch(() => null);
    const auditRecorded = await trackModActivity(SYSTEM_ACTOR_ID, {
      entityType: 'user',
      activity: 'setSystemAccountProfile',
      entityId: userId,
    })
      .then(() => true)
      .catch(() => false);

    return res.status(200).json({ userId, changed, auditRecorded });
  }
);
