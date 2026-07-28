import { NotFound } from '~/components/AppLayout/NotFound';
import { legacyEditRedirect } from '~/components/Apps/listingEditNav';
import { createServerSideProps } from '~/server/utils/server-side-helpers';

/**
 * LEGACY route — the standalone manifest editor moved into the unified tabbed
 * `/apps/<appBlockId>/edit` page. This route now `getServerSideProps`-redirects to
 * `/apps/<appBlockId>/edit?tab=manifest` so existing deep-links / bookmarks keep
 * working. (Owner-gating + the flag check happen on the `/edit` target.)
 */
export const getServerSideProps = createServerSideProps({
  resolver: async ({ ctx }) => legacyEditRedirect(ctx.params?.appBlockId, 'manifest'),
});

// The redirect always fires in getServerSideProps; this default export exists only
// to satisfy Next's page contract and is never rendered.
export default function EditManifestRedirect() {
  return <NotFound />;
}
