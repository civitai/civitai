/**
 * Debug endpoint for chat themes.
 * =============================================================================
 * Chat themes are `ChatTheme` cosmetics granted by membership. Until the tier
 * mapping exists (868kk3t0t), this is how you put one on an account to look at
 * it. Every action is scoped to a single userId.
 *
 * POST /api/testing/chat-themes?token=$WEBHOOK_TOKEN
 *
 *   { "action": "list" }
 *     Every ChatTheme cosmetic and its slug.
 *
 *   { "action": "grant", "userId": 1, "slug": "citron" }
 *     Grants that theme to the user. Idempotent.
 *
 *   { "action": "revoke", "userId": 1, "slug": "citron" }
 *     Removes the grant. The window falls back to the default on next render.
 *
 *   { "action": "dump", "userId": 1 }
 *     What the user owns, and which theme they have selected.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { dbRead, dbWrite } from '~/server/db/client';
import { getUserSettings } from '~/server/services/user.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { chatThemeSlugs } from '~/shared/constants/chat-theme';

const schema = z.object({
  action: z.enum(['list', 'grant', 'revoke', 'dump']),
  userId: z.coerce.number().optional(),
  slug: z.enum(chatThemeSlugs).optional(),
});

export default WebhookEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  const payload = schema.safeParse({ ...req.query, ...(req.body ?? {}) });
  if (!payload.success) {
    return res.status(400).json({ error: 'Invalid request', issues: payload.error.issues });
  }
  const { action, userId, slug } = payload.data;

  const cosmetics = await dbRead.cosmetic.findMany({
    where: { type: 'ChatTheme' },
    select: { id: true, name: true, data: true },
  });
  const findBySlug = (want: string) =>
    cosmetics.find((c) => (c.data as { slug?: string } | null)?.slug === want);

  if (action === 'list') return res.status(200).json({ cosmetics });

  if (!userId) return res.status(400).json({ error: 'userId is required' });

  if (action === 'dump') {
    const [owned, settings] = await Promise.all([
      dbRead.userCosmetic.findMany({
        where: { userId, cosmetic: { type: 'ChatTheme' } },
        select: {
          cosmeticId: true,
          obtainedAt: true,
          cosmetic: { select: { name: true, data: true } },
        },
      }),
      getUserSettings(userId),
    ]);
    return res.status(200).json({ owned, selected: settings.chat?.theme ?? null });
  }

  if (!slug) return res.status(400).json({ error: 'slug is required' });
  const cosmetic = findBySlug(slug);
  if (!cosmetic) {
    return res
      .status(404)
      .json({ error: `No ChatTheme cosmetic with slug "${slug}" — run the seed migration` });
  }

  if (action === 'grant') {
    await dbWrite.userCosmetic.upsert({
      where: {
        userId_cosmeticId_claimKey: { userId, cosmeticId: cosmetic.id, claimKey: 'claimed' },
      },
      create: { userId, cosmeticId: cosmetic.id, claimKey: 'claimed' },
      update: {},
    });
    return res.status(200).json({ granted: { userId, slug, cosmeticId: cosmetic.id } });
  }

  const { count } = await dbWrite.userCosmetic.deleteMany({
    where: { userId, cosmeticId: cosmetic.id },
  });
  return res.status(200).json({ revoked: { userId, slug, count } });
});
