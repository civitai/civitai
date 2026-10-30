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
  resolver: async ({ ctx }) => {
    // 🔴 ONE HOP, not two. Resolving the block's listing here sends the legacy deep-link
    // straight to the CANONICAL listing-keyed page rather than bouncing it through
    // `/apps/<appBlockId>/edit` (which now redirects as well). A block with no listing
    // yet — a first-version app pending approval — has no canonical URL, so
    // `legacyEditRedirect` falls back to the block-keyed page exactly as before.
    const raw = ctx.params?.appBlockId;
    const appBlockId = Array.isArray(raw) ? raw[0] : raw;
    if (!appBlockId) return legacyEditRedirect(raw, 'manifest');
    const { listingIdForAppBlock } = await import('~/server/services/blocks/app-access.service');
    return legacyEditRedirect(raw, 'manifest', await listingIdForAppBlock(appBlockId));
  },
});

// The redirect always fires in getServerSideProps; this default export exists only
// to satisfy Next's page contract and is never rendered.
export default function EditManifestRedirect() {
  return <NotFound />;
}
