import { env } from '~/env/client';
import { ModelStatus } from '~/shared/utils/prisma/enums';

/**
 * Cloudflare keeps an /api/og card for 7 days and Discord caches it by URL, so a card only
 * refreshes when its URL changes. Bump this with any change to the rendered card (layout, the
 * data drawn, which cover is picked), and only then: a bump makes every card URL cold at once.
 */
export const OG_CARD_VERSION = 2;

/** `v` goes last so one card keeps one CDN key. */
export function ogImageUrl(ogEndpoint: string) {
  return `${env.NEXT_PUBLIC_BASE_URL}${ogEndpoint}&v=${OG_CARD_VERSION}`;
}

/**
 * /api/og draws a model's cover from its first published version, so publishing a newer one
 * makes a new card. `modelVersions` must be in `index` order, as the model selector returns them.
 */
export function modelOgEndpoint(model: {
  id: number;
  modelVersions: { id: number; status: ModelStatus }[];
  updatedAt?: Date | string | null;
}) {
  const version = model.modelVersions.find((v) => v.status === ModelStatus.Published);
  // Saving the .com face or a cover changes what the card draws, and bumps `updatedAt`.
  const edited = model.updatedAt ? `&u=${new Date(model.updatedAt).getTime()}` : '';
  return `/api/og?type=model&id=${model.id}${version ? `&mv=${version.id}` : ''}${edited}`;
}
