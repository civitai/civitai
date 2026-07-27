import { NotFound } from '~/components/AppLayout/NotFound';
import { legacyEditRedirect } from '~/components/Apps/listingEditNav';
import { createServerSideProps } from '~/server/utils/server-side-helpers';

/**
 * LEGACY route — the standalone listing-media editor moved into the unified tabbed
 * `/apps/<appBlockId>/edit` page (the "Listing media" tab). This route now
 * `getServerSideProps`-redirects to `/apps/<appBlockId>/edit?tab=media` so existing
 * deep-links / bookmarks keep working. The media editor body itself now lives in the
 * reusable `ListingMediaEditor` component. (Owner-gating + the flag check happen on
 * the `/edit` target.)
 */
export const getServerSideProps = createServerSideProps({
  resolver: async ({ ctx }) => legacyEditRedirect(ctx.params?.appBlockId, 'media'),
});

// The redirect always fires in getServerSideProps; this default export exists only
// to satisfy Next's page contract and is never rendered.
export default function ListingMediaRedirect() {
  return <NotFound />;
}
