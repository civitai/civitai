import type { SessionUser } from '~/types/session';
import type { ListingSocialImage } from '~/server/services/blocks/listing-media-audience';
import { isRedCapableHost } from '~/server/utils/server-domain';

/**
 * The `og:image` a listing detail page renders server-side, for the page's SSR resolver.
 *
 * Only a full server render needs one: a client-side navigation (`isClient`) never reaches an
 * unfurler, so it costs no read. The image itself is `getListingSocialImage` — the detail read's
 * own gates under this request's store scope, then the anonymous ceiling of this host — so a
 * listing this request may not open yields none, and no host ever gets a mature image.
 *
 * A failure is "no image", never an error page: a social preview is cosmetic.
 */
export async function resolveListingPageSocialImage(args: {
  slug: string | null | undefined;
  host: string | null | undefined;
  user: SessionUser | null | undefined;
  isClient: boolean;
}): Promise<ListingSocialImage | null> {
  if (args.isClient || !args.slug) return null;
  try {
    const [{ resolveStoreVisibilityScope }, { getListingSocialImage }] = await Promise.all([
      import('~/server/services/app-blocks-flag'),
      import('~/server/services/blocks/app-listing.service'),
    ]);
    const scope = await resolveStoreVisibilityScope({ user: args.user ?? undefined });
    if (scope === 'none') return null;
    return await getListingSocialImage(
      { slug: args.slug },
      { redCapable: isRedCapableHost(args.host), scope, floor: 'public' }
    );
  } catch {
    return null;
  }
}
