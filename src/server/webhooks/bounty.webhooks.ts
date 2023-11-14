import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { getBountyDetailsSelect } from '~/server/selectors/bounty.selector';
import { getBaseUrl } from '~/server/utils/url-helpers';
import { createWebhookProcessor } from '~/server/webhooks/base.webhooks';
import { isDefined } from '~/utils/type-guards';

const baseUrl = getBaseUrl();
export const bountyWebhooks = createWebhookProcessor({
  'new-bounty': {
    displayName: 'New Bounties',
    getData: async ({ lastSent, prisma }) => {
      const now = new Date();
      const bounties = await prisma.bounty.findMany({
        where: {
          startsAt: {
            gt: lastSent,
            lte: now,
          },
        },
        select: getBountyDetailsSelect,
      });
      if (!bounties.length) return [];

      const coverImages = await prisma.imageConnection.findMany({
        where: {
          entityType: 'bounty',
          entityId: { in: bounties.map((b) => b.id) },
        },
        select: { image: { select: { url: true, nsfw: true, index: true } }, entityId: true },
      });

      return bounties
        .map(({ user, tags: allTags, ...bounty }) => {
          const tags = allTags.map((t) => t.tag.name);
          const cover = coverImages
            .filter((x) => x.entityId === bounty.id)
            ?.sort((a, b) => (a.image.index ?? 0) - (b.image.index ?? 0))?.[0]?.image?.url;
          if (!user) return null;

          return {
            ...bounty,
            tags,
            cover: cover ? getEdgeUrl(cover, { width: 450 }) : null,
            creator: {
              username: user.username,
              image: user.image ? getEdgeUrl(user.image, { width: 96 }) : null,
            },
            link: `${baseUrl}/bounties/${bounty.id}`,
          };
        })
        .filter(isDefined);
    },
  },
});
