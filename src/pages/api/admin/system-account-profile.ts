import type { AxiomAPIRequest } from '@civitai/next-axiom';
import type { NextApiResponse } from 'next';
import * as z from 'zod';
import { env } from '~/env/server';
import { isReservedModerationUsername } from '~/server/auth/moderation-account';
import {
  systemAccountRefusal,
  systemAccountSelect,
} from '~/server/auth/system-account-eligibility';
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
    name: displayName
      .min(1)
      .refine(
        (value) => !/[\p{Cc}\p{Cf}]/u.test(value),
        'name may not hold control or format characters'
      )
      .refine(
        (value) => !isReservedModerationUsername(value.replace(/[^\p{L}\p{N}]/gu, '')),
        'name is reserved'
      )
      .optional(),
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

// Unconfigured while it repeats another admin token.
function profileToken() {
  const token = env.SYSTEM_ACCOUNT_PROFILE_TOKEN;
  return token && [env.SYSTEM_ACCOUNT_KEY_TOKEN, env.WEBHOOK_TOKEN, env.JOB_TOKEN].includes(token)
    ? undefined
    : token;
}

export default HeaderTokenSecuredEndpoint(
  profileToken,
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
      select: { ...systemAccountSelect, name: true, settings: true },
    });
    const refused = await systemAccountRefusal(user);
    if (refused || !user) return res.status(refused?.status ?? 404).json({ error: refused?.error });

    const writes: [fields: string[], write: () => Promise<unknown>][] = [];
    if (name !== undefined && name !== user.name)
      writes.push([['name'], () => forceUpdateUserIdentity({ userId, name })]);
    if (dmPolicy !== undefined) {
      const stored = asObject(user.settings);
      // `features.chat === false` reads as `nobody` (resolveDmPolicy), as in chat.controller.
      const reopenChat = dmPolicy !== 'nobody' && asObject(stored.features).chat === false;
      if (reopenChat || asObject(stored.chat).dmPolicy !== dmPolicy)
        writes.push([
          reopenChat
            ? ['settings.chat.dmPolicy', 'settings.features.chat']
            : ['settings.chat.dmPolicy'],
          () =>
            patchUserSettings(userId, {
              mergeInto: {
                chat: { dmPolicy },
                ...(reopenChat ? { features: { chat: true } } : {}),
              },
              location: 'admin/system-account-profile',
            }),
        ]);
    }
    if (!writes.length) return res.status(200).json({ userId, changed: [], auditRecorded: false });

    // A failed write may still have committed, so it is audited with the ones that succeeded.
    const changed: string[] = [];
    let failed: { fields: string[]; error: string } | undefined;
    for (const [fields, write] of writes) {
      try {
        await write();
        changed.push(...fields);
      } catch (error) {
        failed = { fields, error: (error as Error).name };
        break;
      }
    }

    logToAxiom(
      {
        type: 'error',
        name: failed ? 'system-account-profile-set-failed' : 'system-account-profile-set',
        details: { userId, changed, failed, asserted_actor: actorUserId },
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

    if (failed)
      return res.status(500).json({ userId, changed, failed: failed.fields, auditRecorded });
    return res.status(200).json({ userId, changed, auditRecorded });
  }
);
