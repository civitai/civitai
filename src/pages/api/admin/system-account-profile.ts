import type { AxiomAPIRequest } from '@civitai/next-axiom';
import type { NextApiResponse } from 'next';
import * as z from 'zod';
import { MODERATION_ACCOUNT_USERNAME } from '@civitai/auth';
import { resemblesReservedModerationUsername } from '~/server/auth/moderation-account';
import {
  systemAccountRefusal,
  systemAccountSelect,
} from '~/server/auth/system-account-eligibility';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { chatDmPolicy } from '~/server/schema/chat.schema';
import { foldConfusables } from '~/server/utils/confusable-fold';
import { displayName } from '~/server/schema/moderator/user';
import { trackModActivity } from '~/server/services/moderator.service';
import { forceUpdateUserIdentity, patchUserSettings } from '~/server/services/user.service';
import { HeaderTokenSecuredEndpoint } from '~/server/utils/endpoint-helpers';
import { distinctAdminToken } from '~/server/utils/admin-token';

/**
 * Sets a system account's display name and chat DM policy (see create-system-account). Fields that
 * already hold the requested value are left alone; a call that changes nothing writes nothing.
 */

const SYSTEM_ACTOR_ID = -1;

const RESERVED_NAME = MODERATION_ACCOUNT_USERNAME.toLowerCase();

// A character that isn't a letter as typed may stand in for a letter of the reserved name or be skipped,
// even when folding turns it into letters, so padding and lookalike glyphs can't shift the match. Up to
// half the letters may be stood in for, so a name of only digits or symbols isn't refused.
// shortcut: an inserted or doubled plain letter (rn for m) still passes.
function masksReservedName(value: string) {
  const tokens = Array.from(value).flatMap((char) => {
    const folded = foldConfusables(char).replace(/[1l]/g, 'i');
    if (!/\p{L}/u.test(char)) return [{ text: folded, letter: false }];
    return Array.from(folded, (text) => ({ text, letter: /[a-z]/.test(text) }));
  });
  const n = RESERVED_NAME.length;
  // fewest stand-ins needed to have matched the first j reserved letters so far
  let best: number[] = [0, ...Array<number>(n).fill(Infinity)];
  for (const { text, letter } of tokens) {
    const next = Array<number>(n + 1).fill(Infinity);
    for (let j = 0; j <= n; j++) {
      if (best[j] === Infinity) continue;
      if (!letter) next[j] = Math.min(next[j], best[j]);
      if (j === n) continue;
      if (text === RESERVED_NAME[j]) next[j + 1] = Math.min(next[j + 1], best[j]);
      else if (!letter) next[j + 1] = Math.min(next[j + 1], best[j] + 1);
    }
    best = next;
  }
  return best[n] <= Math.floor(n / 2);
}

const schema = z
  .object({
    userId: z.coerce.number().int().positive(),
    name: displayName
      .min(1)
      .refine(
        // Variation selectors are exempt: emoji need them.
        (value) =>
          !/[\p{Cc}\p{Cf}]|(?![\uFE00-\uFE0F\u{E0100}-\u{E01EF}])\p{Default_Ignorable_Code_Point}/u.test(
            value
          ),
        'name may not hold control, format or invisible characters'
      )
      .refine(
        (value) =>
          !resemblesReservedModerationUsername(
            value.normalize('NFKC').replace(/[^\p{L}\p{N}|!]/gu, '')
          ) && !masksReservedName(value),
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

export default HeaderTokenSecuredEndpoint(
  () => distinctAdminToken('SYSTEM_ACCOUNT_PROFILE_TOKEN'),
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

    const auditRecorded = await trackModActivity(SYSTEM_ACTOR_ID, {
      entityType: 'user',
      activity: 'setSystemAccountProfile',
      entityId: userId,
    })
      .then(() => true)
      .catch(() => false);
    // 'error' when no audit row was written: then this line is the only record of the change.
    logToAxiom({
      type: failed || !auditRecorded ? 'error' : 'info',
      name: failed ? 'system-account-profile-set-failed' : 'system-account-profile-set',
      details: { userId, changed, failed, asserted_actor: actorUserId, auditRecorded },
    }).catch(() => null);

    if (failed)
      return res.status(500).json({ userId, changed, failed: failed.fields, auditRecorded });
    return res.status(200).json({ userId, changed, auditRecorded });
  }
);
